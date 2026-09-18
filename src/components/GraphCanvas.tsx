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
  paused?: boolean
  className?: string
  /** Optional node color resolver, useful when groups are domain-specific. */
  getNodeColor?: (node: GraphNode) => string
}

type Point = { x: number; y: number }
type View = { x: number; y: number; scale: number }

const articleDegree = (node: GraphNode) => Math.max(0, (node.inDegree ?? 0) + (node.outDegree ?? 0))
const articleBytes = (node: GraphNode) => {
  const value = node.articleSize ?? node.byteLength ?? 0
  return Number.isFinite(value) && value > 0 ? value : 0
}
const articleImportance = (node: GraphNode) => {
  const degree = Math.min(articleDegree(node), 56)
  // Log scaling prevents unusually long articles from overwhelming the graph.
  const bytes = Math.min(Math.max(articleBytes(node), 0), 2_000_000)
  return Math.min(1, Math.log1p(bytes) / Math.log1p(2_000_000)) * 0.45 + Math.sqrt(degree / 56) * 0.55
}
// Degree is intentionally normalized separately from visual importance. A
// page can be a small article but still be a structural hub, and those hubs
// need to create a much stronger boundary around other structural hubs.
const hubRepulsionScore = (node: GraphNode) => {
  const degree = articleDegree(node)
  return Math.min(1, Math.log1p(degree) / Math.log1p(2_500))
}
// More connected articles are visually larger, with a cap so hubs never swallow
// nearby nodes. Keeping this in one helper also keeps hit testing/collision aligned.
const nodeRadius = (node: GraphNode) => {
  return (node.id.length > 18 ? 5 : 6) + articleImportance(node) * 6
}
const LARGE_GRAPH_THRESHOLD = 2_000
const linkNode = (value: string | GraphNode, nodes: Map<string, GraphNode>) =>
  typeof value === 'string' ? nodes.get(value) : value

/**
 * A responsive, canvas-rendered force graph. `graph.nodes` are mutated by d3-force
 * (x/y/vx/vy/fx/fy), so callers should treat those fields as simulation state.
 */
