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
  test(`${dimensions}D boundary force grows exponentially with excess distance`, () => {
    const nodes = [102, 104, 106].map((distance, i) => ({ id: `${i}`, ...position(distance) }))
    const force = boundaryForce(100, dimensions)
    force.initialize(nodes); force(1)
    const pulls = nodes.map(node => -velocity(node))
    assert.ok(Math.abs((pulls[2] - pulls[1]) / (pulls[1] - pulls[0]) - Math.exp(0.25)) < 1e-12)
  })
  test(`${dimensions}D boundary retains its strength after cooling`, () => {
    const node = { id: 'outside', ...position(130) }
    const force = boundaryForce(100, dimensions)
    force.initialize([node]); force(1)
    const warm = velocity(node)
    node.vx = 0; node.vy = 0; node.vz = 0
    force(0.001)
    assert.equal(velocity(node), warm)
  })
  test(`${dimensions}D cooling brings repelled outliers back close to the boundary`, () => {
    for (const count of [1000, 3000]) {
      const radius = boundaryRadius(count, dimensions)
      const node = { id: 'outlier', ...position(radius * 2.5) }
      const sim = (dimensions === 2 ? forceSimulation([node]) : forceSimulation3D([node], 3)).stop()
        .force('outward', alpha => {
          if (dimensions === 2) node.vx += 140 * alpha
          else node.vz += 140 * alpha
        })
        .force('boundary', boundaryForce(radius, dimensions))
        .alpha(0.8).alphaDecay(0.01).velocityDecay(0.4)
      sim.tick(670)
      const distance = Math.hypot(node.x, node.y, dimensions === 3 ? node.z : 0)
      assert.ok(distance < radius * 1.01, `${count} articles: outlier at ${distance / radius} radii`)
    }
  })
  test(`${dimensions}D exponential boundary remains stable for distant nodes`, () => {
    const node = { id: 'distant', ...position(1_000_000) }
    const sim = (dimensions === 2 ? forceSimulation([node]) : forceSimulation3D([node], 3)).stop()
      .force('boundary', boundaryForce(100, dimensions)).alphaDecay(0).velocityDecay(0.4)
    for (let tick = 0; tick < 300; tick++) {
      sim.tick()
      const distance = Math.hypot(node.x, node.y, dimensions === 3 ? node.z : 0)
      assert.ok(Number.isFinite(distance) && distance < 1_000_000)
    }
    assert.ok(Math.hypot(node.x, node.y, dimensions === 3 ? node.z : 0) < 101)
  })
}
