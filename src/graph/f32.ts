import type { GraphNode } from '../components/GraphCanvas'

const finiteF32 = (value: number | null | undefined, fallback = 0) =>
  Math.fround(Number.isFinite(value) ? value as number : fallback)

/** Keep the CPU fallback's simulation state in the format used by WebGPU. */
export function roundSimulationNodesF32(nodes: GraphNode[], dimensions: 2 | 3): void {
  for (const node of nodes) {
    node.x = finiteF32(node.x)
    node.y = finiteF32(node.y)
    node.vx = finiteF32(node.vx)
    node.vy = finiteF32(node.vy)
    if (dimensions === 3) {
      node.z = finiteF32(node.z)
      node.vz = finiteF32(node.vz)
    } else {
      node.z = undefined
      node.vz = undefined
    }
    if (node.fx != null) node.fx = finiteF32(node.fx)
    if (node.fy != null) node.fy = finiteF32(node.fy)
    if (dimensions === 3 && node.fz != null) node.fz = finiteF32(node.fz)
  }
}
