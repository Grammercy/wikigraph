import type { GraphNode } from '../components/GraphCanvas'

// Reserve generous area/volume per article, including space between clusters.
export function boundaryRadius(count: number, dimensions: 2 | 3): number {
  const articles = Math.max(1, count)
  return dimensions === 2
    ? 160 * Math.sqrt(articles / Math.PI)
    : 220 * Math.cbrt(3 * articles / (4 * Math.PI))
}

/** An inward force that begins at the boundary and increases beyond it. */
export function boundaryForce(radius: number, dimensions: 2 | 3) {
  let nodes: GraphNode[] = []
  const force = (_alpha: number) => {
    for (const node of nodes) {
      const x = node.x ?? 0
      const y = node.y ?? 0
      const z = dimensions === 3 ? node.z ?? 0 : 0
      const distance = Math.hypot(x, y, z)
      if (!Number.isFinite(distance) || distance <= radius || distance === 0) continue
      const excess = distance - radius
      // Ramp up across a narrow band, rather than an entire graph radius.
      // Bound the band width so large graphs do not acquire a very soft wall.
      const band = Math.max(1, Math.min(120, radius * 0.08))
      const exponential = band * 0.12 * Math.expm1(Math.min(50, excess / band))
      // Limit extreme per-tick kicks to avoid shooting through the graph.
      // This caps acceleration, never the node's position.
      // Boundary confinement, like collision handling, must not fade as the
      // topology forces cool. Otherwise outlying clusters freeze outside it.
      const magnitude = Math.min(exponential, 0.6 * excess)
      node.vx = (node.vx ?? 0) - x / distance * magnitude
      node.vy = (node.vy ?? 0) - y / distance * magnitude
      if (dimensions === 3) node.vz = (node.vz ?? 0) - z / distance * magnitude
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => { nodes = simulationNodes }
  return force
}
