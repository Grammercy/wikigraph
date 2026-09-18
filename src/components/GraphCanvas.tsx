import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  forceCenter,
  forceCollide,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'

export type GraphNode = SimulationNodeDatum & {
  id: string
  title?: string
  label?: string
  group?: string | number
  color?: string
  /** Link degree is also used as a lightweight article-importance signal. */
  inDegree?: number
  outDegree?: number
  articleSize?: number
  byteLength?: number
}

export type GraphLink = {
  source: string | GraphNode
  target: string | GraphNode
}

export type GraphData = { nodes: GraphNode[]; links: GraphLink[] }

export type GraphCanvasHandle = {
  fit: () => void
  resetView: () => void
}

export type GraphCanvasProps = {
  graph: GraphData
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
  hubDegreeThreshold: number
  unrelatedBaseStrength: number
  unrelatedHubStrength: number
  unrelatedDistance: number
  unrelatedInteractionBudget: number
  hubTerritoryBase: number
  hubTerritoryScale: number
  hubForceBase: number
  hubForceScale: number
  hubForceMax: number
  hubMaxNodes: number
  linkDistanceScale: number
  /** Exponent used by the link spring: squared by default, optionally cubic. */
  linkDistanceExponent: 2 | 3
  linkWeightFloor: number
  hubLinkDamping: number
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
  hubCharge: 520,
  chargeDistance: 480,
  articleSizeWeight: 0.45,
  articleMaxBytes: 2_000_000,
  articleDegreeCap: 56,
  hubDegreeReference: 60,
  hubDegreeThreshold: 10,
  unrelatedBaseStrength: 40,
  unrelatedHubStrength: 220,
  unrelatedDistance: 480,
  unrelatedInteractionBudget: 220_000,
  hubTerritoryBase: 360,
  hubTerritoryScale: 260,
  hubForceBase: 12,
  hubForceScale: 260,
  hubForceMax: 70,
  hubMaxNodes: 320,
  linkDistanceScale: 150_000,
  linkDistanceExponent: 3,
  linkWeightFloor: 0.02,
  hubLinkDamping: 0.24,
  collisionPadding: 10,
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

const articleDegree = (node: GraphNode) => Math.max(0, (node.inDegree ?? 0) + (node.outDegree ?? 0))
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
const hubRepulsionScore = (node: GraphNode, settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS) => {
  const degree = articleDegree(node)
  // The UI marks degree-10 articles as blue hubs. Calibrate the physics to
  // that same visible threshold instead of waiting until degree 2,500 before
  // the special force becomes meaningful.
  if (degree < settings.hubDegreeThreshold) return 0
  return Math.min(1, Math.log1p(degree) / Math.log1p(Math.max(1, settings.hubDegreeReference)))
}
// More connected articles are visually larger, with a cap so hubs never swallow
// nearby nodes. Keeping this in one helper also keeps hit testing/collision aligned.
const nodeRadius = (node: GraphNode, settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS) => {
  return (node.id.length > 18 ? 5 : 6) + articleImportance(node, settings) * 6
}
const LARGE_GRAPH_THRESHOLD = 2_000
const linkNode = (value: string | GraphNode, nodes: Map<string, GraphNode>) =>
  typeof value === 'string' ? nodes.get(value) : value

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

/**
 * A responsive, canvas-rendered force graph. `graph.nodes` are mutated by d3-force
 * (x/y/vx/vy/fx/fy), so callers should treat those fields as simulation state.
 */
const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { graph, selectedId, onSelect, onHover, onSimulationGuard, paused = false, className, getNodeColor, settings = DEFAULT_SIMULATION_SETTINGS },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const webglCanvasRef = useRef<HTMLCanvasElement>(null)
  const webglRef = useRef<WebGL2RenderingContext | null>(null)
  const webglProgramRef = useRef<WebGLProgram | null>(null)
  const webglBuffersRef = useRef<{ positions: WebGLBuffer; colors: WebGLBuffer } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const simulationRef = useRef<Simulation<GraphNode, undefined> | null>(null)
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 })
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 })
  const hoverRef = useRef<GraphNode | null>(null)
  const dragRef = useRef<{ node: GraphNode; offset: Point } | null>(null)
  const panRef = useRef<{ x: number; y: number; start: Point } | null>(null)
  const pausedRef = useRef(paused)
  const viewInitializedRef = useRef(false)
  // Keep the simulation and resize observer independent from React render identity.
  const graphRef = useRef(graph)
  const selectedIdRef = useRef(selectedId)
  const colorResolverRef = useRef(getNodeColor)
  const simulationGuardRef = useRef(onSimulationGuard)
  const settingsRef = useRef(settings)
  const drawRef = useRef<() => void>(() => undefined)
  const nodeMapRef = useRef<{ graph: GraphData; map: Map<string, GraphNode> } | null>(null)
  const lastWebglDrawRef = useRef(0)
  const webglGeometryRef = useRef({ positions: new Float32Array(0), colors: new Float32Array(0) })
  const largeTickTimerRef = useRef<number | null>(null)
  const manualTickRef = useRef<(() => void) | null>(null)
  graphRef.current = graph
  selectedIdRef.current = selectedId
  colorResolverRef.current = getNodeColor
  simulationGuardRef.current = onSimulationGuard
  settingsRef.current = settings
  pausedRef.current = paused

  const renderWebGL = (gl: WebGL2RenderingContext, nodes: GraphNode[], links: GraphLink[], selected: GraphNode | undefined, hovered: GraphNode | null, nodeMap: Map<string, GraphNode>) => {
    const program = webglProgramRef.current
    const buffers = webglBuffersRef.current
    if (!program || !buffers) return
    const { width, height, dpr } = sizeRef.current
    const view = viewRef.current
    const clipX = (x: number) => ((x * view.scale + view.x) / width) * 2 - 1
    const clipY = (y: number) => 1 - ((y * view.scale + view.y) / height) * 2
    const stride = links.length > 250_000 ? Math.ceil(links.length / 250_000) : 1
    const maxVertices = Math.ceil(links.length / stride) * 2 + nodes.length
    const geometry = webglGeometryRef.current
    if (geometry.positions.length < maxVertices * 2) geometry.positions = new Float32Array(maxVertices * 2)
    if (geometry.colors.length < maxVertices * 4) geometry.colors = new Float32Array(maxVertices * 4)
    const positions = geometry.positions
    const colors = geometry.colors
    let positionCursor = 0
    let colorCursor = 0
    const pushVertex = (x: number, y: number) => {
      positions[positionCursor++] = clipX(x)
      positions[positionCursor++] = clipY(y)
    }
    const pushColor = (color: string, alpha: number) => {
      const hex = color.startsWith('#') ? color.slice(1) : ''
      const value = hex.length === 6 ? Number.parseInt(hex, 16) : 0x73777f
      colors[colorCursor++] = ((value >> 16) & 255) / 255
      colors[colorCursor++] = ((value >> 8) & 255) / 255
      colors[colorCursor++] = (value & 255) / 255
      colors[colorCursor++] = alpha
    }
    for (let index = 0; index < links.length; index += stride) {
      const edge = links[index]
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      if (!source || !target || source.x == null || source.y == null || target.x == null || target.y == null) continue
      const related = source === selected || target === selected
      pushVertex(source.x, source.y); pushVertex(target.x, target.y)
      pushColor('#254fef', related ? 0.72 : 0.16); pushColor('#254fef', related ? 0.72 : 0.16)
    }
    const lineVertexCount = positionCursor / 2
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue
      pushVertex(node.x, node.y)
      const active = node === selected || node === hovered
      const color = active || node === selected ? '#254fef' : (colorResolverRef.current?.(node) ?? node.color ?? '#9aabf8')
      pushColor(color, 1)
    }
    gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr))
    gl.clearColor(1, 1, 1, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.positions)
    gl.bufferData(gl.ARRAY_BUFFER, positions.subarray(0, positionCursor), gl.DYNAMIC_DRAW)
    const positionLocation = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(positionLocation); gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.colors)
    gl.bufferData(gl.ARRAY_BUFFER, colors.subarray(0, colorCursor), gl.DYNAMIC_DRAW)
    const colorLocation = gl.getAttribLocation(program, 'a_color')
    gl.enableVertexAttribArray(colorLocation); gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0)
    gl.lineWidth(1)
    gl.drawArrays(gl.LINES, 0, lineVertexCount)
    const nodeVertexCount = positionCursor / 2 - lineVertexCount
    const pointSize = gl.getUniformLocation(program, 'u_point_size')
    gl.uniform1f(pointSize, Math.max(3, Math.min(24, 8 * view.scale * dpr)))
    gl.drawArrays(gl.POINTS, lineVertexCount, nodeVertexCount)
  }

  const draw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height, dpr } = sizeRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const view = viewRef.current
    ctx.save()
    ctx.translate(view.x, view.y)
    ctx.scale(view.scale, view.scale)
    const currentGraph = graphRef.current
    const nodes = currentGraph.nodes
    const largeGraph = nodes.length > LARGE_GRAPH_THRESHOLD
    const cachedNodeMap = nodeMapRef.current?.graph === currentGraph
      ? nodeMapRef.current.map
      : new Map(nodes.map((node) => [node.id, node]))
    nodeMapRef.current = { graph: currentGraph, map: cachedNodeMap }
    const nodeMap = cachedNodeMap
    const selected = selectedIdRef.current ? nodeMap.get(selectedIdRef.current) : undefined
    const hovered = hoverRef.current
    if (largeGraph && webglRef.current && webglProgramRef.current) {
      const now = typeof performance === 'undefined' ? Date.now() : performance.now()
      if (now - lastWebglDrawRef.current < 32) {
        ctx.restore()
        return
      }
      lastWebglDrawRef.current = now
      renderWebGL(webglRef.current, nodes, currentGraph.links, selected, hovered, nodeMap)
      // The overlay was saved/transformed above. Restore it before returning so
      // repeated WebGL frames do not accumulate canvas state or leave stale
      // interaction pixels behind.
      ctx.restore()
      return
    }
    const linkStride = largeGraph ? Math.max(1, Math.ceil(currentGraph.links.length / 100_000)) : 1

    ctx.lineCap = 'round'
    for (let edgeIndex = 0; edgeIndex < currentGraph.links.length; edgeIndex += 1) {
      const edge = currentGraph.links[edgeIndex]
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      if (!source || !target || source.x == null || target.x == null || source.y == null || target.y == null) continue
      const isRelated = source === selected || target === selected
      if (largeGraph && !isRelated && edgeIndex % linkStride !== 0) continue
      ctx.strokeStyle = isRelated ? 'rgba(37, 79, 239, .72)' : largeGraph ? 'rgba(115, 119, 127, .16)' : 'rgba(115, 119, 127, .22)'
      ctx.lineWidth = isRelated ? 1.7 : largeGraph ? 0.65 : 1
      ctx.beginPath()
      ctx.moveTo(source.x, source.y)
      ctx.lineTo(target.x, target.y)
      ctx.stroke()
      if (largeGraph && !isRelated) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.hypot(dx, dy) || 1
      const ux = dx / distance
      const uy = dy / distance
      const tip = { x: target.x - ux * (nodeRadius(target, settingsRef.current) + 2), y: target.y - uy * (nodeRadius(target, settingsRef.current) + 2) }
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
    ctx.font = '500 11px Inter, ui-sans-serif, system-ui, sans-serif'
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue
      const radius = nodeRadius(node, settingsRef.current)
      const active = node === selected || node === hovered
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
      ctx.strokeStyle = node === selected ? '#254fef' : 'rgba(28, 32, 39, .28)'
      ctx.lineWidth = node === selected ? 2 : 1
      ctx.stroke()
      const text = node.label ?? node.title ?? node.id
      // Labels and arrowheads are deliberately level-of-detail features. At
      // several thousand nodes the graph remains interactive only when text is
      // limited to the hovered/selected neighborhood.
      if ((!largeGraph && view.scale > 0.58) || active || node === selected) {
        ctx.fillStyle = node === selected ? '#1c2027' : '#555c68'
        ctx.fillText(text.length > 30 ? `${text.slice(0, 28)}…` : text, node.x, node.y + radius + 5)
      }
    }
    ctx.restore()
  }
  drawRef.current = draw

  useImperativeHandle(ref, () => ({
    fit: () => {
      const bounds = graphBounds(graph.nodes)
      if (!bounds) return
      const { width, height } = sizeRef.current
      const scale = Math.max(0.2, Math.min(2.2, 0.86 * Math.min(width / Math.max(1, bounds.maxX - bounds.minX + 80), height / Math.max(1, bounds.maxY - bounds.minY + 80))))
      viewRef.current = { scale, x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale, y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale }
      drawRef.current()
    },
    resetView: () => {
      viewRef.current = { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2, scale: 1 }
      drawRef.current()
    },
  }), [graph.nodes])

  useEffect(() => {
    const canvas = webglCanvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true })
    if (!gl) return
    const vertex = gl.createShader(gl.VERTEX_SHADER)
    const fragment = gl.createShader(gl.FRAGMENT_SHADER)
    if (!vertex || !fragment) return
    gl.shaderSource(vertex, '#version 300 es\nin vec2 a_position; in vec4 a_color; uniform float u_point_size; out vec4 v_color; void main(){gl_Position=vec4(a_position,0.0,1.0); gl_PointSize=u_point_size; v_color=a_color;}')
    gl.shaderSource(fragment, '#version 300 es\nprecision mediump float; in vec4 v_color; out vec4 outColor; void main(){outColor=v_color;}')
    gl.compileShader(vertex); gl.compileShader(fragment)
    if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS) || !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) return
    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    const positions = gl.createBuffer(); const colors = gl.createBuffer()
    if (!positions || !colors) return
    webglRef.current = gl; webglProgramRef.current = program; webglBuffersRef.current = { positions, colors }
    drawRef.current()
    return () => { webglRef.current = null; webglProgramRef.current = null; webglBuffersRef.current = null }
  }, [])

  useEffect(() => {
    const { width, height } = sizeRef.current
    if (width > 1 && height > 1) viewRef.current = { x: width / 2, y: height / 2, scale: 1 }
    const largeGraph = graph.nodes.length > LARGE_GRAPH_THRESHOLD
    // Keep every edge available for rendering, but cap the per-tick attraction
    // work in large maps. The representative stride preserves the overall
    // topology while preventing a dense dump tier from freezing the tab.
    const attractionLinks = largeGraph && graph.links.length > 50_000
      ? graph.links.filter((_, index) => index % Math.ceil(graph.links.length / 50_000) === 0)
      : graph.links
    const sim = forceSimulation(graph.nodes)
      // Hubs need more breathing room: their repulsion grows with degree, but is
      // capped to keep a single highly-linked page from dominating the whole map.
      .force('charge', forceManyBody<GraphNode>()
        // The cubic hub term makes high-degree pages repel the whole graph
        // strongly enough to expose topic islands, while the dedicated
        // hub-repulsion force below handles hub-to-hub separation directly.
        .strength((node) => -settings.baseCharge - articleImportance(node, settings) * settings.articleImportanceCharge - hubRepulsionScore(node, settings) ** 3 * settings.hubCharge)
        .distanceMax(settings.chargeDistance))
      // A direct link is allowed to pull its endpoints together, but a nearby
      // pair with no loaded link in either direction receives an extra push.
      // This makes disconnected topic islands separate instead of relying on
      // the same generic charge for every relationship.
      .force('unrelated-repulsion', unrelatedRepulsion(graph.links, graph.nodes, largeGraph, settings))
      .force('hub-repulsion', hubRepulsion(largeGraph, settings))
      .force('collision', forceCollide<GraphNode>().radius((node) => nodeRadius(node, settings) + (largeGraph ? Math.max(5, settings.collisionPadding / 2) : settings.collisionPadding)).iterations(largeGraph ? Math.max(1, Math.round(settings.collisionIterations / 2)) : Math.max(1, Math.round(settings.collisionIterations))))
      .force('center', forceCenter<GraphNode>(0, 0).strength(settings.centerStrength))
      // The arrow remains directed in the renderer, but the physical spring is
      // symmetric: both articles move toward one another for every link.
      // Applying equal-and-opposite velocity keeps the map stable and prevents
      // a one-way link from making its target appear artificially anchored.
      .force('link-attraction', symmetricAttraction(attractionLinks, graph.nodes, settings))
      .velocityDecay(settings.velocityDecay)
      .alphaDecay(settings.alphaDecay)
      .alphaMin(settings.alphaMin)
      .alphaTarget(settings.alphaTarget)
    // D3 starts at alpha=1. That is too hot for the unbounded squared/cubic
    // spring, so use a bounded starting temperature and cool toward the
    // configured target. This gives the layout enough movement to leave a
    // shallow high-energy arrangement without creating a runaway first tick.
    const initialTemperature = Number.isFinite(settings.initialTemperature)
      ? Math.max(settings.alphaMin, Math.min(1, settings.initialTemperature))
      : 0.8
    sim.alpha(initialTemperature)
    simulationRef.current = sim
    let framePending = false
    let invalidState = false
    let simulationTicks = 0
    const protectNumerics = largeGraph || settings.linkDistanceScale < 10_000 || settings.linkDistanceExponent > 2
    sim.on('tick', () => {
      simulationTicks += 1
      if (!invalidState && protectNumerics && (simulationTicks <= 120 || simulationTicks % 32 === 0)) {
        const numericLimit = 1_000_000
        const invalid = graph.nodes.find((node) => !Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.vx) || !Number.isFinite(node.vy)
          || Math.abs(node.x ?? 0) > numericLimit || Math.abs(node.y ?? 0) > numericLimit
          || Math.abs(node.vx ?? 0) > numericLimit || Math.abs(node.vy ?? 0) > numericLimit)
        if (invalid) {
          invalidState = true
          sim.stop()
          invalid.x = Number.isFinite(invalid.x) && Math.abs(invalid.x as number) <= numericLimit ? invalid.x : 0
          invalid.y = Number.isFinite(invalid.y) && Math.abs(invalid.y as number) <= numericLimit ? invalid.y : 0
          invalid.vx = Number.isFinite(invalid.vx) && Math.abs(invalid.vx as number) <= numericLimit ? invalid.vx : 0
          invalid.vy = Number.isFinite(invalid.vy) && Math.abs(invalid.vy as number) <= numericLimit ? invalid.vy : 0
          simulationGuardRef.current?.()
          drawRef.current()
          return
        }
      }
      if (!largeGraph) { drawRef.current(); return }
      if (framePending) return
      framePending = true
      requestAnimationFrame(() => { framePending = false; drawRef.current() })
    })
    if (largeGraph) {
      // A d3 timer can monopolize the main thread when a dense tier needs a
      // long force tick. Run one tick, yield to input/rendering, then continue
      // at a bounded cadence so the page remains interruptible.
      sim.stop()
      const tickDelay = Math.min(250, Math.max(50, Math.round(graph.nodes.length / 500)))
      const runLargeTick = () => {
        if (pausedRef.current || invalidState) return
        sim.tick()
        if (!pausedRef.current && !invalidState) largeTickTimerRef.current = window.setTimeout(runLargeTick, tickDelay)
      }
      manualTickRef.current = runLargeTick
      if (!pausedRef.current) largeTickTimerRef.current = window.setTimeout(runLargeTick, 0)
    } else if (pausedRef.current) sim.stop()
    return () => {
      sim.stop()
      if (largeTickTimerRef.current != null) window.clearTimeout(largeTickTimerRef.current)
      largeTickTimerRef.current = null
      manualTickRef.current = null
      simulationRef.current = null
    }
  }, [graph, settings])

  useEffect(() => { drawRef.current() }, [selectedId])

  useEffect(() => {
    const simulation = simulationRef.current
    simulation?.alphaTarget(paused ? 0 : settings.alphaTarget)
    if (paused) {
      simulation?.stop()
      if (largeTickTimerRef.current != null) window.clearTimeout(largeTickTimerRef.current)
      largeTickTimerRef.current = null
    } else if (manualTickRef.current) {
      simulation?.stop()
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
      const webglCanvas = webglCanvasRef.current
      if (webglCanvas) { webglCanvas.width = Math.round(rect.width * dpr); webglCanvas.height = Math.round(rect.height * dpr); webglCanvas.style.width = `${rect.width}px`; webglCanvas.style.height = `${rect.height}px` }
      if (!viewInitializedRef.current) {
        viewRef.current = { x: rect.width / 2, y: rect.height / 2, scale: 1 }
        viewInitializedRef.current = true
      }
      canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`; drawRef.current()
    }
    resize()
    const observer = new ResizeObserver(resize); observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const localPoint = (event: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }): Point => {
    const rect = event.currentTarget.getBoundingClientRect(); const view = viewRef.current
    return { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale }
  }
  const hit = (point: Point) => graph.nodes.find((node) => node.x != null && node.y != null && Math.hypot((node.x as number) - point.x, (node.y as number) - point.y) <= (nodeRadius(node, settingsRef.current) + 7) / viewRef.current.scale)

  return <div ref={hostRef} className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
    <canvas ref={webglCanvasRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, display: graph.nodes.length > LARGE_GRAPH_THRESHOLD ? 'block' : 'none', width: '100%', height: '100%', pointerEvents: 'none' }} />
    <canvas ref={canvasRef} aria-label="Wikipedia article graph" style={{ position: 'relative', display: 'block', width: '100%', height: '100%', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none', background: 'transparent' }}
      onPointerDown={(event) => { const point = localPoint(event); const node = hit(point); event.currentTarget.setPointerCapture(event.pointerId); if (node) { dragRef.current = { node, offset: { x: (node.x as number) - point.x, y: (node.y as number) - point.y } }; node.fx = node.x; node.fy = node.y } else panRef.current = { x: viewRef.current.x, y: viewRef.current.y, start: { x: event.clientX, y: event.clientY } } }}
      onPointerMove={(event) => { const point = localPoint(event); const drag = dragRef.current; const node = drag?.node; if (node && drag) { node.fx = point.x + drag.offset.x; node.fy = point.y + drag.offset.y; if (!pausedRef.current) simulationRef.current?.alpha(0.12).restart(); draw(); return } const pan = panRef.current; if (pan) { viewRef.current.x = pan.x + event.clientX - pan.start.x; viewRef.current.y = pan.y + event.clientY - pan.start.y; draw(); return } const next = hit(point) ?? null; if (next !== hoverRef.current) { hoverRef.current = next; onHover?.(next); draw() } }}
      onPointerUp={(event) => { const drag = dragRef.current; if (drag) { drag.node.fx = null; drag.node.fy = null; onSelect?.(drag.node) } dragRef.current = null; panRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); draw() }}
      onPointerCancel={() => { dragRef.current = null; panRef.current = null }}
      onPointerLeave={() => { if (!dragRef.current && hoverRef.current) { hoverRef.current = null; onHover?.(null); draw() } }}
      onWheel={(event) => { event.preventDefault(); const before = localPoint(event); const factor = Math.max(.75, Math.min(1.25, Math.exp(-event.deltaY * .001))); const view = viewRef.current; const rect = event.currentTarget.getBoundingClientRect(); view.scale = Math.max(.18, Math.min(4, view.scale * factor)); view.x = event.clientX - rect.left - before.x * view.scale; view.y = event.clientY - rect.top - before.y * view.scale; draw() }}
      tabIndex={0}
      role="application"
      onKeyDown={(event) => { if (event.key === '+' || event.key === '=') { event.preventDefault(); viewRef.current.scale = Math.min(4, viewRef.current.scale * 1.15); draw() } else if (event.key === '-') { event.preventDefault(); viewRef.current.scale = Math.max(.18, viewRef.current.scale / 1.15); draw() } else if (event.key === '0') { event.preventDefault(); viewRef.current = { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2, scale: 1 }; draw() } else if (event.key.toLowerCase() === 'f') { event.preventDefault(); const bounds = graphBounds(graphRef.current.nodes); if (bounds) { const { width, height } = sizeRef.current; const scale = Math.max(.2, Math.min(2.2, .86 * Math.min(width / Math.max(1, bounds.maxX - bounds.minX + 80), height / Math.max(1, bounds.maxY - bounds.minY + 80)))); viewRef.current = { scale, x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale, y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale }; draw() } } }} />
  </div>
})

function pairKey(first: string, second: string) {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`
}

/**
 * Adds relationship-aware separation on top of d3's Barnes–Hut charge. A
 * spatial grid keeps the exact unlinked-pair check local; the interaction
 * budget and rotating traversal keep dense 25k-node tiers responsive.
 */
function unrelatedRepulsion(links: GraphLink[], initialNodes: GraphNode[], largeGraph: boolean, settings: GraphSimulationSettings) {
  const relatedLinkBudget = largeGraph ? 250_000 : Number.POSITIVE_INFINITY
  let orderedNodes = initialNodes
  let nodeOrder = new Map<GraphNode, number>()
  let relatedPairs = new Set<string>()
  let tickIndex = 0
  const force = (alpha: number) => {
    const cellSize = largeGraph ? 240 : 200
    const maxDistance = largeGraph ? Math.min(settings.unrelatedDistance, 480) : Math.min(settings.unrelatedDistance, 420)
    const cellRadius = Math.ceil(maxDistance / cellSize)
    const cells = new Map<string, GraphNode[]>()
    for (const node of orderedNodes) {
      if (node.x == null || node.y == null || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`
      const bucket = cells.get(key)
      if (bucket) bucket.push(node)
      else cells.set(key, [node])
    }

    let examinedPairs = 0
    const interactionBudget = orderedNodes.length < LARGE_GRAPH_THRESHOLD
      ? Number.POSITIVE_INFINITY
      : largeGraph ? settings.unrelatedInteractionBudget : settings.unrelatedInteractionBudget * 1.45
    const start = orderedNodes.length ? tickIndex++ % orderedNodes.length : 0
    outer: for (let visited = 0; visited < orderedNodes.length; visited += 1) {
      const sourceIndex = (start + visited) % orderedNodes.length
      const source = orderedNodes[sourceIndex]
      if (source.x == null || source.y == null || !Number.isFinite(source.x) || !Number.isFinite(source.y)) continue
      const sourceCellX = Math.floor(source.x / cellSize)
      const sourceCellY = Math.floor(source.y / cellSize)
      for (let cellX = sourceCellX - cellRadius; cellX <= sourceCellX + cellRadius; cellX += 1) {
        for (let cellY = sourceCellY - cellRadius; cellY <= sourceCellY + cellRadius; cellY += 1) {
          const bucket = cells.get(`${cellX},${cellY}`)
          if (!bucket) continue
          for (const target of bucket) {
            examinedPairs += 1
            if (examinedPairs > interactionBudget) break outer
            const targetIndex = nodeOrder.get(target)
            if (targetIndex == null || targetIndex <= sourceIndex) continue
            if (relatedPairs.has(pairKey(source.id, target.id))) continue
            let dx = source.x - (target.x as number)
            let dy = source.y - (target.y as number)
            let distance = Math.hypot(dx, dy)
            if (distance < 0.001) {
              const angle = ((sourceIndex * 7919 + targetIndex * 104729) % 360) * Math.PI / 180
              dx = Math.cos(angle)
              dy = Math.sin(angle)
              distance = 1
            }
            if (distance > maxDistance) continue
            const falloff = 1 - distance / maxDistance
            const hubBoost = 0.6 + 1.4 * Math.max(hubRepulsionScore(source, settings), hubRepulsionScore(target, settings))
            const magnitude = Math.min(14, ((settings.unrelatedBaseStrength + settings.unrelatedHubStrength * hubBoost) / Math.max(28, distance)) * falloff) * alpha
            const vx = dx / distance * magnitude
            const vy = dy / distance * magnitude
            source.vx = (source.vx ?? 0) + vx
            source.vy = (source.vy ?? 0) + vy
            target.vx = (target.vx ?? 0) - vx
            target.vy = (target.vy ?? 0) - vy
          }
        }
      }
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    orderedNodes = [...simulationNodes]
      .sort((a, b) => articleDegree(b) - articleDegree(a) || a.id.localeCompare(b.id))
    nodeOrder = new Map(orderedNodes.map((node, index) => [node, index]))
    const byId = new Map(orderedNodes.map((node) => [node.id, node]))
    relatedPairs = new Set<string>()
    const relatedLinks = links.length > relatedLinkBudget
      ? links.filter((_, index) => index % Math.ceil(links.length / relatedLinkBudget) === 0)
      : links
    for (const link of relatedLinks) {
      const source = linkNode(link.source, byId)
      const target = linkNode(link.target, byId)
      if (source && target && source !== target) relatedPairs.add(pairKey(source.id, target.id))
    }
  }
  return force
}

function symmetricAttraction(links: GraphLink[], nodes: GraphNode[], settings: GraphSimulationSettings) {
  // A force that grows with distance²/³ is useful for making long links
  // noticeable, but it is not a stable spring by itself. Once a node drifts
  // far enough away, an uncapped impulse can overwhelm velocity decay and
  // launch the whole layout into non-finite coordinates. Keep the selected
  // curve while giving every node a finite per-tick impulse budget.
  // Keep the safety ceiling above ordinary squared-link impulses while
  // preventing a small distance scale from injecting a destabilizing kick.
  const maxBaseImpulse = 256
  const maxNodeImpulse = 1_024
  const forceDistanceLimit = 1_024
  let resolved: Array<[GraphNode, GraphNode, number]> = []
  const impulses = new Map<GraphNode, Point>()
  const force = (alpha: number) => {
    impulses.clear()
    const maxImpulse = maxNodeImpulse * Math.max(0, alpha)
    for (const [source, target, weight] of resolved) {
      if (source.x == null || target.x == null || source.y == null || target.y == null) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        source.vx = 0; source.vy = 0; target.vx = 0; target.vy = 0
        continue
      }
      const distance = Math.hypot(dx, dy) || 1
      const safeDistance = Math.min(distance, forceDistanceLimit)
      const exponent = settings.linkDistanceExponent === 3 ? 3 : 2
      const distanceScale = Number.isFinite(settings.linkDistanceScale)
        ? Math.max(1, settings.linkDistanceScale)
        : DEFAULT_SIMULATION_SETTINGS.linkDistanceScale
      // Cap the base impulse before applying the edge weight. `resolved`
      // retains the endpoint-degree weighting, while the aggregate cap below
      // bounds the total impulse received by a high-degree node.
      const baseImpulse = Math.min(
        maxBaseImpulse,
        Math.pow(safeDistance, exponent) / distanceScale * Math.max(0, alpha),
      )
      const pullMagnitude = baseImpulse * weight
      if (!Number.isFinite(pullMagnitude)) {
        continue
      }
      const pullX = dx / distance * pullMagnitude
      const pullY = dy / distance * pullMagnitude

      // Accumulate equal-and-opposite impulses first so link direction remains
      // semantic rather than anchoring the target. The aggregate safety cap is
      // applied only after all incident links have been collected.
      const sourceImpulse = impulses.get(source) ?? { x: 0, y: 0 }
      sourceImpulse.x += pullX
      sourceImpulse.y += pullY
      impulses.set(source, sourceImpulse)
      const targetImpulse = impulses.get(target) ?? { x: 0, y: 0 }
      targetImpulse.x -= pullX
      targetImpulse.y -= pullY
      impulses.set(target, targetImpulse)
    }
    for (const [node, impulse] of impulses) {
      const magnitude = Math.hypot(impulse.x, impulse.y)
      if (!Number.isFinite(magnitude) || magnitude < Number.EPSILON) continue
      const scale = Math.min(1, maxImpulse / magnitude)
      node.vx = (node.vx ?? 0) + impulse.x * scale
      node.vy = (node.vy ?? 0) + impulse.y * scale
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    const map = new Map(nodes.map((node) => [node.id, node]))
    const candidates = links.flatMap((link) => {
      const source = linkNode(link.source, map)
      const target = linkNode(link.target, map)
      return source && target ? [[source, target] as [GraphNode, GraphNode]] : []
    })
    // Weight by both endpoint degrees. A high-indegree hub should not collect
    // one full-strength spring from every low-degree article and collapse the
    // map into a shared barycenter. Hub-to-hub links still pull, but their
    // spring is deliberately softer so the strong hub-territory force can
    // separate them.
    resolved = candidates.map(([source, target]) => {
      const sourceDegree = Math.max(1, articleDegree(source))
      const targetDegree = Math.max(1, articleDegree(target))
      const degreeWeight = Math.max(settings.linkWeightFloor, 1 / Math.sqrt(sourceDegree * targetDegree))
      const bothHubs = hubRepulsionScore(source, settings) > 0 && hubRepulsionScore(target, settings) > 0
      const hubDamping = bothHubs ? settings.hubLinkDamping : 1
      return [source, target, Math.max(0, degreeWeight * Math.max(0, hubDamping))]
    })
    void simulationNodes
  }
  return force
}

/**
 * Extra force for structural hubs. d3's many-body force is excellent at
 * scaling to large graphs, but its per-node charge cannot express the desired
 * "hub versus hub" boundary. We compare only a capped, degree-sorted hub set
 * and give every pair a preferred territory radius.
 */
function hubRepulsion(largeGraph: boolean, settings: GraphSimulationSettings) {
  let hubs: GraphNode[] = []
  const force = (alpha: number) => {
    const maxHubDistance = settings.hubTerritoryBase + settings.hubTerritoryScale + 100
    for (let sourceIndex = 0; sourceIndex < hubs.length; sourceIndex += 1) {
      const source = hubs[sourceIndex]
      if (source.x == null || source.y == null) continue
      const sourceScore = hubRepulsionScore(source, settings)
      for (let targetIndex = sourceIndex + 1; targetIndex < hubs.length; targetIndex += 1) {
        const target = hubs[targetIndex]
        if (target.x == null || target.y == null) continue
        const targetScore = hubRepulsionScore(target, settings)
        const sourceX = source.x as number
        const sourceY = source.y as number
        let dx = sourceX - (target.x as number)
        let dy = sourceY - (target.y as number)
        let distance = Math.hypot(dx, dy)
        // D3 can initialize multiple nodes at the same coordinate. A stable
        // pair-specific direction avoids a zero vector without adding jitter.
        if (distance < 0.001) {
          const angle = ((sourceIndex * 92821 + targetIndex * 68917) % 360) * Math.PI / 180
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          distance = 1
        }
        const pairScore = Math.pow(sourceScore * targetScore, 1.2)
        const preferredDistance = Math.min(maxHubDistance, settings.hubTerritoryBase + settings.hubTerritoryScale * ((sourceScore + targetScore) / 2))
        if (distance >= preferredDistance) continue
        const deficit = 1 - distance / preferredDistance
        // This is intentionally much larger than the incident-link spring for
        // visible hubs. It creates an exclusion territory, not just a small
        // nudge, while the cap keeps the simulation finite at alpha=1.
        const magnitude = Math.min(settings.hubForceMax, (settings.hubForceBase + settings.hubForceScale * pairScore) * deficit) * alpha
        const vx = dx / distance * magnitude
        const vy = dy / distance * magnitude
        source.vx = (source.vx ?? 0) + vx
        source.vy = (source.vy ?? 0) + vy
        target.vx = (target.vx ?? 0) - vx
        target.vy = (target.vy ?? 0) - vy
      }
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    const maxHubs = largeGraph ? settings.hubMaxNodes : Math.round(settings.hubMaxNodes * 0.8)
    hubs = [...simulationNodes]
      .filter((node) => hubRepulsionScore(node, settings) > 0)
      .sort((a, b) => articleDegree(b) - articleDegree(a) || a.id.localeCompare(b.id))
      .slice(0, maxHubs)
  }
  return force
}

export default GraphCanvas
