import assert from 'node:assert/strict'
import test from 'node:test'
import { forceSimulation, forceManyBody, forceCollide } from 'd3-force'
import { forceSimulation as forceSimulation3D, forceManyBody as forceManyBody3D, forceCollide as forceCollide3D } from 'd3-force-3d'
import { layoutSpacing, seedLayout, symmetricAttraction } from '../src/graph/layout.ts'

const settings = { linkDistanceScale: 150_000, linkDistanceExponent: 3, linkWeightFloor: 0.02 }
const noHubs = new Set()

test('nearby linked nodes are not pulled into each other', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 40, y: 0 }]
  const force = symmetricAttraction([{ source: 'a', target: 'b' }], nodes, settings, 2, noHubs)
  force.initialize(nodes)
  force(1)
  assert.equal(nodes[0].vx ?? 0, 0)
  assert.equal(nodes[1].vx ?? 0, 0)
  nodes[1].x = 300
  force(1)
  assert.ok(nodes[0].vx > 0)
  assert.equal(nodes[0].vx, -nodes[1].vx)
})

test('a thousand incident links cannot multiply a hub spring budget', () => {
  const nodes = [{ id: 'hub', x: 0, y: 0 }, ...Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, x: 1000, y: 0 }))]
  const links = nodes.slice(1).map(node => ({ source: 'hub', target: node.id }))
  const force = symmetricAttraction(links, nodes, settings, 2, noHubs)
  force.initialize(nodes)
  force(1)
  assert.ok(nodes[0].vx <= 192.000001)
  assert.ok(Math.abs(nodes.reduce((sum, node) => sum + (node.vx ?? 0), 0)) < 1e-8)
})

test('spacing grows smoothly and seeding preserves cached layouts', () => {
  assert.ok(layoutSpacing(3000) > layoutSpacing(1000))
  assert.ok(layoutSpacing(2001) / layoutSpacing(2000) < 1.001)
  const nodes = [{ id: 'cached', x: 1, y: 2, z: 3 }, { id: 'new' }]
  seedLayout(nodes, 3)
  assert.deepEqual(nodes[0], { id: 'cached', x: 1, y: 2, z: 3 })
  assert.ok(Number.isFinite(nodes[1].z))
})

for (const dimensions of [2, 3]) {
  for (const count of [1000, 3000]) {
    test(`${count} articles in ${dimensions}D retain separation and finite coordinates`, () => {
      const nodes = Array.from({ length: count }, (_, i) => ({ id: `${i}` }))
      // Deterministic cross-links model a densely connected article collection.
      const links = nodes.flatMap((node, i) => [1, 7, 31, 101, 307, 701].map(offset => ({ source: node.id, target: `${(i + offset) % count}` })))
      seedLayout(nodes, dimensions)
      const spacing = layoutSpacing(count)
      const simulation = (dimensions === 2 ? forceSimulation(nodes) : forceSimulation3D(nodes, 3)).stop()
        .force('charge', (dimensions === 2 ? forceManyBody() : forceManyBody3D()).strength(-180).distanceMax(480 * spacing))
        .force('links', symmetricAttraction(links, nodes, settings, dimensions, noHubs))
        .force('collision', (dimensions === 2 ? forceCollide() : forceCollide3D()).radius(8 + 18).iterations(2))
        .alpha(0.8).alphaDecay(0.025).velocityDecay(0.4)
      simulation.tick(280)
      for (const node of nodes) {
        for (const key of dimensions === 2 ? ['x', 'y', 'vx', 'vy'] : ['x', 'y', 'z', 'vx', 'vy', 'vz']) {
          assert.ok(Number.isFinite(node[key]) && Math.abs(node[key]) < 1_000_000)
        }
      }
      const nearest = nodes.map((node, i) => {
        let distance = Infinity
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue
          distance = Math.min(distance, Math.hypot(node.x - nodes[j].x, node.y - nodes[j].y, dimensions === 3 ? node.z - nodes[j].z : 0))
        }
        return distance
      }).sort((a, b) => a - b)
      assert.ok(nearest[Math.floor(count * 0.1)] > 40, `10th percentile gap: ${nearest[Math.floor(count * 0.1)]}`)
      console.log(`${count} articles, ${dimensions}D: median nearest-neighbor gap ${nearest[Math.floor(count / 2)].toFixed(1)}`)
    })
  }
}
