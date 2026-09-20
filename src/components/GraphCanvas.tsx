import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  forceCenter,
  forceCollide,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'
import {
  forceCenter as forceCenter3D,
  forceCollide as forceCollide3D,
  forceManyBody as forceManyBody3D,
  forceSimulation as forceSimulation3D,
} from 'd3-force-3d'
import { articleDegree, selectHubIds } from '../graph/hubs'
import { boundaryForce, boundaryRadius } from '../graph/boundary'
import { articleRepulsionScale } from '../graph/density'
import { roundSimulationNodesF32 } from '../graph/f32'
import { createGpuGraphSimulation, nextPhysicsTickDelay, type PhysicsController } from '../graph/gpuSimulation'
import { layoutSpacing, seedLayout, symmetricAttraction, unrelatedRepulsion, hubInteractions } from '../graph/layout'

export type GraphNode = SimulationNodeDatum & {
  id: string
  title?: string
  label?: string
  group?: string | number
  color?: string
  /** Third coordinate used by the 3D force layout. */
  z?: number
  /** Link degree is also used as a lightweight article-importance signal. */
  inDegree?: number
  outDegree?: number
  articleSize?: number
  byteLength?: number
  vz?: number
  fz?: number | null
}

export type GraphLink = {
  source: string | GraphNode
  target: string | GraphNode
}

export type GraphData = { nodes: GraphNode[]; links: GraphLink[] }

export type GraphCanvasMode = '2d' | '3d'

export type GraphCanvasHandle = {
  fit: () => void
  resetView: () => void
  /** Center an article in the current viewport without changing its zoom. */
  focusNode: (id: string) => void
}

export type GraphCanvasProps = {
  graph: GraphData
  /** Node ids to paint; omitted means every node is visible. The simulation always uses the full graph. */
  visibleNodeIds?: ReadonlySet<string>
  /** Called after the current graph has been painted to the canvas. */
  onGraphRendered?: (graph: GraphData) => void
  /** Called once for every completed force-simulation tick. */
  onPhysicsTick?: () => void
  selectedId?: string | null
  onSelect?: (node: GraphNode) => void
  onHover?: (node: GraphNode | null) => void
  onSimulationGuard?: () => void
  paused?: boolean
  className?: string
  /** Optional node color resolver, useful when groups are domain-specific. */
  getNodeColor?: (node: GraphNode) => string
  /** Live-tunable force-layout parameters. */
  settings?: GraphSimulationSettings
  /** Switch between the standard top-down map and the orbiting depth view. */
  mode?: GraphCanvasMode
  /** Whether article names should be painted next to graph nodes. */
  showLabels?: boolean
}

export type GraphSimulationSettings = {
  baseCharge: number
  articleImportanceCharge: number
  hubCharge: number
  chargeDistance: number
  articleSizeWeight: number
  articleMaxBytes: number
  articleDegreeCap: number
  hubDegreeReference: number
  unrelatedBaseStrength: number
  unrelatedHubStrength: number
  unrelatedDistance: number
  unrelatedInteractionBudget: number
  hubTerritoryBase: number
  hubTerritoryScale: number
  hubForceBase: number
  hubForceScale: number
  hubForceMax: number
  linkDistanceScale: number
  /** Exponent used by the link spring: squared by default, optionally cubic. */
  linkDistanceExponent: 2 | 3
  linkWeightFloor: number
  collisionPadding: number
  collisionIterations: number
  centerStrength: number
  velocityDecay: number
  /** Starting force temperature. D3 calls this the simulation alpha. */
  initialTemperature: number
  alphaDecay: number
  alphaMin: number
  alphaTarget: number
}

export const DEFAULT_SIMULATION_SETTINGS: GraphSimulationSettings = {
  baseCharge: 115,
  articleImportanceCharge: 126,
  // Additional hub-to-hub repulsion; linked articles do not receive it.
  hubCharge: 1_500,
  chargeDistance: 480,
  articleSizeWeight: 0.45,
  articleMaxBytes: 2_000_000,
  articleDegreeCap: 56,
  hubDegreeReference: 60,
  unrelatedBaseStrength: 40,
  unrelatedHubStrength: 600,
  unrelatedDistance: 480,
  unrelatedInteractionBudget: 220_000,
  hubTerritoryBase: 420,
  hubTerritoryScale: 360,
  hubForceBase: 24,
  hubForceScale: 700,
  hubForceMax: 140,
  linkDistanceScale: 150_000,
  linkDistanceExponent: 3,
  linkWeightFloor: 0.02,
  collisionPadding: 18,
  collisionIterations: 2,
  centerStrength: 0.035,
  velocityDecay: 0.4,
  // Give the layout enough heat to cross shallow barriers, then let alpha
  // decay to alphaMin so it can settle instead of running hot forever.
  initialTemperature: 0.8,
  alphaDecay: 0.01,
  alphaMin: 0.001,
  alphaTarget: 0,
}

type Point = { x: number; y: number }
type View = { x: number; y: number; scale: number }
type Bounds = { minX: number; maxX: number; minY: number; maxY: number }
type Orbit = { yaw: number; pitch: number }
type LayoutGraph = { nodes: GraphNode[]; links: GraphLink[] }
type LayoutCache = { graph: GraphData | null; twoD: LayoutGraph | null; threeD: LayoutGraph | null }
type RenderLink = { edge: GraphLink; index: number }
type RenderSubset = { graph: LayoutGraph; visibleIds: ReadonlySet<string> | null; nodes: GraphNode[]; links: RenderLink[] }