const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { graph, selectedId, onSelect, onHover, paused = false, className, getNodeColor },
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
  const drawRef = useRef<() => void>(() => undefined)
  graphRef.current = graph
  selectedIdRef.current = selectedId
  colorResolverRef.current = getNodeColor
  pausedRef.current = paused

  const renderWebGL = (gl: WebGL2RenderingContext, nodes: GraphNode[], links: GraphLink[], selected: GraphNode | undefined, hovered: GraphNode | null, nodeMap: Map<string, GraphNode>) => {
    const program = webglProgramRef.current
    const buffers = webglBuffersRef.current
    if (!program || !buffers) return
    const { width, height, dpr } = sizeRef.current
    const view = viewRef.current
    const toClip = (x: number, y: number) => [((x * view.scale + view.x) / width) * 2 - 1, 1 - ((y * view.scale + view.y) / height) * 2]
    const positions: number[] = []
    const colors: number[] = []
    const pushColor = (color: string, alpha: number) => {
      const hex = color.startsWith('#') ? color.slice(1) : ''
      const value = hex.length === 6 ? Number.parseInt(hex, 16) : 0x73777f
      colors.push(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, alpha)
    }
    const stride = links.length > 250_000 ? Math.ceil(links.length / 250_000) : 1
    for (let index = 0; index < links.length; index += stride) {
      const edge = links[index]
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      if (!source || !target || source.x == null || source.y == null || target.x == null || target.y == null) continue
      const related = source === selected || target === selected
      positions.push(...toClip(source.x, source.y), ...toClip(target.x, target.y))
      pushColor('#254fef', related ? 0.72 : 0.16); pushColor('#254fef', related ? 0.72 : 0.16)
    }
    const lineVertexCount = positions.length / 2
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue
      positions.push(...toClip(node.x, node.y))
      const active = node === selected || node === hovered
      const color = active || node === selected ? '#254fef' : (colorResolverRef.current?.(node) ?? node.color ?? '#9aabf8')
      pushColor(color, 1)
    }
    gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr))
    gl.clearColor(1, 1, 1, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.positions)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW)
    const positionLocation = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(positionLocation); gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.colors)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW)
    const colorLocation = gl.getAttribLocation(program, 'a_color')
    gl.enableVertexAttribArray(colorLocation); gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0)
    gl.lineWidth(1)
    gl.drawArrays(gl.LINES, 0, lineVertexCount)
    const nodeVertexCount = positions.length / 2 - lineVertexCount
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
    const nodeMap = new Map(nodes.map((node) => [node.id, node]))
    const selected = selectedIdRef.current ? nodeMap.get(selectedIdRef.current) : undefined
    const hovered = hoverRef.current
    if (largeGraph && webglRef.current && webglProgramRef.current) {
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
      const tip = { x: target.x - ux * (nodeRadius(target) + 2), y: target.y - uy * (nodeRadius(target) + 2) }
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
      const radius = nodeRadius(node)
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
      const points = graph.nodes.filter((node) => node.x != null && node.y != null)
      if (!points.length) return
      const xs = points.map((node) => node.x as number)
      const ys = points.map((node) => node.y as number)
      const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
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
        .strength((node) => -115 - articleImportance(node) * 126 - hubRepulsionScore(node) ** 3 * 520)
        .distanceMax(480))
      .force('hub-repulsion', hubRepulsion(graph.nodes, largeGraph))
      .force('collision', forceCollide<GraphNode>().radius((node) => nodeRadius(node) + (largeGraph ? 5 : 10)).iterations(largeGraph ? 1 : 2))
      .force('center', forceCenter<GraphNode>(0, 0).strength(0.035))
      // The arrow remains directed in the renderer, but the physical spring is
      // symmetric: both articles move toward one another for every link.
      // Applying equal-and-opposite velocity keeps the map stable and prevents
      // a one-way link from making its target appear artificially anchored.
      .force('link-attraction', symmetricAttraction(attractionLinks, graph.nodes))
    simulationRef.current = sim
    let framePending = false
    sim.on('tick', () => {
      if (!largeGraph) { drawRef.current(); return }
      if (framePending) return
      framePending = true
      requestAnimationFrame(() => { framePending = false; drawRef.current() })
    })
    if (pausedRef.current) sim.stop()
    return () => { sim.stop(); simulationRef.current = null }
  }, [graph])

  useEffect(() => { drawRef.current() }, [selectedId])

  useEffect(() => {
    simulationRef.current?.alphaTarget(paused ? 0 : 0.03)
    if (paused) simulationRef.current?.stop()
    else simulationRef.current?.restart()
  }, [paused])

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
  const hit = (point: Point) => graph.nodes.find((node) => node.x != null && node.y != null && Math.hypot((node.x as number) - point.x, (node.y as number) - point.y) <= (nodeRadius(node) + 7) / viewRef.current.scale)

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
      onKeyDown={(event) => { if (event.key === '+' || event.key === '=') { event.preventDefault(); viewRef.current.scale = Math.min(4, viewRef.current.scale * 1.15); draw() } else if (event.key === '-') { event.preventDefault(); viewRef.current.scale = Math.max(.18, viewRef.current.scale / 1.15); draw() } else if (event.key === '0') { event.preventDefault(); viewRef.current = { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2, scale: 1 }; draw() } else if (event.key.toLowerCase() === 'f') { event.preventDefault(); const points = graphRef.current.nodes.filter((node) => node.x != null && node.y != null); if (points.length) { const xs = points.map((node) => node.x as number); const ys = points.map((node) => node.y as number); const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }; const { width, height } = sizeRef.current; const scale = Math.max(.2, Math.min(2.2, .86 * Math.min(width / Math.max(1, bounds.maxX - bounds.minX + 80), height / Math.max(1, bounds.maxY - bounds.minY + 80)))); viewRef.current = { scale, x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale, y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale }; draw() } } }} />
  </div>
})

