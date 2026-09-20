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
import { createGpuGraphSimulation, nextPhysicsTickDelay, PHYSICS_TICKS_PER_SECOND, type PhysicsController } from '../graph/gpuSimulation'
import { layoutSpacing, seedLayout, symmetricAttraction, unrelatedRepulsion, hubInteractions } from '../graph/layout'
import { velocityLimitForce } from '../graph/velocity'
import { kineticEnergy } from '../graph/energy'

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
  /** Download the complete graph layout as a scalable SVG with every label. */
  exportSvg: () => void
  /** Center an article in the current viewport without changing its zoom. */
  focusNode: (id: string) => void
}

export type GraphCanvasProps = {
  graph: GraphData
  /** Node ids to paint; omitted means every node is visible. The simulation always uses the full graph. */
  visibleNodeIds?: ReadonlySet<string>
  /** Called after the current graph has been painted to the canvas. */
  onGraphRendered?: (graph: GraphData) => void
  /** Called once for every completed force-simulation tick with current kinetic energy. */
  onPhysicsTick?: (energy: number) => void
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
  /** Whether every currently visible article should receive a name label. */
  showAllLabels?: boolean
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

const PHYSICS_COOLING_SECONDS = 30
const DEFAULT_INITIAL_TEMPERATURE = 0.8
const DEFAULT_ALPHA_MIN = 0.001

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
  // D3 updates alpha once per tick. This decay reaches alphaMin in 30 seconds
  // at 60 Hz when starting from the default initial temperature.
  initialTemperature: DEFAULT_INITIAL_TEMPERATURE,
  alphaDecay: 1 - Math.pow(
    DEFAULT_ALPHA_MIN / DEFAULT_INITIAL_TEMPERATURE,
    1 / (PHYSICS_TICKS_PER_SECOND * PHYSICS_COOLING_SECONDS),
  ),
  alphaMin: DEFAULT_ALPHA_MIN,
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
type LabelCandidate = {
  node: GraphNode
  x: number
  y: number
  radius: number
  priority: number
  active: boolean
  isHub: boolean
}
type LabelRect = { left: number; top: number; right: number; bottom: number }

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
) => {
  const physicsRadius = nodeRadius(node, settings)
  // Sparse views enlarge dots for legibility, but never past a restrained
  // fraction of the reserved collision gap. The physics remains responsible
  // for spacing; the paint layer must not make correctly spaced centers look
  // like nested nodes.
  const visualCeiling = physicsRadius + Math.max(0, settings.collisionPadding) * 0.35
  return Math.min(physicsRadius * scale, visualCeiling)
}
// Collision corrections are applied to velocity, then velocity decay is
// applied before integration. Scale the correction so one pass can still
// clear the requested gap instead of leaving a persistent overlap.
const collisionStrength = (settings: GraphSimulationSettings) =>
  1 / Math.max(0.25, 1 - Math.max(0, Math.min(0.9, settings.velocityDecay)))
const LARGE_GRAPH_THRESHOLD = 2_000
const HUB_OUTLINE_COLOR = '#2f9e44'
const LABEL_MAX_LENGTH = 28
const labelText = (node: GraphNode) => {
  const text = node.label ?? node.title ?? node.id
  return text.length > LABEL_MAX_LENGTH ? `${text.slice(0, LABEL_MAX_LENGTH - 1)}…` : text
}
const exportLabelText = (node: GraphNode) => (node.label ?? node.title ?? node.id).replace(/[\r\n]+/g, ' ')
const escapeSvgText = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}[character] ?? character))
const svgNumber = (value: number) => Number.isFinite(value) ? Number(value.toFixed(3)).toString() : '0'
const labelBudget = (count: number, zoom: number, hubCount: number, showAll: boolean) => {
  if (showAll || count <= 12) return count
  const base = count <= 40 ? 8 : count <= 100 ? 12 : count <= 250 ? 18 : count <= 800 ? 28 : 420
  const zoomBoost = zoom >= 1.45 ? 2.2 : zoom >= 1.05 ? 1.55 : zoom < 0.5 ? 0.7 : 1
  return Math.min(count, Math.max(hubCount + 4, Math.ceil(base * zoomBoost)))
}
const labelPriority = (node: GraphNode, active: boolean, isHub: boolean) => {
  if (active) return 1_000_000
  if (isHub) return 100_000 + articleDegree(node) * 10
  return articleDegree(node)
}
const overlaps = (first: LabelRect, second: LabelRect, padding: number) =>
  first.left < second.right + padding && first.right > second.left - padding
    && first.top < second.bottom + padding && first.bottom > second.top - padding
