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
  const force = (alpha: number) => {
    for (const node of nodes) {
      const x = node.x ?? 0
      const y = node.y ?? 0
      const z = dimensions === 3 ? node.z ?? 0 : 0
      const distance = Math.hypot(x, y, z)
      if (!Number.isFinite(distance) || distance <= radius || distance === 0) continue
      const excess = distance - radius
      const relative = excess / Math.max(1, radius)
      // Continuous at the boundary, progressively stiffer outside it. The
      // stiffness approaches 0.4 so distant nodes return without an explosive
      // polynomial impulse. Position is never clamped.
      const magnitude = excess * (0.04 + 0.36 * relative / (1 + relative)) * Math.max(0, alpha)
      node.vx = (node.vx ?? 0) - x / distance * magnitude
      node.vy = (node.vy ?? 0) - y / distance * magnitude
      if (dimensions === 3) node.vz = (node.vz ?? 0) - z / distance * magnitude
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => { nodes = simulationNodes }
  return force
}