function symmetricAttraction(links: GraphLink[], nodes: GraphNode[]) {
  let resolved: Array<[GraphNode, GraphNode, number]> = []
  const force = (alpha: number) => {
    for (const [source, target, weight] of resolved) {
      if (source.x == null || target.x == null || source.y == null || target.y == null) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.hypot(dx, dy) || 1
      const strength = Math.min(0.028, 0.007 + distance / 260000) * weight
      const pullX = dx / distance * distance * strength * alpha
      const pullY = dy / distance * distance * strength * alpha

      // Equal and opposite impulses make this a true spring: the source moves
      // toward the target and the target moves toward the source. Keeping the
      // same impulse magnitude also preserves momentum when link direction is
      // only a semantic Wikipedia property rather than a physical constraint.
      source.vx = (source.vx ?? 0) + pullX
      source.vy = (source.vy ?? 0) + pullY
      target.vx = (target.vx ?? 0) - pullX
      target.vy = (target.vy ?? 0) - pullY
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    const map = new Map(nodes.map((node) => [node.id, node]))
    const candidates = links.flatMap((link) => {
      const source = linkNode(link.source, map)
      const target = linkNode(link.target, map)
      return source && target ? [[source, target] as [GraphNode, GraphNode]] : []
    })
    const outDegrees = new Map<GraphNode, number>()
    for (const [source] of candidates) outDegrees.set(source, (outDegrees.get(source) ?? 0) + 1)
    // Keep high-outdegree pages influential without letting one hub dominate the whole map.
    resolved = candidates.map(([source, target]) => [source, target, 1 / Math.sqrt(outDegrees.get(source) ?? 1)])
    void simulationNodes
  }
  return force
}

/**
 * Extra local force for structural hubs. d3's many-body force is excellent at
 * scaling to large graphs, but its per-node charge cannot express the desired
 * "hub versus hub" boundary. A spatial hash keeps this pairwise term bounded:
 * only nearby hubs are compared, and low-degree pages are ignored entirely.
 */
function hubRepulsion(initialNodes: GraphNode[], largeGraph: boolean) {
  let nodes = initialNodes
  const cellSize = largeGraph ? 260 : 220
  const maxDistance = largeGraph ? 520 : 460
  const maxDistanceSquared = maxDistance * maxDistance
  const force = (alpha: number) => {
    const cells = new Map<string, GraphNode[]>()
    const active = nodes.filter((node) => node.x != null && node.y != null && hubRepulsionScore(node) >= 0.12)
    for (const node of active) {
      const key = `${Math.floor((node.x as number) / cellSize)},${Math.floor((node.y as number) / cellSize)}`
      const bucket = cells.get(key)
      if (bucket) bucket.push(node)
      else cells.set(key, [node])
    }

    let interactions = 0
    const interactionBudget = largeGraph ? 160_000 : 240_000
    for (const source of active) {
      if (interactions >= interactionBudget) break
      const sourceX = source.x as number
      const sourceY = source.y as number
      const sourceCellX = Math.floor(sourceX / cellSize)
      const sourceCellY = Math.floor(sourceY / cellSize)
      const sourceScore = hubRepulsionScore(source)
      for (let cellX = sourceCellX - 2; cellX <= sourceCellX + 2; cellX += 1) {
        for (let cellY = sourceCellY - 2; cellY <= sourceCellY + 2; cellY += 1) {
          const bucket = cells.get(`${cellX},${cellY}`)
          if (!bucket) continue
          for (const target of bucket) {
            if (target.id <= source.id) continue
            const dx = sourceX - (target.x as number)
            const dy = sourceY - (target.y as number)
            const distanceSquared = dx * dx + dy * dy
            if (distanceSquared > maxDistanceSquared) continue
            interactions += 1
            const distance = Math.sqrt(distanceSquared) || 1
            const targetScore = hubRepulsionScore(target)
            const pairScore = sourceScore * sourceScore * targetScore * targetScore
            // A hard floor keeps two hubs from collapsing together; the
            // quadratic score makes the strongest hubs repel super-linearly.
            const magnitude = Math.min(10, (18 + 560 * pairScore) / Math.max(34, distance)) * alpha
            const vx = dx / distance * magnitude
            const vy = dy / distance * magnitude
            source.vx = (source.vx ?? 0) + vx
            source.vy = (source.vy ?? 0) + vy
            target.vx = (target.vx ?? 0) - vx
            target.vy = (target.vy ?? 0) - vy
            if (interactions >= interactionBudget) break
          }
          if (interactions >= interactionBudget) break
        }
        if (interactions >= interactionBudget) break
      }
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => { nodes = simulationNodes }
  return force
}

export default GraphCanvas
