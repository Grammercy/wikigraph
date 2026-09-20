import assert from 'node:assert/strict'
import test from 'node:test'
import { forceSimulation } from 'd3-force'
import { forceSimulation as forceSimulation3D } from 'd3-force-3d'
import { boundaryForce, boundaryRadius } from '../src/graph/boundary.ts'

for (const dimensions of [2, 3]) {
  const position = distance => dimensions === 2 ? { x: distance, y: 0 } : { x: 0, y: 0, z: distance }
  const velocity = node => dimensions === 2 ? node.vx ?? 0 : node.vz ?? 0
  test(`${dimensions}D boundary reserves the same low density at every article count`, () => {
    const densities = [10, 1000, 3000, 25000].map(count => {
      const radius = boundaryRadius(count, dimensions)
      const volume = dimensions === 2 ? Math.PI * radius ** 2 : 4 / 3 * Math.PI * radius ** 3
      const glyphVolume = dimensions === 2 ? Math.PI * 12 ** 2 : 4 / 3 * Math.PI * 12 ** 3
      assert.ok(count * glyphVolume / volume < 0.02)
      return count / volume
    })
    for (const density of densities) assert.ok(Math.abs(density / densities[0] - 1) < 1e-12)
  })
  test(`${dimensions}D boundary begins at the surface and grows smoothly outside`, () => {
    const nodes = [0, 90, 100, 100.000001, 110, 130, 200, 10000].map((distance, i) => ({ id: `${i}`, ...position(distance) }))
    const force = boundaryForce(100, dimensions)
    force.initialize(nodes)
    const original = nodes.map(node => ({ ...node }))
    force(1)
    for (let i = 0; i < 3; i++) assert.equal(velocity(nodes[i]), 0)
    assert.ok(Math.abs(velocity(nodes[3])) < 1e-6)
    for (let i = 4; i < nodes.length; i++) assert.ok(velocity(nodes[i]) < velocity(nodes[i - 1]))
    nodes.forEach((node, i) => {
      assert.equal(node.x, original[i].x)
      assert.equal(node.y, original[i].y)
      assert.equal(node.z, original[i].z)
    })
  })
  test(`${dimensions}D articles outside the boundary return gradually without clamping`, () => {
    const node = { id: 'outside', ...position(200) }
    const sim = (dimensions === 2 ? forceSimulation([node]) : forceSimulation3D([node], 3)).stop()
      .force('boundary', boundaryForce(100, dimensions)).alphaDecay(0).velocityDecay(0.4)
    sim.tick()
    const distance = () => Math.hypot(node.x, node.y, dimensions === 3 ? node.z : 0)
    assert.ok(distance() > 100 && distance() < 200)
    sim.tick(200)
    assert.ok(distance() < 101)
  })
}
