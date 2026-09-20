/** A node's velocity in the force-layout's abstract coordinate system. */
export type KineticEnergyNode = {
  vx?: number
  vy?: number
  vz?: number
}

/**
 * Sum the kinetic energy of the layout, treating every node as unit mass.
 * The force simulation has no physical mass or SI scale, so the result is
 * expressed as layout-units squared per simulation tick squared.
 */
export function kineticEnergy(nodes: readonly KineticEnergyNode[], dimensions: 2 | 3 = 2): number {
  let total = 0
  for (const node of nodes) {
    const vx = Number.isFinite(node.vx) ? node.vx as number : 0
    const vy = Number.isFinite(node.vy) ? node.vy as number : 0
    const vz = dimensions === 3 && Number.isFinite(node.vz) ? node.vz as number : 0
    total += 0.5 * (vx * vx + vy * vy + vz * vz)
  }
  return Number.isFinite(total) ? total : 0
}

const ENERGY_PREFIXES = [
  { factor: 1e30, prefix: 'Q' },
  { factor: 1e27, prefix: 'R' },
  { factor: 1e24, prefix: 'Y' },
  { factor: 1e21, prefix: 'Z' },
  { factor: 1e18, prefix: 'E' },
  { factor: 1e15, prefix: 'P' },
  { factor: 1e12, prefix: 'T' },
  { factor: 1e9, prefix: 'G' },
  { factor: 1e6, prefix: 'M' },
  { factor: 1e3, prefix: 'k' },
  { factor: 1, prefix: '' },
  { factor: 1e-3, prefix: 'm' },
  { factor: 1e-6, prefix: 'μ' },
  { factor: 1e-9, prefix: 'n' },
  { factor: 1e-12, prefix: 'p' },
  { factor: 1e-15, prefix: 'f' },
  { factor: 1e-18, prefix: 'a' },
  { factor: 1e-21, prefix: 'z' },
  { factor: 1e-24, prefix: 'y' },
  { factor: 1e-27, prefix: 'r' },
  { factor: 1e-30, prefix: 'q' },
] as const

function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value
  return value.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Format an energy reading with at most three significant digits. Prefixes
 * keep small and large readings readable without ever producing `e+…` output.
 */
export function formatKineticEnergy(value: number): string {
  const energy = Number.isFinite(value) && value > 0 ? value : 0
  if (energy === 0) return '0 u²/t²'

  const unit = ENERGY_PREFIXES.find(({ factor }) => energy >= factor) ?? ENERGY_PREFIXES[ENERGY_PREFIXES.length - 1]
  const scaled = energy / unit.factor
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  // The largest practical reading is covered by the SI prefix table above.
  // Clamp the mantissa as a final guard so a pathological value still obeys
  // the toolbar's three-digit constraint.
  const bounded = Math.min(999, scaled)
  const formatted = trimTrailingZeros(bounded.toFixed(decimals))
  return `${formatted} ${unit.prefix}u²/t²`
}
