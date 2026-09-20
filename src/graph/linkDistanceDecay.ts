export const LINK_DISTANCE_SCALE_START = 150_000
export const LINK_DISTANCE_SCALE_END = 1
export const LINK_DISTANCE_SCALE_DECAY_MS = 30_000
/** Nominal duration of one d3-force tick at the browser's 60 Hz cadence. */
export const LINK_DISTANCE_SCALE_PHYSICS_STEP_MS = 1_000 / 60

/** Return the link scale after a cubic ease-out decay. */
export function decayedLinkDistanceScale(elapsedMs: number) {
  const progress = Math.max(0, Math.min(1, elapsedMs / LINK_DISTANCE_SCALE_DECAY_MS))
  const remaining = 1 - progress
  return Math.round(
    LINK_DISTANCE_SCALE_END
      + (LINK_DISTANCE_SCALE_START - LINK_DISTANCE_SCALE_END) * remaining ** 3,
  )
}