const articleBytes = (node: GraphNode) => {
  const value = node.articleSize ?? node.byteLength ?? 0
  return Number.isFinite(value) && value > 0 ? value : 0
}
const articleImportance = (node: GraphNode, settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS) => {
  const degree = Math.min(articleDegree(node), settings.articleDegreeCap)
  // Log scaling prevents unusually long articles from overwhelming the graph.
  const bytes = Math.min(Math.max(articleBytes(node), 0), settings.articleMaxBytes)
  const sizeWeight = Math.max(0, Math.min(1, settings.articleSizeWeight))
  return Math.min(1, Math.log1p(bytes) / Math.log1p(settings.articleMaxBytes)) * sizeWeight
    + Math.sqrt(degree / settings.articleDegreeCap) * (1 - sizeWeight)
}
// Degree is intentionally normalized separately from visual importance. A
// page can be a small article but still be a structural hub, and those hubs
// need to create a much stronger boundary around other structural hubs.
const HUB_SCORE_FLOOR = 0.8
const hubRepulsionScore = (
  node: GraphNode,
  hubIds: ReadonlySet<string>,
  settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS,
) => {
  const degree = articleDegree(node)
  if (!hubIds.has(node.id)) return 0
  // Membership is already based on the top 5%/100 ranking. Give every
  // selected hub a meaningful baseline so sparse graphs do not silently turn
  // their hubs back into ordinary nodes; degree still differentiates the
  // strongest hubs within that selected set.
  const degreeScore = Math.min(1, Math.log1p(degree) / Math.log1p(Math.max(1, settings.hubDegreeReference)))
  return HUB_SCORE_FLOOR + (1 - HUB_SCORE_FLOOR) * degreeScore
}
// More connected articles are physically larger, with a cap so hubs never
// swallow nearby nodes. Rendering applies a separate scale so the dots can be
// easier to read without changing the force-layout physics.
const nodeRadius = (node: GraphNode, settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS) => {
  return (node.id.length > 18 ? 5 : 6) + articleImportance(node, settings) * 6
}
// Keep the all-articles endpoint at the original physics radius. Sparse views
// add their own display-count boost below, so a complete graph never inherits
// an enlargement merely because it was fit to the viewport.
const BASE_VISUAL_NODE_SCALE = 1
// On a large graph the hub-only position is an intentional overview mode,
// not a request to magnify a tiny sample. Keep those hubs at the same normal
// size used by a fully rendered graph, then let that normalization decay very
// quickly as non-hubs enter the rendered set.
const HUB_ONLY_NORMALIZATION_THRESHOLD = 1_000
const visualNodeScale = (visibleCount: number, totalCount: number, zoomScale: number, hubCount = 0) => {
  if (totalCount <= 0) return BASE_VISUAL_NODE_SCALE
  const hiddenFraction = Math.max(0, Math.min(1, 1 - visibleCount / totalCount))
  // Use a logarithmic display-count curve so the first reductions are visible
  // without letting the hub-only end dominate the map.
  const logarithmicSparseBoost = Math.log1p(hiddenFraction * 9) / Math.log1p(9)
  // Fade that boost quickly as the rendered set progresses from hubs to the
  // complete graph. The normalization keeps both endpoints exact while the
  // exponential falloff makes the first added articles shrink the dots fast.
  const displayProgress = Math.max(0, Math.min(1, (visibleCount - hubCount) / Math.max(1, totalCount - hubCount)))
  const fadeRate = 8
  const exponentialSparseFade = (Math.exp(-fadeRate * displayProgress) - Math.exp(-fadeRate)) / (1 - Math.exp(-fadeRate))
  const hubOnlyDistance = Math.max(0, visibleCount - hubCount)
  const hubNormalizationDecay = Math.max(1, hubCount * 0.05)
  const hubNormalization = totalCount > HUB_ONLY_NORMALIZATION_THRESHOLD && hubCount > 0
    ? 1 - Math.exp(-hubOnlyDistance / hubNormalizationDecay)
    : 1
  const sparseVisualWeight = logarithmicSparseBoost * exponentialSparseFade * hubNormalization
  const enlargedScale = BASE_VISUAL_NODE_SCALE + sparseVisualWeight * 1.45
  // The sparse-map boost is for the overview. As the user zooms in, return
  // every dot to the same baseline radius used by a fully displayed graph.
  const zoomProgress = Math.max(0, Math.min(1, (zoomScale - 0.58) / (1.15 - 0.58)))
  const displayScale = BASE_VISUAL_NODE_SCALE + (enlargedScale - BASE_VISUAL_NODE_SCALE) * (1 - zoomProgress)
  // Fit views can make the world-space dots tiny. Add only a restrained paint
  // boost so labels stay readable without turning a complete graph into a wall
  // of oversized dots.
  const zoomOutProgress = Math.max(0, Math.min(1, (0.85 - zoomScale) / 0.65))
  const zoomOutCompensation = 1 + zoomOutProgress * 0.45 * sparseVisualWeight
  return displayScale * zoomOutCompensation
}
const visualNodeRadius = (
  node: GraphNode,
  settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS,
  scale = BASE_VISUAL_NODE_SCALE,
) => nodeRadius(node, settings) * scale
const LARGE_GRAPH_THRESHOLD = 2_000
const HUB_OUTLINE_COLOR = '#2f9e44'
const linkNode = (value: string | GraphNode, nodes: Map<string, GraphNode>) =>
  typeof value === 'string' ? nodes.get(value) : value

function createLayoutGraph(graph: GraphData): LayoutGraph {
  const nodes = graph.nodes.map((node) => {
    const copy = { ...node }
    delete copy.index
    delete copy.x
    delete copy.y
    delete copy.z
    delete copy.vx
    delete copy.vy
    delete copy.vz
    delete copy.fx
    delete copy.fy
    delete copy.fz
    return copy
  })
  const links = graph.links.map((link) => ({
    source: typeof link.source === 'string' ? link.source : link.source.id,
    target: typeof link.target === 'string' ? link.target : link.target.id,
  }))
  return { nodes, links }
}

function graphBounds(nodes: GraphNode[]): Bounds | null {
  let bounds: Bounds | null = null
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
    const x = node.x as number
    const y = node.y as number
    if (!bounds) bounds = { minX: x, maxX: x, minY: y, maxY: y }
    else {
      bounds.minX = Math.min(bounds.minX, x)
      bounds.maxX = Math.max(bounds.maxX, x)
      bounds.minY = Math.min(bounds.minY, y)
      bounds.maxY = Math.max(bounds.maxY, y)
    }
  }
  return bounds
}

function initialBoundaryView(width: number, height: number, count: number, mode: GraphCanvasMode): View {
  const radius = boundaryRadius(count, mode === '3d' ? 3 : 2) * (mode === '3d' ? 1.1 : 1)
  return { x: width / 2, y: height / 2, scale: Math.max(0.02, Math.min(2.2, 0.86 * Math.min(width, height) / (2 * radius + 80))) }
}

function boundedGraphBounds(nodes: GraphNode[], mode: GraphCanvasMode): Bounds {
  const radius = boundaryRadius(nodes.length, mode === '3d' ? 3 : 2) * (mode === '3d' ? 1.1 : 1)
  const bounds = graphBounds(nodes)
  return {
    minX: Math.min(-radius, bounds?.minX ?? 0), maxX: Math.max(radius, bounds?.maxX ?? 0),
    minY: Math.min(-radius, bounds?.minY ?? 0), maxY: Math.max(radius, bounds?.maxY ?? 0),
  }
}

/**
 * A responsive, canvas-rendered force graph. The active cached layout nodes are
 * mutated by d3-force (x/y/z/vx/vy/vz/fx/fy/fz), so callers should treat those
 * fields as simulation state.
 */
