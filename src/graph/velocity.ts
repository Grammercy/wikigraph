/** The small velocity shape shared by the CPU and layout helpers. */
export type VelocityNode = {
  vx?: number
  vy?: number
  vz?: number
}

/**
 * Limit a node's travel during one physics tick.
 *
 * Collision detection samples the state once per tick, so allowing a node to
 * move farther than its collision radius can make it tunnel through another
 * node. Scaling the complete velocity vector preserves its direction while
 * making the integration step small enough for the next collision pass to see
 * the encounter.
 */
export function limitVelocity(node: VelocityNode, dimensions: 2 | 3, maxTravel: number): void {
  if (!Number.isFinite(maxTravel) || maxTravel <= 0) return
  const vx = node.vx ?? 0
  const vy = node.vy ?? 0
  const vz = dimensions === 3 ? node.vz ?? 0 : 0
  const speed = Math.hypot(vx, vy, vz)
  if (!Number.isFinite(speed) || speed <= maxTravel || speed <= 0) return
  const scale = maxTravel / speed
  node.vx = vx * scale
  node.vy = vy * scale
  if (dimensions === 3) node.vz = vz * scale
}

/** A d3-compatible force that prevents tunnelling on high-impulse ticks. */
export function velocityLimitForce(
  dimensions: 2 | 3,
  maxTravel: (node: VelocityNode) => number,
) {
  let nodes: VelocityNode[] = []
  const force = () => {
    for (const node of nodes) limitVelocity(node, dimensions, maxTravel(node))
  }
  force.initialize = (simulationNodes: VelocityNode[]) => { nodes = simulationNodes }
  return force
}
