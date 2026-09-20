import assert from 'node:assert/strict'
import test from 'node:test'
import { forceSimulation } from 'd3-force'
import { forceSimulation as forceSimulation3D } from 'd3-force-3d'
import { limitVelocity, velocityLimitForce } from '../src/graph/velocity.ts'

test('2D high impulses are limited to one collision radius per tick', () => {
  const node = { vx: 120, vy: 160 }
  limitVelocity(node, 2, 12)
  assert.ok(Math.abs(Math.hypot(node.vx, node.vy) - 12) < 1e-12)
  assert.ok(node.vx > 0 && node.vy > 0)
})

test('3D high impulses preserve direction while limiting travel', () => {
  const node = { vx: 3, vy: 4, vz: 12 }
  limitVelocity(node, 3, 6)
  assert.ok(Math.abs(Math.hypot(node.vx, node.vy, node.vz) - 6) < 1e-12)
  assert.ok(node.vx > 0 && node.vy > 0 && node.vz > 0)
})

for (const dimensions of [2, 3]) {
  test(`${dimensions}D velocity limit runs before integration`, () => {
    const node = dimensions === 2
      ? { id: 'a', x: 0, y: 0, vx: 100, vy: 0 }
      : { id: 'a', x: 0, y: 0, z: 0, vx: 100, vy: 0, vz: 0 }
    const simulation = (dimensions === 2 ? forceSimulation([node]) : forceSimulation3D([node], 3)).stop()
      .force('velocity-limit', velocityLimitForce(dimensions, () => 8))
      .velocityDecay(0)
    simulation.tick()
    assert.equal(node.x, 8)
    assert.equal(node.vx, 8)
  })

  test(`${dimensions}D opposing high impulses cannot cross in one tick`, () => {
    const nodes = dimensions === 2
      ? [{ id: 'a', x: -30, y: 0, vx: 100, vy: 0 }, { id: 'b', x: 30, y: 0, vx: -100, vy: 0 }]
      : [{ id: 'a', x: -30, y: 0, z: 0, vx: 100, vy: 0, vz: 0 }, { id: 'b', x: 30, y: 0, z: 0, vx: -100, vy: 0, vz: 0 }]
    const simulation = (dimensions === 2 ? forceSimulation(nodes) : forceSimulation3D(nodes, 3)).stop()
      .force('velocity-limit', velocityLimitForce(dimensions, () => 8))
      .velocityDecay(0)
    simulation.tick()
    assert.ok(nodes[0].x < nodes[1].x)
  })
}
