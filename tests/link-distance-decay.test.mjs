import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decayedLinkDistanceScale,
  LINK_DISTANCE_SCALE_DECAY_MS,
  LINK_DISTANCE_SCALE_END,
  LINK_DISTANCE_SCALE_START,
} from '../src/graph/linkDistanceDecay.ts'

test('link distance scale follows a cubic decay over 30 seconds', () => {
  assert.equal(decayedLinkDistanceScale(0), LINK_DISTANCE_SCALE_START)
  assert.equal(decayedLinkDistanceScale(LINK_DISTANCE_SCALE_DECAY_MS), LINK_DISTANCE_SCALE_END)
  assert.equal(decayedLinkDistanceScale(LINK_DISTANCE_SCALE_DECAY_MS / 2), 18_759)
  assert.equal(decayedLinkDistanceScale(LINK_DISTANCE_SCALE_DECAY_MS * 2), LINK_DISTANCE_SCALE_END)
})
