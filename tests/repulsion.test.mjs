import assert from 'node:assert/strict'
import test from 'node:test'
import { unrelatedRepulsion, symmetricAttraction } from '../src/graph/layout.ts'

test('hub strength does not repel ordinary articles', () => {
  const settings = { unrelatedDistance: 480, unrelatedBaseStrength: 40, unrelatedInteractionBudget: 220_000 }
  const impulse = (hubStrength, hubScore) => {
    const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }]
    const force = unrelatedRepulsion([], nodes, false, { ...settings, unrelatedHubStrength: hubStrength }, new Set(), hubScore)
    force.initialize(nodes)
    force(1)
    return Math.abs(nodes[0].vx)
  }
  assert.equal(impulse(600, () => 0), impulse(0, () => 0))
  assert.ok(impulse(600, () => 1) > impulse(600, () => 0))
})

test('strong long-distance springs still cool with the simulation', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5000, y: 0 }]
  const force = symmetricAttraction([{ source: 'a', target: 'b' }], nodes, { linkDistanceScale: 150_000, linkDistanceExponent: 3, linkWeightFloor: 0.02 }, 2, new Set())
  force.initialize(nodes)
  force(1)
  const warm = nodes[0].vx
  for (const node of nodes) { node.vx = 0; node.vy = 0 }
  force(0.1)
  assert.ok(warm > 32)
  assert.ok(Math.abs(nodes[0].vx - warm * 0.1) < 1e-8)
})