const circleTouchesRect = (circle: { x: number; y: number; radius: number }, rect: LabelRect, padding: number) => {
  const x = Math.max(rect.left, Math.min(circle.x, rect.right))
  const y = Math.max(rect.top, Math.min(circle.y, rect.bottom))
  return Math.hypot(circle.x - x, circle.y - y) < circle.radius + padding
}
const repairNodeOverlaps = (nodes: GraphNode[], dimensions: 2 | 3, settings: GraphSimulationSettings) => {
  if (nodes.length === 0 || nodes.length > LARGE_GRAPH_THRESHOLD) return
  const radii = nodes.map((node) => nodeRadius(node, settings) + Math.max(0, settings.collisionPadding))
  const cellSize = Math.max(16, Math.max(...radii) * 2)
  const passes = Math.max(2, Math.min(4, Math.round(settings.collisionIterations) + 1))
  for (let pass = 0; pass < passes; pass += 1) {
    const cells = new Map<string, number[]>()
    const cellOf = (node: GraphNode) => {
      const x = Math.floor((node.x ?? 0) / cellSize)
      const y = Math.floor((node.y ?? 0) / cellSize)
      const z = dimensions === 3 ? Math.floor((node.z ?? 0) / cellSize) : 0
      return { x, y, z, key: `${x}:${y}:${z}` }
    }
    const locations = nodes.map((node) => cellOf(node))
    for (let index = 0; index < nodes.length; index += 1) {
      const bucket = cells.get(locations[index].key)
      if (bucket) bucket.push(index)
      else cells.set(locations[index].key, [index])
    }
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      const own = locations[index]
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const minZ = dimensions === 3 ? -1 : 0
          const maxZ = dimensions === 3 ? 1 : 0
          for (let oz = minZ; oz <= maxZ; oz += 1) {
            for (const otherIndex of cells.get(`${own.x + ox}:${own.y + oy}:${own.z + oz}`) ?? []) {
              if (otherIndex <= index) continue
              const other = nodes[otherIndex]
              let dx = (other.x ?? 0) - (node.x ?? 0)
              let dy = (other.y ?? 0) - (node.y ?? 0)
              let dz = dimensions === 3 ? (other.z ?? 0) - (node.z ?? 0) : 0
              let distance = Math.hypot(dx, dy, dz)
              if (distance < 1e-6) {
                const angle = (index * 0.7548776662 + otherIndex * 1.3247179572) * Math.PI * 2
                dx = Math.cos(angle)
                dy = Math.sin(angle)
                dz = dimensions === 3 ? Math.sin(angle * 0.61) : 0
                distance = Math.hypot(dx, dy, dz)
              }
              const combined = radii[index] + radii[otherIndex]
              if (distance >= combined) continue
              const firstPinned = node.fx != null || node.fy != null || (dimensions === 3 && node.fz != null)
              const secondPinned = other.fx != null || other.fy != null || (dimensions === 3 && other.fz != null)
              if (firstPinned && secondPinned) continue
              const nx = dx / distance
              const ny = dy / distance
              const nz = dz / distance
              const overlap = (combined - distance) * 0.72
              const firstWeight = radii[otherIndex] ** 2 / Math.max(1e-6, radii[index] ** 2 + radii[otherIndex] ** 2)
              const secondWeight = 1 - firstWeight
              const firstMove = secondPinned ? 0 : firstPinned ? overlap : overlap * firstWeight
              const secondMove = firstPinned ? 0 : secondPinned ? overlap : overlap * secondWeight
              if (firstMove > 0) {
                node.x = (node.x ?? 0) - nx * firstMove
                node.y = (node.y ?? 0) - ny * firstMove
                if (dimensions === 3) node.z = (node.z ?? 0) - nz * firstMove
              }
              if (secondMove > 0) {
                other.x = (other.x ?? 0) + nx * secondMove
                other.y = (other.y ?? 0) + ny * secondMove
                if (dimensions === 3) other.z = (other.z ?? 0) + nz * secondMove
              }
              const relativeVelocity = ((other.vx ?? 0) - (node.vx ?? 0)) * nx
                + ((other.vy ?? 0) - (node.vy ?? 0)) * ny
                + (dimensions === 3 ? ((other.vz ?? 0) - (node.vz ?? 0)) * nz : 0)
              if (relativeVelocity < 0) {
                const impulse = -relativeVelocity * 0.5
                if (!firstPinned) {
                  node.vx = (node.vx ?? 0) - nx * impulse * firstWeight
                  node.vy = (node.vy ?? 0) - ny * impulse * firstWeight
                  if (dimensions === 3) node.vz = (node.vz ?? 0) - nz * impulse * firstWeight
                }
                if (!secondPinned) {
                  other.vx = (other.vx ?? 0) + nx * impulse * secondWeight
                  other.vy = (other.vy ?? 0) + ny * impulse * secondWeight
                  if (dimensions === 3) other.vz = (other.vz ?? 0) + nz * impulse * secondWeight
                }
              }
            }
          }
        }
      }
    }
  }
}
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
  { graph, visibleNodeIds, mode = '2d', onGraphRendered, onPhysicsTick, selectedId, onSelect, onHover, onSimulationGuard, paused = false, className, getNodeColor, settings = DEFAULT_SIMULATION_SETTINGS, showLabels = true, showAllLabels = false },
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
  const showAllLabelsRef = useRef(showAllLabels)
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
  showAllLabelsRef.current = showAllLabels
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

  const drawPlacedLabels = (
    ctx: CanvasRenderingContext2D,
    candidates: LabelCandidate[],
    allNodes: Array<{ x: number; y: number; radius: number }>,
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
    screenScale: number,
    showAll: boolean,
  ) => {
    if (!candidates.length || !showLabelsRef.current) return
    const zoom = modeRef.current === '3d' ? 1 : viewRef.current.scale
    const selectedCandidates = candidates
      .slice()
      .sort((first, second) => second.priority - first.priority)
    const required = selectedCandidates.filter((candidate) => candidate.active || candidate.isHub)
    const optional = selectedCandidates.filter((candidate) => !candidate.active && !candidate.isHub)
    const budget = labelBudget(candidates.length, zoom, required.filter((candidate) => candidate.isHub).length, showAll)
    const allowed = showAll
      ? selectedCandidates
      : required.concat(optional.slice(0, Math.max(0, budget - required.length)))
    const occupied: LabelRect[] = []
    const nodeObstacles = allNodes.length <= 800 ? allNodes : []
    const gap = Math.max(5, 7 / Math.max(0.25, screenScale))
    const padding = Math.max(3, 4 / Math.max(0.25, screenScale))
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const candidate of allowed) {
      const fontSize = modeRef.current === '3d'
        ? Math.max(9, Math.min(15, 10.5 * Math.max(0.85, screenScale)))
        : Math.min(32, Math.max(9, 10.5 / Math.max(0.25, screenScale)))
      ctx.font = `${candidate.active || candidate.isHub ? 600 : 500} ${fontSize}px 'Space Grotesk', ui-sans-serif, system-ui, sans-serif`
      const text = labelText(candidate.node)
      const width = ctx.measureText(text).width
      const height = fontSize * 1.18
      const positions = [
        { x: candidate.x, y: candidate.y + candidate.radius + gap },
        { x: candidate.x, y: candidate.y - candidate.radius - gap - height },
        { x: candidate.x + candidate.radius + gap + width / 2, y: candidate.y - height / 2 },
        { x: candidate.x - candidate.radius - gap - width / 2, y: candidate.y - height / 2 },
        { x: candidate.x + candidate.radius + gap + width / 2, y: candidate.y + candidate.radius + gap },
        { x: candidate.x - candidate.radius - gap - width / 2, y: candidate.y + candidate.radius + gap },
      ]
      let placement: { x: number; y: number; rect: LabelRect } | null = null
      let fallbackPlacement: { x: number; y: number; rect: LabelRect } | null = null
      for (const position of positions) {
        const rect = { left: position.x - width / 2, top: position.y, right: position.x + width / 2, bottom: position.y + height }
        if (rect.right < bounds.minX || rect.left > bounds.maxX || rect.bottom < bounds.minY || rect.top > bounds.maxY) continue
        // Keep a usable position for the explicit "show all" mode. Dense
        // layouts can leave no collision-free slot, but that must not hide a
        // requested label.
        fallbackPlacement ??= { x: position.x, y: position.y, rect }
        if (occupied.some((other) => overlaps(rect, other, padding))) continue
        if (nodeObstacles.some((node) => node.x !== candidate.x && circleTouchesRect(node, rect, padding))) continue
        placement = { x: position.x, y: position.y, rect }
        break
      }
      if (!placement && showAll) placement = fallbackPlacement
      if (!placement) continue
      occupied.push(placement.rect)
      const nodeEdgeX = candidate.x
      const nodeEdgeY = candidate.y + (placement.y >= candidate.y ? candidate.radius : -candidate.radius)
      const labelEdgeY = placement.y >= candidate.y ? placement.rect.top : placement.rect.bottom
      if (Math.abs(placement.x - nodeEdgeX) > candidate.radius + gap * 0.5 || Math.abs(labelEdgeY - nodeEdgeY) > candidate.radius + gap * 0.5) {
        ctx.save()
        ctx.globalAlpha = candidate.active ? 0.5 : 0.22
        ctx.strokeStyle = candidate.isHub ? HUB_OUTLINE_COLOR : '#9aa4b8'
        ctx.lineWidth = modeRef.current === '3d' ? 0.7 : 0.7 / Math.max(0.25, screenScale)
        ctx.beginPath()
        ctx.moveTo(nodeEdgeX, nodeEdgeY)
        ctx.lineTo(placement.x, labelEdgeY)
        ctx.stroke()
        ctx.restore()
      }
      ctx.save()
      ctx.globalAlpha = candidate.active ? 1 : candidate.isHub ? 0.9 : 0.72
      ctx.lineWidth = modeRef.current === '3d' ? 3 : 3 / Math.max(0.25, screenScale)
      ctx.strokeStyle = 'rgba(255, 255, 255, .94)'
      ctx.strokeText(text, placement.x, placement.y)
      ctx.fillStyle = candidate.active ? '#1c2027' : '#555c68'
      ctx.fillText(text, placement.x, placement.y)
      ctx.restore()
    }
  }

  const draw3D = (ctx: CanvasRenderingContext2D, currentGraph: LayoutGraph, selected: GraphNode | undefined, hovered: GraphNode | null, nodeMap: Map<string, GraphNode>) => {
    const { nodes, links } = currentGraph
    const radius = boundaryRadius(nodes.length, 3)
    const hubIds = getHubIds(nodes, links)
    const renderSubset = getRenderSubset(currentGraph)
    const visibleNodes = renderSubset.nodes
    const dotScale = visualNodeScale(visibleNodes.length, nodes.length, viewRef.current.scale, hubIds.size)
    const showAllVisibleLabels = showAllLabelsRef.current || visibleNodes.length <= 12
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
    const visibleLinks: Array<{ source: GraphNode; target: GraphNode; sourcePoint: ReturnType<typeof project3D>; targetPoint: ReturnType<typeof project3D> }> = []
    for (const { edge } of renderSubset.links) {
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      if (!source || !target) continue
      const sourcePoint = projected.get(source)
      const targetPoint = projected.get(target)
      if (sourcePoint && targetPoint) visibleLinks.push({ source, target, sourcePoint, targetPoint })
    }
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
    const labelCandidates: LabelCandidate[] = []
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
      if (showLabelsRef.current) {
        labelCandidates.push({ node, x: point.x, y: point.y, radius, priority: labelPriority(node, active, isHub), active, isHub })
      }
    }
    drawPlacedLabels(
      ctx,
      labelCandidates,
      sortedNodes.map(({ node, point }) => ({ x: point.x, y: point.y, radius: visualNodeRadius(node, settingsRef.current, dotScale) * point.perspective * viewRef.current.scale })),
      { minX: 0, maxX: sizeRef.current.width, minY: 0, maxY: sizeRef.current.height },
      1,
      showAllVisibleLabels,
    )
  }

  const drawLargeGraphLabels = (ctx: CanvasRenderingContext2D, nodes: GraphNode[], hubIds: ReadonlySet<string>, selected: GraphNode | undefined, hovered: GraphNode | null, dotScale: number, showAllVisibleLabels: boolean) => {
    if (!showLabelsRef.current) return
    const candidates: LabelCandidate[] = []
    const allNodes: Array<{ x: number; y: number; radius: number }> = []
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue
      const active = node === selected || node === hovered
      const isHub = hubIds.has(node.id)
      const radius = visualNodeRadius(node, settingsRef.current, dotScale)
      allNodes.push({ x: node.x, y: node.y, radius })
      candidates.push({ node, x: node.x, y: node.y, radius, priority: labelPriority(node, active, isHub), active, isHub })
    }
    const view = viewRef.current
    drawPlacedLabels(
      ctx,
      candidates,
      allNodes,
      { minX: -view.x / view.scale, maxX: (sizeRef.current.width - view.x) / view.scale, minY: -view.y / view.scale, maxY: (sizeRef.current.height - view.y) / view.scale },
      view.scale,
      showAllVisibleLabels,
    )
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
    const showAllVisibleLabels = showAllLabelsRef.current || visibleNodes.length <= 12
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
    const labelCandidates: LabelCandidate[] = []
    for (const node of visibleNodes) {
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
      if (showLabelsRef.current) labelCandidates.push({ node, x: node.x, y: node.y, radius, priority: labelPriority(node, active, isHub), active, isHub })
    }
    if (renderLargeGraph) drawLargeGraphLabels(ctx, visibleNodes, hubIds, selected, hovered, dotScale, showAllVisibleLabels)
    else drawPlacedLabels(
      ctx,
      labelCandidates,
      visibleNodes.filter((node): node is GraphNode & { x: number; y: number } => node.x != null && node.y != null).map((node) => ({ x: node.x, y: node.y, radius: visualNodeRadius(node, settingsRef.current, dotScale) })),
      { minX: -view.x / view.scale, maxX: (width - view.x) / view.scale, minY: -view.y / view.scale, maxY: (height - view.y) / view.scale },
      view.scale,
      showAllVisibleLabels,
    )
    ctx.restore()
    if (nodes.length > 0 && activeGraphRef.current === graphRef.current && graphRenderedRef.current !== graphRef.current) {
      graphRenderedRef.current = graphRef.current
      graphRenderedCallbackRef.current?.(graphRef.current)
    }
  }
  drawRef.current = draw

  const exportSvg = () => {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
    const currentGraph = activeLayoutRef.current ?? graphRef.current
    if (!currentGraph.nodes.length) return

    // The viewport intentionally renders only a ranked subset for large maps.
    // Export from the active layout instead so the downloaded artwork always
    // contains every loaded node, connection, and article name.
    const nodes = currentGraph.nodes
    const links = currentGraph.links
    const nodeMap = new Map(nodes.map((node) => [node.id, node]))
    const hubIds = getHubIds(nodes, links)
    const dimension = modeRef.current === '3d' ? 3 : 2
    const fallbackRadius = Math.max(80, boundaryRadius(nodes.length, dimension))
    const currentView = viewRef.current
    const currentScale = Math.max(0.0001, currentView.scale)
    const points = new Map<string, { x: number; y: number; radius: number }>()

    nodes.forEach((node, index) => {
      let x = Number.isFinite(node.x) ? node.x as number : 0
      let y = Number.isFinite(node.y) ? node.y as number : 0
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        const angle = index * 2.399963229728653
        const distance = fallbackRadius * (0.35 + (index % 17) / 17 * 0.55)
        x = Math.cos(angle) * distance
        y = Math.sin(angle) * distance
      }
      if (modeRef.current === '3d') {
        const projected = project3D({ ...node, x, y, z: Number.isFinite(node.z) ? node.z : 0 })
        points.set(node.id, {
          x: (projected.x - currentView.x) / currentScale,
          y: (projected.y - currentView.y) / currentScale,
          radius: visualNodeRadius(node, settingsRef.current) * projected.perspective,
        })
      } else {
        points.set(node.id, { x, y, radius: visualNodeRadius(node, settingsRef.current) })
      }
    })

    const labelFontSize = 12
    const labelGap = 10
    const labels = nodes.map((node) => {
      const point = points.get(node.id) as { x: number; y: number; radius: number }
      const text = exportLabelText(node)
      // This estimate only expands the viewBox; SVG still lays out the text
      // using the actual font, so unusually wide glyphs remain unclipped.
      const estimatedWidth = Math.max(labelFontSize, text.length * 7.2)
      const x = point.x + point.radius + labelGap + estimatedWidth / 2
      const y = point.y
      return { node, point, text, estimatedWidth, x, y }
    })

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    const includeBounds = (x: number, y: number) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    for (const point of points.values()) {
      includeBounds(point.x - point.radius, point.y - point.radius)
      includeBounds(point.x + point.radius, point.y + point.radius)
    }
    for (const label of labels) {
      includeBounds(label.x - label.estimatedWidth / 2, label.y - labelFontSize * 0.7)
      includeBounds(label.x + label.estimatedWidth / 2, label.y + labelFontSize * 0.7)
    }
    if (!Number.isFinite(minX)) return
    const margin = 42
    minX -= margin; maxX += margin; minY -= margin; maxY += margin
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const getNode = (endpoint: string | GraphNode) => typeof endpoint === 'string' ? nodeMap.get(endpoint) : nodeMap.get(endpoint.id)
    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${svgNumber(width)}" height="${svgNumber(height)}" viewBox="${svgNumber(minX)} ${svgNumber(minY)} ${svgNumber(width)} ${svgNumber(height)}" role="img" aria-labelledby="wikigraph-title wikigraph-description">`,
      `<title id="wikigraph-title">WikiGraph — ${nodes.length.toLocaleString()} articles</title>`,
      `<desc id="wikigraph-description">Full-resolution Wikipedia article graph with ${links.length.toLocaleString()} connections and labels for every article.</desc>`,
      '<defs><marker id="wikigraph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 z" fill="#73777f" fill-opacity=".34" /></marker></defs>',
      `<rect x="${svgNumber(minX)}" y="${svgNumber(minY)}" width="${svgNumber(width)}" height="${svgNumber(height)}" fill="#fbfcfe" />`,
      '<g class="wikigraph-links" fill="none" stroke="#73777f" stroke-opacity=".28" stroke-width="1" stroke-linecap="round" marker-end="url(#wikigraph-arrow)">',
    ]
    for (const edge of links) {
      const source = getNode(edge.source)
      const target = getNode(edge.target)
      const sourcePoint = source ? points.get(source.id) : undefined
      const targetPoint = target ? points.get(target.id) : undefined
      if (!sourcePoint || !targetPoint) continue
      lines.push(`<line x1="${svgNumber(sourcePoint.x)}" y1="${svgNumber(sourcePoint.y)}" x2="${svgNumber(targetPoint.x)}" y2="${svgNumber(targetPoint.y)}" />`)
    }
    lines.push('</g>', '<g class="wikigraph-nodes">')
    for (const [nodeId, point] of points.entries()) {
      const graphNode = nodeMap.get(nodeId)
      if (!graphNode) continue
      const isHub = hubIds.has(graphNode.id)
      const color = colorResolverRef.current?.(graphNode) ?? graphNode.color ?? '#9aabf8'
      lines.push(`<circle data-node-id="${escapeSvgText(graphNode.id)}" cx="${svgNumber(point.x)}" cy="${svgNumber(point.y)}" r="${svgNumber(point.radius)}" fill="${escapeSvgText(color)}" stroke="${isHub ? HUB_OUTLINE_COLOR : 'rgba(28, 32, 39, .28)'}" stroke-width="${isHub ? '1.6' : '1'}" />`)
    }
    lines.push('</g>', `<g class="wikigraph-labels" font-family="Space Grotesk, sans-serif" font-size="${labelFontSize}" text-anchor="middle" dominant-baseline="central">`)
    for (const label of labels) {
      const isHub = hubIds.has(label.node.id)
      const labelX = label.x
      const labelStart = label.point.x + label.point.radius + 3
      lines.push(`<line x1="${svgNumber(label.point.x + label.point.radius)}" y1="${svgNumber(label.point.y)}" x2="${svgNumber(labelStart)}" y2="${svgNumber(label.y)}" stroke="${isHub ? HUB_OUTLINE_COLOR : '#9aa4b8'}" stroke-opacity=".34" stroke-width=".7" />`)
      lines.push(`<text data-node-label="${escapeSvgText(label.node.id)}" x="${svgNumber(labelX)}" y="${svgNumber(label.y)}" fill="#555c68" font-weight="${isHub ? '600' : '500'}" stroke="#fbfcfe" stroke-width="3" paint-order="stroke">${escapeSvgText(label.text)}</text>`)
    }
    lines.push('</g>', '</svg>')
    const blob = new Blob([lines.join('\n')], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `wikigraph-${new Date().toISOString().slice(0, 10)}.svg`
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

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
    exportSvg,
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
    repairNodeOverlaps(layoutGraph.nodes, dimensions, settings)
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
      repairNodeOverlaps(layoutGraph.nodes, dimensions, settingsRef.current)
      roundSimulationNodesF32(layoutGraph.nodes, dimensions)
      simulationTicks += 1
      if ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV && hostRef.current) {
        hostRef.current.dataset.physicsTicks = String(simulationTicks)
      }
      physicsTickCallbackRef.current?.(kineticEnergy(layoutGraph.nodes, dimensions))
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
            .strength(collisionStrength(settings))
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
          .force('collision', forceCollide<GraphNode>()
            .radius((node) => nodeRadius(node, settings) + settings.collisionPadding)
            .strength(collisionStrength(settings))
            .iterations(Math.max(1, Math.round(settings.collisionIterations))))
      }
      sim
        .force('boundary', boundaryForce(boundaryRadius(layoutGraph.nodes.length, dimensions), dimensions))
        // A collision pass samples positions once per tick. Keep a node from
        // travelling farther than its reserved collision radius so a strong
        // impulse cannot tunnel through a neighbour between samples.
        .force('velocity-limit', velocityLimitForce(
          dimensions,
          (node) => Math.max(1, nodeRadius(node as GraphNode, settings) + Math.max(0, settings.collisionPadding)),
        ))
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

  useEffect(() => { drawRef.current() }, [selectedId, showLabels, showAllLabels, visibleNodeIds])

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
    const links = activeLayoutRef.current?.links ?? graph.links
    // Rendering already resolves the visible subset and caches it by graph and
    // visibility-set identity. Reuse that list for pointer hit testing instead
    // of allocating a filtered array for every pointer-move event.
    const visibleNodes = getRenderSubset(activeLayoutRef.current ?? graph).nodes
    const hubIds = getHubIds(nodes, links)
    const dotScale = visualNodeScale(visibleNodes.length, nodes.length, viewRef.current.scale, hubIds.size)
    if (modeRef.current === '3d') {
      // The old implementation sorted every projected node to find the first
      // depth hit. A linear pass that keeps the shallowest matching node has
      // the same result, without allocating or sorting on every mouse move.
      let hitNode: GraphNode | undefined
      let nearestDepth = Infinity
      for (const node of visibleNodes) {
        const projected = project3D(node)
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue
        if (Math.hypot(projected.x - point.x, projected.y - point.y) > visualNodeRadius(node, settingsRef.current, dotScale) * projected.perspective * viewRef.current.scale + Math.max(4, 8 * viewRef.current.scale)) continue
        if (!hitNode || projected.depth < nearestDepth) {
          hitNode = node
          nearestDepth = projected.depth
        }
      }
      return hitNode
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
