/**
 * Physics values and node-size helpers shared by the browser renderer and the
 * offline SVG baker. Keep these calculations in one place so a baked layout
 * uses the same forces as an interactive layout.
 */

export type PhysicsNode = {
  id: string
  articleSize?: number
  byteLength?: number
  inDegree?: number
  outDegree?: number
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
  fx?: number | null
  fy?: number | null
  fz?: number | null
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

const PHYSICS_TICKS_PER_SECOND = 60
const PHYSICS_COOLING_SECONDS = 30
const DEFAULT_INITIAL_TEMPERATURE = 0.8
const DEFAULT_ALPHA_MIN = 0.001

export const DEFAULT_SIMULATION_SETTINGS: GraphSimulationSettings = {
  baseCharge: 115,
  articleImportanceCharge: 126,
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
  alphaDecay: 1 - Math.pow(
    DEFAULT_ALPHA_MIN / DEFAULT_INITIAL_TEMPERATURE,
    1 / (PHYSICS_TICKS_PER_SECOND * PHYSICS_COOLING_SECONDS),
  ),
  alphaMin: DEFAULT_ALPHA_MIN,
  alphaTarget: 0,
  initialTemperature: DEFAULT_INITIAL_TEMPERATURE,
}

const articleDegree = (node: PhysicsNode) => Math.max(0, (node.inDegree ?? 0) + (node.outDegree ?? 0))
const articleBytes = (node: PhysicsNode) => {
  const value = node.articleSize ?? node.byteLength ?? 0
  return Number.isFinite(value) && value > 0 ? value : 0
}

export const articleImportance = (node: PhysicsNode, settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS) => {
  const degree = Math.min(articleDegree(node), settings.articleDegreeCap)
  const bytes = Math.min(Math.max(articleBytes(node), 0), settings.articleMaxBytes)
  const sizeWeight = Math.max(0, Math.min(1, settings.articleSizeWeight))
  return Math.min(1, Math.log1p(bytes) / Math.log1p(settings.articleMaxBytes)) * sizeWeight
    + Math.sqrt(degree / settings.articleDegreeCap) * (1 - sizeWeight)
}

const HUB_SCORE_FLOOR = 0.8
export const hubRepulsionScore = (
  node: PhysicsNode,
  hubIds: ReadonlySet<string>,
  settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS,
) => {
  const degree = articleDegree(node)
  if (!hubIds.has(node.id)) return 0
  const degreeScore = Math.min(1, Math.log1p(degree) / Math.log1p(Math.max(1, settings.hubDegreeReference)))
  return HUB_SCORE_FLOOR + (1 - HUB_SCORE_FLOOR) * degreeScore
}

export const nodeRadius = (node: PhysicsNode, settings: GraphSimulationSettings = DEFAULT_SIMULATION_SETTINGS) =>
  (node.id.length > 18 ? 5 : 6) + articleImportance(node, settings) * 6

export const collisionStrength = (settings: GraphSimulationSettings) =>
  1 / Math.max(0.25, 1 - Math.max(0, Math.min(0.9, settings.velocityDecay)))

export const LARGE_GRAPH_THRESHOLD = 2_000

/** Apply the same small-graph overlap repair used by the canvas. */
export const repairNodeOverlaps = (nodes: PhysicsNode[], dimensions: 2 | 3, settings: GraphSimulationSettings) => {
  if (nodes.length === 0 || nodes.length > LARGE_GRAPH_THRESHOLD) return
  const radii = nodes.map((node) => nodeRadius(node, settings) + Math.max(0, settings.collisionPadding))
  const cellSize = Math.max(16, Math.max(...radii) * 2)
  const passes = Math.max(2, Math.min(4, Math.round(settings.collisionIterations) + 1))
  for (let pass = 0; pass < passes; pass += 1) {
    const cells = new Map<string, number[]>()
    const locations = nodes.map((node) => {
      const x = Math.floor((node.x ?? 0) / cellSize)
      const y = Math.floor((node.y ?? 0) / cellSize)
      const z = dimensions === 3 ? Math.floor((node.z ?? 0) / cellSize) : 0
      return { x, y, z, key: `${x}:${y}:${z}` }
    })
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