const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { graph, visibleNodeIds, mode = '2d', onGraphRendered, onPhysicsTick, selectedId, onSelect, onHover, onSimulationGuard, paused = false, className, getNodeColor, settings = DEFAULT_SIMULATION_SETTINGS, showLabels = true },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const simulationRef = useRef<PhysicsController | null>(null)
  const layoutCacheRef = useRef<LayoutCache>({ graph: null, twoD: null, threeD: null })
  const activeLayoutRef = useRef<LayoutGraph | null>(null)
  const activeGraphRef = useRef<GraphData | null>(null)
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 })
  const orbitRef = useRef<Orbit>({ yaw: -0.45, pitch: 0.24 })
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 })
  const hoverRef = useRef<GraphNode | null>(null)
  const dragRef = useRef<{ node: GraphNode; offset: Point } | null>(null)
  const panRef = useRef<{ x: number; y: number; start: Point } | null>(null)
  const rotateRef = useRef<{ start: Point; orbit: Orbit } | null>(null)
  const pressedNodeRef = useRef<GraphNode | null>(null)
  const pausedRef = useRef(paused)
  const showLabelsRef = useRef(showLabels)
  const viewInitializedRef = useRef(false)
  // Keep the simulation and resize observer independent from React render identity.
  const graphRef = useRef(graph)
  const selectedIdRef = useRef(selectedId)
  const modeRef = useRef<GraphCanvasMode>(mode)
  const colorResolverRef = useRef(getNodeColor)
  const simulationGuardRef = useRef(onSimulationGuard)
  const graphRenderedRef = useRef<GraphData | null>(null)
  const graphRenderedCallbackRef = useRef(onGraphRendered)
  const physicsTickCallbackRef = useRef(onPhysicsTick)
  const visibleNodeIdsRef = useRef<ReadonlySet<string> | null>(visibleNodeIds ?? null)
  const settingsRef = useRef(settings)
  const drawRef = useRef<() => void>(() => undefined)
  const nodeMapRef = useRef<{ graph: GraphData; map: Map<string, GraphNode> } | null>(null)
  const renderSubsetRef = useRef<RenderSubset | null>(null)
  const last3DDrawRef = useRef(0)
  const largeTickTimerRef = useRef<number | null>(null)
  const manualTickRef = useRef<(() => void) | null>(null)
  const hubSelectionRef = useRef<{ nodes: GraphNode[] | null; links: GraphLink[] | null; ids: Set<string> }>({ nodes: null, links: null, ids: new Set() })
  graphRef.current = graph
  selectedIdRef.current = selectedId
  modeRef.current = mode
  colorResolverRef.current = getNodeColor
  simulationGuardRef.current = onSimulationGuard
  graphRenderedCallbackRef.current = onGraphRendered
  physicsTickCallbackRef.current = onPhysicsTick
  visibleNodeIdsRef.current = visibleNodeIds ?? null
  settingsRef.current = settings
  pausedRef.current = paused
  showLabelsRef.current = showLabels
  // Link distance scale changes during the graph-rendered decay. Keep that one
  // setting out of the layout rebuild key so the existing force can update it
  // in place while other physics changes still rebuild the simulation.
  const layoutSettingsKey = Object.entries(settings)
    .filter(([key]) => key !== 'linkDistanceScale')
    .map(([key, value]) => `${key}:${value}`)
    .join('|')

  const getLayoutGraph = (requestedMode: GraphCanvasMode) => {
    const cache = layoutCacheRef.current
    if (cache.graph !== graph) {
      cache.graph = graph
      cache.twoD = null
      cache.threeD = null
    }
    if (requestedMode === '3d') {
      cache.threeD ??= createLayoutGraph(graph)
      return cache.threeD
    }
    cache.twoD ??= createLayoutGraph(graph)
    return cache.twoD
  }

  const getHubIds = (nodes: GraphNode[], links: GraphLink[]) => {
    if (hubSelectionRef.current.nodes !== nodes || hubSelectionRef.current.links !== links) {
      hubSelectionRef.current = { nodes, links, ids: selectHubIds(nodes, links) }
    }
    return hubSelectionRef.current.ids
  }

  const getRenderSubset = (currentGraph: LayoutGraph): RenderSubset => {
    const visibleIds = visibleNodeIdsRef.current
    const cached = renderSubsetRef.current
    if (cached?.graph === currentGraph && cached.visibleIds === visibleIds) return cached
    const nodes = visibleIds
      ? currentGraph.nodes.filter((node) => visibleIds.has(node.id))
      : currentGraph.nodes
    const links: RenderLink[] = []
    for (let index = 0; index < currentGraph.links.length; index += 1) {
      const edge = currentGraph.links[index]
      if (visibleIds) {
        const sourceId = typeof edge.source === 'string' ? edge.source : edge.source.id
        const targetId = typeof edge.target === 'string' ? edge.target : edge.target.id
        if (!visibleIds.has(sourceId) || !visibleIds.has(targetId)) continue
      }
      links.push({ edge, index })
    }
    const subset = { graph: currentGraph, visibleIds, nodes, links }
    renderSubsetRef.current = subset
    return subset
  }

  const project3D = (node: GraphNode) => {
    const view = viewRef.current
    const orbit = orbitRef.current
    const x = node.x ?? 0
    const y = node.y ?? 0
    const z = node.z ?? 0
    const cosYaw = Math.cos(orbit.yaw)
    const sinYaw = Math.sin(orbit.yaw)
    const yawX = x * cosYaw - z * sinYaw
    const yawZ = x * sinYaw + z * cosYaw
    const cosPitch = Math.cos(orbit.pitch)
    const sinPitch = Math.sin(orbit.pitch)
    const screenY = y * cosPitch - yawZ * sinPitch
    const depth = y * sinPitch + yawZ * cosPitch
    const cameraDistance = Math.max(900, 3 * boundaryRadius(graphRef.current.nodes.length, 3))
    const perspective = Math.max(0.42, Math.min(1.8, cameraDistance / Math.max(1, cameraDistance + depth)))
    return {
      x: view.x + yawX * view.scale * perspective,
      y: view.y + screenY * view.scale * perspective,
      depth,
      perspective,
    }
  }

  const draw3D = (ctx: CanvasRenderingContext2D, currentGraph: LayoutGraph, selected: GraphNode | undefined, hovered: GraphNode | null, nodeMap: Map<string, GraphNode>) => {
    const { nodes, links } = currentGraph
    const radius = boundaryRadius(nodes.length, 3)
    const hubIds = getHubIds(nodes, links)
    const renderSubset = getRenderSubset(currentGraph)
    const visibleNodes = renderSubset.nodes
    const dotScale = visualNodeScale(visibleNodes.length, nodes.length, viewRef.current.scale, hubIds.size)
    const showAllLabels = visibleNodes.length <= Math.max(80, hubIds.size)
    ctx.save()
    ctx.strokeStyle = 'rgba(115, 119, 127, 0.28)'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 5])
    // Great circles show the sphere's orientation as the camera orbits.
    for (let axis = 0; axis < 3; axis++) {
      ctx.beginPath()
      for (let step = 0; step <= 128; step++) {
        const angle = step / 128 * Math.PI * 2
        const a = radius * Math.cos(angle); const b = radius * Math.sin(angle)
        const point = project3D({ id: '', x: axis === 0 ? 0 : a, y: axis === 1 ? 0 : axis === 0 ? a : b, z: axis === 2 ? 0 : b })
        if (step === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      }
      ctx.stroke()
    }
    ctx.restore()
    const projected = new Map<GraphNode, ReturnType<typeof project3D>>()
    for (const node of visibleNodes) projected.set(node, project3D(node))
    const visibleLinks = renderSubset.links.map(({ edge }) => {
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      return source && target
        ? { source, target, sourcePoint: projected.get(source), targetPoint: projected.get(target) }
        : null
    }).filter((edge): edge is { source: GraphNode; target: GraphNode; sourcePoint: ReturnType<typeof project3D>; targetPoint: ReturnType<typeof project3D> } => Boolean(edge?.sourcePoint && edge.targetPoint))
    const linkStride = visibleLinks.length > 100_000 ? Math.ceil(visibleLinks.length / 100_000) : 1
    const sortedLinks = visibleLinks.filter((edge, index) => index % linkStride === 0 || edge.source === selected || edge.target === selected)
      .sort((a, b) => ((b.sourcePoint.depth + b.targetPoint.depth) / 2) - ((a.sourcePoint.depth + a.targetPoint.depth) / 2))
    ctx.lineCap = 'round'
    for (const edge of sortedLinks) {
      const isRelated = edge.source === selected || edge.target === selected
      const depth = (edge.sourcePoint.depth + edge.targetPoint.depth) / 2
      const opacity = isRelated ? 0.72 : Math.max(0.12, Math.min(0.34, 0.25 * edge.sourcePoint.perspective))
      ctx.strokeStyle = isRelated ? `rgba(37, 79, 239, ${opacity})` : `rgba(115, 119, 127, ${opacity})`
      ctx.lineWidth = isRelated ? 1.8 : 0.8 + Math.max(0, edge.sourcePoint.perspective - 0.8) * 0.7
      ctx.beginPath()
      ctx.moveTo(edge.sourcePoint.x, edge.sourcePoint.y)
      ctx.lineTo(edge.targetPoint.x, edge.targetPoint.y)
      ctx.stroke()
      if (!isRelated && depth > 450) continue
      const dx = edge.targetPoint.x - edge.sourcePoint.x
      const dy = edge.targetPoint.y - edge.sourcePoint.y
      const distance = Math.hypot(dx, dy) || 1
      const ux = dx / distance
      const uy = dy / distance
      const targetRadius = visualNodeRadius(edge.target, settingsRef.current, dotScale) * edge.targetPoint.perspective * viewRef.current.scale
      const tipX = edge.targetPoint.x - ux * (targetRadius + 2)
      const tipY = edge.targetPoint.y - uy * (targetRadius + 2)
      const size = (isRelated ? 5 : 3.5) * viewRef.current.scale
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55)
      ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55)
      ctx.closePath()
      ctx.fill()
    }
    const sortedNodes = visibleNodes.map((node) => ({ node, point: projected.get(node) })).filter((item): item is { node: GraphNode; point: ReturnType<typeof project3D> } => Boolean(item.point))
    if (sortedNodes.length <= 10_000) sortedNodes.sort((a, b) => b.point.depth - a.point.depth)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = `500 ${Math.max(9, Math.round(11 * dotScale))}px Inter, ui-sans-serif, system-ui, sans-serif`
    for (const { node, point } of sortedNodes) {
      const radius = visualNodeRadius(node, settingsRef.current, dotScale) * point.perspective * viewRef.current.scale
      const activeRing = 5 * viewRef.current.scale
      const active = node === selected || node === hovered
      const isHub = hubIds.has(node.id)
      if (active) {
        ctx.beginPath()
        ctx.arc(point.x, point.y, radius + activeRing, 0, Math.PI * 2)
        ctx.fillStyle = node === selected ? 'rgba(37, 79, 239, .16)' : 'rgba(37, 79, 239, .08)'
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
      const color = colorResolverRef.current?.(node) ?? node.color ?? (node === selected ? '#254fef' : '#9aabf8')
      ctx.fillStyle = color
      ctx.globalAlpha = Math.max(0.46, Math.min(1, 0.58 + point.perspective * 0.42))
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = isHub ? HUB_OUTLINE_COLOR : node === selected ? '#254fef' : 'rgba(28, 32, 39, .28)'
      ctx.lineWidth = node === selected ? 2 : isHub ? 1.6 : 1
      ctx.stroke()
      if (!showLabelsRef.current) continue
      const text = node.label ?? node.title ?? node.id
      if (showAllLabels || active || point.perspective > 0.92) {
        ctx.fillStyle = node === selected ? '#1c2027' : '#555c68'
        ctx.fillText(text.length > 30 ? `${text.slice(0, 28)}…` : text, point.x, point.y + radius + 5)
      }
    }
  }

  const drawLargeGraphLabels = (ctx: CanvasRenderingContext2D, nodes: GraphNode[], hubIds: ReadonlySet<string>, selected: GraphNode | undefined, hovered: GraphNode | null, dotScale: number) => {
    if (!showLabelsRef.current) return
    // Keep dense maps legible, but let zooming out reveal a broader sample when
    // fewer dots are being painted. Hubs remain labelled at every zoom level.
    const zoom = viewRef.current.scale
    const baseLabelBudget = nodes.length > 20_000 ? 300 : nodes.length > 8_000 ? 400 : nodes.length > 2_000 ? 520 : 950
    const zoomBoost = zoom < 0.58 ? 2.4 : zoom < 0.85 ? 1.7 : zoom < 1.15 ? 1.25 : 1
    const labelBudget = Math.min(nodes.length, Math.ceil(baseLabelBudget * zoomBoost))
    const labelStride = Math.max(1, Math.ceil(nodes.length / Math.max(1, labelBudget)))
    const minimumDegree = zoom < 0.85 ? 0 : zoom > 1.15 ? 0 : 8
    const degreeReference = Math.max(10, settingsRef.current.hubDegreeReference)
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node.x == null || node.y == null) continue
      const active = node === selected || node === hovered
      const degree = articleDegree(node)
      const isHub = hubIds.has(node.id)
      const show = isHub || active || (degree >= minimumDegree && index % labelStride === 0)
      if (!show) continue
      const importance = Math.min(1, Math.log1p(degree) / Math.log1p(degreeReference))
      const fontSize = (9 + importance * 3 + (active ? 1 : 0)) * dotScale
      const text = node.label ?? node.title ?? node.id
      const label = text.length > 30 ? `${text.slice(0, 28)}…` : text
      const y = node.y + visualNodeRadius(node, settingsRef.current, dotScale) + 5
      ctx.font = `${active || isHub ? 600 : 500} ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`
      ctx.globalAlpha = active ? 1 : 0.48 + importance * 0.42
      // A light halo keeps names readable over the dense link field.
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(255, 255, 255, .9)'
      ctx.strokeText(label, node.x, y)
      ctx.fillStyle = node === selected ? '#1c2027' : '#555c68'
      ctx.fillText(label, node.x, y)
    }
    ctx.globalAlpha = 1
    ctx.restore()
  }

  const draw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height, dpr } = sizeRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const displayedNodeCount = visibleNodeIdsRef.current?.size ?? graphRef.current.nodes.length
    if (modeRef.current === '3d' && displayedNodeCount > LARGE_GRAPH_THRESHOLD) {
      const now = typeof performance === 'undefined' ? Date.now() : performance.now()
      if (now - last3DDrawRef.current < 32) return
      last3DDrawRef.current = now
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const view = viewRef.current
    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)
    const currentGraph = activeLayoutRef.current ?? graphRef.current
    const nodes = currentGraph.nodes
    const renderSubset = getRenderSubset(currentGraph)
    const visibleNodes = renderSubset.nodes
    const largeGraph = nodes.length > LARGE_GRAPH_THRESHOLD
    const renderLargeGraph = largeGraph && visibleNodes.length > LARGE_GRAPH_THRESHOLD
    const hubIds = getHubIds(nodes, currentGraph.links)
    const dotScale = visualNodeScale(visibleNodes.length, nodes.length, view.scale, hubIds.size)
    const showAllVisibleLabels = visibleNodes.length <= Math.max(80, hubIds.size)
    const visibleLabelBudget = visibleNodes.length <= 120
      ? visibleNodes.length
      : visibleNodes.length <= 500
        ? Math.ceil(visibleNodes.length * 0.8)
        : Math.min(950, Math.ceil(visibleNodes.length * 0.55))
    const visibleLabelStride = Math.max(1, Math.ceil(visibleNodes.length / Math.max(1, visibleLabelBudget)))
    const cachedNodeMap = nodeMapRef.current?.graph === currentGraph
      ? nodeMapRef.current.map
      : new Map(nodes.map((node) => [node.id, node]))
    nodeMapRef.current = { graph: currentGraph, map: cachedNodeMap }
    const nodeMap = cachedNodeMap
    const selected = selectedIdRef.current ? nodeMap.get(selectedIdRef.current) : undefined
    const hovered = hoverRef.current
    if (modeRef.current === '3d') {
      ctx.restore()
      draw3D(ctx, currentGraph, selected, hovered, nodeMap)
      if (nodes.length > 0 && activeGraphRef.current === graphRef.current && graphRenderedRef.current !== graphRef.current) {
        graphRenderedRef.current = graphRef.current
        graphRenderedCallbackRef.current?.(graphRef.current)
      }
      return
    }
    ctx.save()
    ctx.strokeStyle = 'rgba(115, 119, 127, 0.35)'
    ctx.lineWidth = 1 / view.scale
    ctx.setLineDash([5 / view.scale, 5 / view.scale])
    ctx.beginPath()
    ctx.arc(0, 0, boundaryRadius(nodes.length, 2), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    const linkStride = renderLargeGraph ? Math.max(1, Math.ceil(currentGraph.links.length / 100_000)) : 1
    ctx.lineCap = 'round'
    for (const { edge, index: edgeIndex } of renderSubset.links) {
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      if (!source || !target || source.x == null || target.x == null || source.y == null || target.y == null) continue
      const isRelated = source === selected || target === selected
      if (renderLargeGraph && !isRelated && edgeIndex % linkStride !== 0) continue
      ctx.strokeStyle = isRelated ? 'rgba(37, 79, 239, .72)' : renderLargeGraph ? 'rgba(115, 119, 127, .16)' : 'rgba(115, 119, 127, .22)'
      ctx.lineWidth = isRelated ? 1.7 : renderLargeGraph ? 0.65 : 1
      ctx.beginPath()
      ctx.moveTo(source.x, source.y)
      ctx.lineTo(target.x, target.y)
      ctx.stroke()
      if (renderLargeGraph && !isRelated) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.hypot(dx, dy) || 1
      const ux = dx / distance
      const uy = dy / distance
      const tip = { x: target.x - ux * (visualNodeRadius(target, settingsRef.current, dotScale) + 2), y: target.y - uy * (visualNodeRadius(target, settingsRef.current, dotScale) + 2) }
      const size = isRelated ? 5 : 4
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.moveTo(tip.x, tip.y)
      ctx.lineTo(tip.x - ux * size - uy * size * 0.55, tip.y - uy * size + ux * size * 0.55)
      ctx.lineTo(tip.x - ux * size + uy * size * 0.55, tip.y - uy * size - ux * size * 0.55)
      ctx.closePath()
      ctx.fill()
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = `500 ${Math.max(9, Math.round(11 * dotScale))}px Inter, ui-sans-serif, system-ui, sans-serif`
    for (let visibleIndex = 0; visibleIndex < visibleNodes.length; visibleIndex += 1) {
      const node = visibleNodes[visibleIndex]
      if (node.x == null || node.y == null) continue
      const radius = visualNodeRadius(node, settingsRef.current, dotScale)
      const active = node === selected || node === hovered
      const isHub = hubIds.has(node.id)
      if (active) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, radius + 5, 0, Math.PI * 2)
        ctx.fillStyle = node === selected ? 'rgba(37, 79, 239, .16)' : 'rgba(37, 79, 239, .08)'
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = colorResolverRef.current?.(node) ?? node.color ?? (node === selected ? '#254fef' : '#9aabf8')
      ctx.fill()
      ctx.strokeStyle = isHub ? HUB_OUTLINE_COLOR : node === selected ? '#254fef' : 'rgba(28, 32, 39, .28)'
      ctx.lineWidth = node === selected ? 2 : isHub ? 1.6 : 1
      ctx.stroke()
      if (!showLabelsRef.current) continue
      const text = node.label ?? node.title ?? node.id
      // Keep the regular canvas path lightweight; large-map labels are drawn
      // by the level-of-detail overlay below.
      const showLabel = showAllVisibleLabels || active || (view.scale <= 0.58 && visibleIndex % visibleLabelStride === 0) || view.scale > 0.58
      if (!renderLargeGraph && showLabel) {
        ctx.fillStyle = node === selected ? '#1c2027' : '#555c68'
        ctx.fillText(text.length > 30 ? `${text.slice(0, 28)}…` : text, node.x, node.y + radius + 5)
      }
    }
    if (renderLargeGraph) drawLargeGraphLabels(ctx, visibleNodes, hubIds, selected, hovered, dotScale)
    ctx.restore()
    if (nodes.length > 0 && activeGraphRef.current === graphRef.current && graphRenderedRef.current !== graphRef.current) {
      graphRenderedRef.current = graphRef.current
      graphRenderedCallbackRef.current?.(graphRef.current)
    }
  }
  drawRef.current = draw

  useImperativeHandle(ref, () => ({
    fit: () => {
      const bounds = boundedGraphBounds(activeLayoutRef.current?.nodes ?? graph.nodes, modeRef.current)
      if (!bounds) return
      const { width, height } = sizeRef.current
      const scale = Math.max(0.02, Math.min(2.2, 0.86 * Math.min(width / Math.max(1, bounds.maxX - bounds.minX + 80), height / Math.max(1, bounds.maxY - bounds.minY + 80))))
      viewRef.current = { scale, x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale, y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale }
      drawRef.current()
    },
    resetView: () => {
      viewRef.current = initialBoundaryView(sizeRef.current.width, sizeRef.current.height, graphRef.current.nodes.length, modeRef.current)
      orbitRef.current = { yaw: -0.45, pitch: 0.24 }
      drawRef.current()
    },
    focusNode: (id: string) => {
      const node = (activeLayoutRef.current?.nodes ?? graphRef.current.nodes).find((candidate) => candidate.id === id)
      if (!node) return
      const { width, height } = sizeRef.current
      if (modeRef.current === '3d') {
        const point = project3D(node)
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
        viewRef.current.x += width / 2 - point.x
        viewRef.current.y += height / 2 - point.y
      } else if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
        viewRef.current.x = width / 2 - (node.x as number) * viewRef.current.scale
        viewRef.current.y = height / 2 - (node.y as number) * viewRef.current.scale
      } else {
        return
      }
      drawRef.current()
      canvasRef.current?.focus({ preventScroll: true })
    },
  }), [graph.nodes, mode])

  useEffect(() => {
    const layoutGraph = getLayoutGraph(mode)
    const dimensions = mode === '3d' ? 3 : 2
    activeGraphRef.current = graph
    activeLayoutRef.current = layoutGraph
    const hubIds = getHubIds(layoutGraph.nodes, layoutGraph.links)
    const { width, height } = sizeRef.current
    if (width > 1 && height > 1) viewRef.current = initialBoundaryView(width, height, graph.nodes.length, mode)
    const largeGraph = layoutGraph.nodes.length > LARGE_GRAPH_THRESHOLD
    const spacing = layoutSpacing(layoutGraph.nodes.length)
    const repulsionScale = articleRepulsionScale(layoutGraph.nodes, layoutGraph.links)
    seedLayout(layoutGraph.nodes, dimensions)
    roundSimulationNodesF32(layoutGraph.nodes, dimensions)
    // Keep every edge available for rendering, but cap the per-tick attraction
    // work in large maps. The representative stride preserves the overall
    // topology while preventing a dense dump tier from freezing the tab.
    const attractionLinks = largeGraph && layoutGraph.links.length > 50_000
      ? layoutGraph.links.filter((_, index) => index % Math.ceil(layoutGraph.links.length / 50_000) === 0)
      : layoutGraph.links
    let framePending = false
    let invalidState = false
    let simulationTicks = 0
    let disposed = false
    let cpuStarted = false
    let activeSimulation: PhysicsController | null = null
    const protectNumerics = largeGraph || settings.linkDistanceScale < 10_000 || settings.linkDistanceExponent > 2
    const afterTick = () => {
      roundSimulationNodesF32(layoutGraph.nodes, dimensions)
      simulationTicks += 1
      if ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV && hostRef.current) {
        hostRef.current.dataset.physicsTicks = String(simulationTicks)
      }
      physicsTickCallbackRef.current?.()
      if (!invalidState && protectNumerics && (simulationTicks <= 120 || simulationTicks % 32 === 0)) {
        const numericLimit = 1_000_000
        const invalid = layoutGraph.nodes.find((node) => !Number.isFinite(node.x) || !Number.isFinite(node.y) || (mode === '3d' && !Number.isFinite(node.z)) || !Number.isFinite(node.vx) || !Number.isFinite(node.vy) || (mode === '3d' && !Number.isFinite(node.vz))
          || Math.abs(node.x ?? 0) > numericLimit || Math.abs(node.y ?? 0) > numericLimit
          || (mode === '3d' && Math.abs(node.z ?? 0) > numericLimit)
          || Math.abs(node.vx ?? 0) > numericLimit || Math.abs(node.vy ?? 0) > numericLimit
          || (mode === '3d' && Math.abs(node.vz ?? 0) > numericLimit))
        if (invalid) {
          invalidState = true
          activeSimulation?.stop()
          invalid.x = Number.isFinite(invalid.x) && Math.abs(invalid.x as number) <= numericLimit ? invalid.x : 0
          invalid.y = Number.isFinite(invalid.y) && Math.abs(invalid.y as number) <= numericLimit ? invalid.y : 0
          invalid.z = mode === '3d' && Number.isFinite(invalid.z) && Math.abs(invalid.z as number) <= numericLimit ? invalid.z : mode === '3d' ? 0 : invalid.z
          invalid.vx = Number.isFinite(invalid.vx) && Math.abs(invalid.vx as number) <= numericLimit ? invalid.vx : 0
          invalid.vy = Number.isFinite(invalid.vy) && Math.abs(invalid.vy as number) <= numericLimit ? invalid.vy : 0
          invalid.vz = mode === '3d' && Number.isFinite(invalid.vz) && Math.abs(invalid.vz as number) <= numericLimit ? invalid.vz : mode === '3d' ? 0 : invalid.vz
          simulationGuardRef.current?.()
          drawRef.current()
          return
        }
      }
      if (!largeGraph) { drawRef.current(); return }
      if (framePending) return
      framePending = true
      requestAnimationFrame(() => { framePending = false; drawRef.current() })
    }

    const startCpuSimulation = () => {
      if (disposed || cpuStarted) return
      cpuStarted = true
      activeSimulation?.destroy?.()
      invalidState = false
      const sim = (mode === '3d'
        ? forceSimulation3D(layoutGraph.nodes, 3)
        : forceSimulation(layoutGraph.nodes)) as unknown as Simulation<GraphNode, undefined>
      if (mode === '3d') {
        sim
          .force('charge', forceManyBody3D()
            .strength((node: GraphNode) => -repulsionScale * (settings.baseCharge + articleImportance(node, settings) * settings.articleImportanceCharge))
            .distanceMax(settings.chargeDistance * spacing))
          .force('center', forceCenter3D(0, 0, 0).strength(settings.centerStrength))
          .force('link-attraction', symmetricAttraction(attractionLinks, layoutGraph.nodes, settings, 3, hubIds, () => settingsRef.current))
          .force('hub-interactions', hubInteractions(layoutGraph.links, settings, hubIds, (node) => hubRepulsionScore(node, hubIds, settings), 3, () => settingsRef.current))
          .force('collision', forceCollide3D()
            .radius((node: GraphNode) => nodeRadius(node, settings) + settings.collisionPadding)
            .iterations(Math.max(1, Math.round(settings.collisionIterations))))
      } else {
        sim
          .force('charge', forceManyBody<GraphNode>()
            .strength((node) => -repulsionScale * (settings.baseCharge + articleImportance(node, settings) * settings.articleImportanceCharge))
            .distanceMax(settings.chargeDistance * spacing))
          .force('unrelated-repulsion', unrelatedRepulsion(layoutGraph.links, layoutGraph.nodes, largeGraph, settings, hubIds, (node) => hubRepulsionScore(node, hubIds, settings), repulsionScale))
          .force('center', forceCenter<GraphNode>(0, 0).strength(settings.centerStrength))
          .force('link-attraction', symmetricAttraction(attractionLinks, layoutGraph.nodes, settings, 2, hubIds, () => settingsRef.current))
          .force('hub-interactions', hubInteractions(layoutGraph.links, settings, hubIds, (node) => hubRepulsionScore(node, hubIds, settings), 2, () => settingsRef.current))
          .force('collision', forceCollide<GraphNode>().radius((node) => nodeRadius(node, settings) + settings.collisionPadding).iterations(Math.max(1, Math.round(settings.collisionIterations))))
      }
      sim
        .force('boundary', boundaryForce(boundaryRadius(layoutGraph.nodes.length, dimensions), dimensions))
        .velocityDecay(settings.velocityDecay)
        .alphaDecay(settings.alphaDecay)
        .alphaMin(settings.alphaMin)
        .alphaTarget(settings.alphaTarget)
      const initialTemperature = Number.isFinite(settings.initialTemperature)
        ? Math.max(settings.alphaMin, Math.min(1, settings.initialTemperature))
        : 0.8
      sim.alpha(initialTemperature)
      activeSimulation = sim as unknown as PhysicsController
      simulationRef.current = activeSimulation
      if (hostRef.current) hostRef.current.dataset.physicsBackend = 'cpu-f32'
      sim.on('tick', afterTick)
      if (largeGraph) {
        sim.stop()
        const runLargeTick = () => {
          largeTickTimerRef.current = null
          if (pausedRef.current || invalidState || disposed) return
          const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
          sim.tick()
          afterTick()
          if (!pausedRef.current && !invalidState && sim.alpha() >= sim.alphaMin()) {
            const now = typeof performance === 'undefined' ? Date.now() : performance.now()
            largeTickTimerRef.current = window.setTimeout(runLargeTick, nextPhysicsTickDelay(startedAt, now))
          }
        }
        manualTickRef.current = runLargeTick
        if (!pausedRef.current) largeTickTimerRef.current = window.setTimeout(runLargeTick, 0)
      } else if (pausedRef.current) sim.stop()
    }

    if (hostRef.current) hostRef.current.dataset.physicsBackend = 'initializing'
    drawRef.current()
    const gpuNodeParameters = layoutGraph.nodes.map((node) => ({
      charge: -repulsionScale * (settings.baseCharge + articleImportance(node, settings) * settings.articleImportanceCharge),
      radius: nodeRadius(node, settings) + settings.collisionPadding,
      hubScore: hubRepulsionScore(node, hubIds, settings),
    }))
    void createGpuGraphSimulation({
      nodes: layoutGraph.nodes,
      links: layoutGraph.links,
      attractionLinks,
      dimensions,
      settings,
      readSettings: () => settingsRef.current,
      hubIds,
      nodeParameters: gpuNodeParameters,
      spacing,
      repulsionScale,
      boundaryRadius: boundaryRadius(layoutGraph.nodes.length, dimensions),
      largeGraph,
      onTick: afterTick,
      onFailure: (error) => {
        if (disposed) return
        console.warn('WebGPU physics failed; continuing with the f32 CPU engine.', error)
        roundSimulationNodesF32(layoutGraph.nodes, dimensions)
        startCpuSimulation()
      },
    }).then((gpuSimulation) => {
      if (disposed) {
        gpuSimulation?.destroy?.()
        return
      }
      if (!gpuSimulation) {
        startCpuSimulation()
        return
      }
      activeSimulation = gpuSimulation
      simulationRef.current = gpuSimulation
      if (hostRef.current) hostRef.current.dataset.physicsBackend = 'webgpu'
      if (!pausedRef.current) gpuSimulation.restart()
    }).catch((error) => {
      if (disposed) return
      console.warn('WebGPU physics is unavailable; using the f32 CPU engine.', error)
      startCpuSimulation()
    })

    return () => {
      disposed = true
      activeSimulation?.stop()
      activeSimulation?.destroy?.()
      if (largeTickTimerRef.current != null) window.clearTimeout(largeTickTimerRef.current)
      largeTickTimerRef.current = null
      manualTickRef.current = null
      if (simulationRef.current === activeSimulation) simulationRef.current = null
    }
  }, [graph, layoutSettingsKey, mode])

  useEffect(() => {
    const simulation = simulationRef.current
    if (!simulation || pausedRef.current) return
    const reheatTemperature = Number.isFinite(settings.initialTemperature)
      ? Math.max(settings.alphaMin, Math.min(0.12, settings.initialTemperature))
      : 0.12
    if (simulation.alpha() < reheatTemperature) simulation.alpha(reheatTemperature)
    if (manualTickRef.current) {
      simulation.stop()
      if (largeTickTimerRef.current == null) manualTickRef.current()
    } else simulation.restart()
  }, [settings.linkDistanceScale])

  useEffect(() => { drawRef.current() }, [selectedId, showLabels, visibleNodeIds])

  useEffect(() => {
    orbitRef.current = { yaw: -0.45, pitch: 0.24 }
    viewRef.current = initialBoundaryView(sizeRef.current.width, sizeRef.current.height, graphRef.current.nodes.length, modeRef.current)
    hoverRef.current = null
    onHover?.(null)
    drawRef.current()
  }, [mode])

  useEffect(() => {
    const simulation = simulationRef.current
    simulation?.alphaTarget(paused ? 0 : settings.alphaTarget)
    if (paused) {
      simulation?.stop()
      if (largeTickTimerRef.current != null) window.clearTimeout(largeTickTimerRef.current)
      largeTickTimerRef.current = null
    } else if (manualTickRef.current) {
      simulation?.stop()
      if (simulation && simulation.alpha() < settings.alphaMin) simulation.alpha(settings.initialTemperature)
      if (largeTickTimerRef.current == null) manualTickRef.current()
    } else {
      // With a zero alpha target, a simulation that already cooled below
      // alphaMin will have stopped. Reheat it when the user resumes physics so
      // the layout can make another local improvement.
      if (simulation && simulation.alpha() < settings.alphaMin) {
        const resumeTemperature = Number.isFinite(settings.initialTemperature)
          ? Math.max(settings.alphaMin, Math.min(1, settings.initialTemperature))
          : 0.8
        simulation.alpha(resumeTemperature)
      }
      simulation?.restart()
    }
  }, [paused, settings.alphaTarget, settings.alphaMin, settings.initialTemperature])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const resize = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = host.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr }
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr)
      if (!viewInitializedRef.current) {
        viewRef.current = initialBoundaryView(rect.width, rect.height, graphRef.current.nodes.length, modeRef.current)
        viewInitializedRef.current = true
      }
      canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`; drawRef.current()
    }
    resize()
    const observer = new ResizeObserver(resize); observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const screenPoint = (event: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const localPoint = (event: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }): Point => {
    const point = screenPoint(event); const view = viewRef.current
    return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
  }
  const hit = (point: Point) => {
    const nodes = activeLayoutRef.current?.nodes ?? graph.nodes
    const visibleNodes = visibleNodeIdsRef.current
      ? nodes.filter((node) => visibleNodeIdsRef.current?.has(node.id))
      : nodes
    const links = activeLayoutRef.current?.links ?? graph.links
    const hubIds = getHubIds(nodes, links)
    const dotScale = visualNodeScale(visibleNodes.length, nodes.length, viewRef.current.scale, hubIds.size)
    if (modeRef.current === '3d') {
      return visibleNodes.map((node) => ({ node, projected: project3D(node) }))
        .filter(({ projected }) => Number.isFinite(projected.x) && Number.isFinite(projected.y))
        .sort((first, second) => first.projected.depth - second.projected.depth)
        .find(({ node, projected }) => Math.hypot(projected.x - point.x, projected.y - point.y) <= visualNodeRadius(node, settingsRef.current, dotScale) * projected.perspective * viewRef.current.scale + Math.max(4, 8 * viewRef.current.scale))?.node
    }
    return visibleNodes.find((node) => node.x != null && node.y != null && Math.hypot((node.x as number) - point.x, (node.y as number) - point.y) <= (visualNodeRadius(node, settingsRef.current, dotScale) + 7) / viewRef.current.scale)
  }

  return <div ref={hostRef} className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
    <canvas ref={canvasRef} aria-label={mode === '3d' ? 'Wikipedia article graph in 3D. Drag to orbit and scroll to zoom.' : 'Wikipedia article graph'} style={{ position: 'relative', display: 'block', width: '100%', height: '100%', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none', background: 'transparent' }}
      onPointerDown={(event) => { const point = localPoint(event); const screen = screenPoint(event); const node = hit(modeRef.current === '3d' ? screen : point); event.currentTarget.setPointerCapture(event.pointerId); pressedNodeRef.current = node ?? null; if (modeRef.current === '3d') { if (node) return; if (event.shiftKey) panRef.current = { x: viewRef.current.x, y: viewRef.current.y, start: { x: event.clientX, y: event.clientY } }; else rotateRef.current = { start: { x: event.clientX, y: event.clientY }, orbit: { ...orbitRef.current } }; return } if (node) { dragRef.current = { node, offset: { x: (node.x as number) - point.x, y: (node.y as number) - point.y } }; node.fx = node.x; node.fy = node.y } else panRef.current = { x: viewRef.current.x, y: viewRef.current.y, start: { x: event.clientX, y: event.clientY } } }}
      onPointerMove={(event) => { const point = localPoint(event); const screen = screenPoint(event); if (modeRef.current === '3d') { const rotate = rotateRef.current; if (rotate) { orbitRef.current.yaw = rotate.orbit.yaw + (event.clientX - rotate.start.x) * 0.008; orbitRef.current.pitch = Math.max(-1.2, Math.min(1.2, rotate.orbit.pitch + (event.clientY - rotate.start.y) * 0.006)); draw(); return } const pan = panRef.current; if (pan) { viewRef.current.x = pan.x + event.clientX - pan.start.x; viewRef.current.y = pan.y + event.clientY - pan.start.y; draw(); return } } const drag = dragRef.current; const node = drag?.node; if (node && drag) { node.fx = point.x + drag.offset.x; node.fy = point.y + drag.offset.y; if (!pausedRef.current) { simulationRef.current?.alpha(0.12); if (manualTickRef.current) { if (largeTickTimerRef.current == null) manualTickRef.current() } else simulationRef.current?.restart() }; draw(); return } const pan = panRef.current; if (pan) { viewRef.current.x = pan.x + event.clientX - pan.start.x; viewRef.current.y = pan.y + event.clientY - pan.start.y; draw(); return } const next = hit(modeRef.current === '3d' ? screen : point) ?? null; if (next !== hoverRef.current) { hoverRef.current = next; onHover?.(next); draw() } }}
      onPointerUp={(event) => { const drag = dragRef.current; if (drag) { drag.node.fx = null; drag.node.fy = null; onSelect?.(drag.node) } else if (pressedNodeRef.current && !rotateRef.current && !panRef.current) onSelect?.(pressedNodeRef.current); dragRef.current = null; pressedNodeRef.current = null; panRef.current = null; rotateRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); draw() }}
      onPointerCancel={() => { dragRef.current = null; pressedNodeRef.current = null; panRef.current = null; rotateRef.current = null }}
      onPointerLeave={() => { if (!dragRef.current && !rotateRef.current && hoverRef.current) { hoverRef.current = null; onHover?.(null); draw() } }}
      onWheel={(event) => { event.preventDefault(); const factor = Math.max(.75, Math.min(1.25, Math.exp(-event.deltaY * .001))); const view = viewRef.current; if (modeRef.current === '3d') { view.scale = Math.max(.02, Math.min(4, view.scale * factor)) } else { const before = localPoint(event); const screen = screenPoint(event); view.scale = Math.max(.02, Math.min(4, view.scale * factor)); view.x = screen.x - before.x * view.scale; view.y = screen.y - before.y * view.scale } draw() }}
      tabIndex={0}
      role="application"
      onKeyDown={(event) => { if (event.key === '+' || event.key === '=') { event.preventDefault(); viewRef.current.scale = Math.min(4, viewRef.current.scale * 1.15); draw() } else if (event.key === '-') { event.preventDefault(); viewRef.current.scale = Math.max(.02, viewRef.current.scale / 1.15); draw() } else if (modeRef.current === '3d' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); if (event.shiftKey) { const panStep = 36; if (event.key === 'ArrowLeft') viewRef.current.x += panStep; else if (event.key === 'ArrowRight') viewRef.current.x -= panStep; else if (event.key === 'ArrowUp') viewRef.current.y += panStep; else viewRef.current.y -= panStep } else { const orbitStep = 0.12; if (event.key === 'ArrowLeft') orbitRef.current.yaw -= orbitStep; else if (event.key === 'ArrowRight') orbitRef.current.yaw += orbitStep; else if (event.key === 'ArrowUp') orbitRef.current.pitch = Math.max(-1.2, orbitRef.current.pitch - orbitStep); else orbitRef.current.pitch = Math.min(1.2, orbitRef.current.pitch + orbitStep) } draw() } else if (event.key === '0') { event.preventDefault(); viewRef.current = initialBoundaryView(sizeRef.current.width, sizeRef.current.height, graphRef.current.nodes.length, modeRef.current); orbitRef.current = { yaw: -0.45, pitch: 0.24 }; draw() } else if (event.key.toLowerCase() === 'f') { event.preventDefault(); const bounds = boundedGraphBounds(activeLayoutRef.current?.nodes ?? graphRef.current.nodes, modeRef.current); if (bounds) { const { width, height } = sizeRef.current; const scale = Math.max(.02, Math.min(2.2, .86 * Math.min(width / Math.max(1, bounds.maxX - bounds.minX + 80), height / Math.max(1, bounds.maxY - bounds.minY + 80)))); viewRef.current = { scale, x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale, y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale }; draw() } } }} />
  </div>
})

export default GraphCanvas
