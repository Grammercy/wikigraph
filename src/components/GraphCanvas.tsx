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
// More connected articles are visually larger, with a cap so hubs never swallow
// nearby nodes. Keeping this in one helper also keeps hit testing/collision aligned.
const nodeRadius = (node: GraphNode) => {
  const degreeSize = Math.min(6, Math.sqrt(Math.min(articleDegree(node), 56)) * 0.8)
  return (node.id.length > 18 ? 5 : 6) + degreeSize
}
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
    const nodeMap = new Map(nodes.map((node) => [node.id, node]))
    const selected = selectedIdRef.current ? nodeMap.get(selectedIdRef.current) : undefined
    const hovered = hoverRef.current

    ctx.lineCap = 'round'
    for (const edge of currentGraph.links) {
      const source = linkNode(edge.source, nodeMap)
      const target = linkNode(edge.target, nodeMap)
      if (!source || !target || source.x == null || target.x == null || source.y == null || target.y == null) continue
      const isRelated = source === selected || target === selected
      ctx.strokeStyle = isRelated ? 'rgba(37, 79, 239, .72)' : 'rgba(115, 119, 127, .22)'
      ctx.lineWidth = isRelated ? 1.7 : 1
      ctx.beginPath()
      ctx.moveTo(source.x, source.y)
      ctx.lineTo(target.x, target.y)
      ctx.stroke()
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
      if (view.scale > 0.58 || active || node === selected) {
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
    const { width, height } = sizeRef.current
    if (width > 1 && height > 1) viewRef.current = { x: width / 2, y: height / 2, scale: 1 }
    const sim = forceSimulation(graph.nodes)
      // Hubs need more breathing room: their repulsion grows with degree, but is
      // capped to keep a single highly-linked page from dominating the whole map.
      .force('charge', forceManyBody<GraphNode>()
        .strength((node) => -115 - Math.min(126, Math.sqrt(Math.min(articleDegree(node), 56)) * 17))
        .distanceMax(480))
      .force('collision', forceCollide<GraphNode>().radius((node) => nodeRadius(node) + 10).iterations(2))
      .force('center', forceCenter<GraphNode>(0, 0).strength(0.035))
      // Wikipedia links are directed: the source article moves toward its target,
      // while the target does not receive the spring's equal-and-opposite pull.
      .force('directed-attraction', directedAttraction(graph.links, graph.nodes))
    simulationRef.current = sim
    sim.on('tick', () => drawRef.current())
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
    <canvas ref={canvasRef} aria-label="Wikipedia article graph" style={{ display: 'block', width: '100%', height: '100%', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
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

function directedAttraction(links: GraphLink[], nodes: GraphNode[]) {
  let resolved: Array<[GraphNode, GraphNode, number]> = []
  const force = (alpha: number) => { for (const [source, target, weight] of resolved) { if (source.x == null || target.x == null || source.y == null || target.y == null) continue; const dx = target.x - source.x; const dy = target.y - source.y; const distance = Math.hypot(dx, dy) || 1; const strength = Math.min(0.028, 0.007 + distance / 260000) * weight; source.vx = (source.vx ?? 0) + dx / distance * distance * strength * alpha; source.vy = (source.vy ?? 0) + dy / distance * distance * strength * alpha } }
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

export default GraphCanvas
