import assert from 'node:assert/strict'
import test from 'node:test'
import { forceSimulation, forceManyBody, forceCollide } from 'd3-force'
import { forceSimulation as forceSimulation3D, forceManyBody as forceManyBody3D, forceCollide as forceCollide3D } from 'd3-force-3d'
import { hubInteractions, symmetricAttraction, seedLayout } from '../src/graph/layout.ts'

import { boundaryForce, boundaryRadius } from '../src/graph/boundary.ts'

const settings = {
  linkDistanceScale: 150_000, linkDistanceExponent: 3, linkWeightFloor: 0.02,
  hubTerritoryBase: 420, hubTerritoryScale: 360, hubForceBase: 24,
  hubForceScale: 700, hubForceMax: 140, hubCharge: 1500,
  unrelatedDistance: 480, unrelatedBaseStrength: 40, unrelatedHubStrength: 600,
}
const length = node => Math.hypot(node.vx ?? 0, node.vy ?? 0, node.vz ?? 0)
for (const dimensions of [2, 3]) {
  const position = distance => dimensions === 2 ? { x: distance, y: 0 } : { x: 0, y: 0, z: distance }
  const velocity = node => dimensions === 2 ? node.vx : node.vz
  const run = (nodes, links, ids) => {
    const force = hubInteractions(links, settings, new Set(ids), () => 1, dimensions)
    force.initialize(nodes)
    force(1)
  }
  test(`${dimensions}D: hub pulls strongly with a small reaction, regardless of edge direction`, () => {
    for (const reverse of [false, true]) {
      const nodes = [{ id: 'h', ...position(0) }, { id: 'a', ...position(200) }]
      const links = [{ source: reverse ? 'a' : 'h', target: reverse ? 'h' : 'a' }]
      run(nodes, links, ['h'])
      assert.ok(velocity(nodes[1]) < 0)
      assert.ok(velocity(nodes[0]) > 0)
      assert.ok(length(nodes[1]) >= 49 * length(nodes[0]))
      const ordinary = nodes.map(node => ({ ...node, vx: 0, vy: 0, vz: 0 }))
      const spring = symmetricAttraction(links, ordinary, settings, dimensions, new Set())
      spring.initialize(ordinary); spring(1)
      assert.ok(length(nodes[1]) >= 2.99 * length(ordinary[1]))
    }
  })
  test(`${dimensions}D: 3000 leaves retain individual pull without overwhelming the hub`, () => {
    const nodes = [{ id: 'h', ...position(0) }, ...Array.from({ length: 3000 }, (_, i) => ({ id: `${i}`, ...position(200) }))]
    const links = nodes.slice(1).map(node => ({ source: 'h', target: node.id }))
    run(nodes, links, ['h'])
    assert.ok(length(nodes[1]) > 100)
    assert.ok(length(nodes[0]) < 12)
    assert.ok(nodes.every(node => Number.isFinite(length(node))))
  })
  test(`${dimensions}D: articles linked to one hub are repelled by a different hub`, () => {
    const nodes = [{ id: 'own', ...position(-1000) }, { id: 'other', ...position(0) }, { id: 'article', ...position(100) }]
    // Isolate the unrelated hub's territory while retaining the other affiliation.
    run(nodes, [{ source: 'own', target: 'article' }], ['other'])
    assert.ok(velocity(nodes[2]) > 0)
    assert.equal(length(nodes[1]), 0)
    const linked = [{ id: 'h', ...position(0) }, { id: 'a', ...position(40) }]
    run(linked, [{ source: 'a', target: 'h' }], ['h'])
    assert.equal(length(linked[1]), 0)
  })
  test(`${dimensions}D: hubs repel strongly even when directly linked`, () => {
    const nodes = [{ id: 'h1', ...position(0) }, { id: 'h2', ...position(100) }]
    run(nodes, [{ source: 'h1', target: 'h2' }], ['h1', 'h2'])
    assert.ok(velocity(nodes[0]) < -100)
    assert.ok(velocity(nodes[1]) > 100)
  })
  test(`${dimensions}D: duplicate links do not multiply hub pull`, () => {
    const nodes = [{ id: 'h', ...position(0) }, { id: 'a', ...position(200) }]
    const link = { source: 'h', target: 'a' }
    run(nodes, [link], ['h'])
    const expected = length(nodes[1])
    nodes.forEach(node => { node.vx = 0; node.vy = 0; node.vz = 0 })
    run(nodes, [link, link, { source: 'a', target: 'h' }], ['h'])
    assert.equal(length(nodes[1]), expected)
  })
  test(`${dimensions}D: 3000 articles converge toward their assigned hubs`, () => {
    const hubs = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}` }))
    const articles = Array.from({ length: 3000 }, (_, i) => ({ id: `a${i}`, hub: i % hubs.length }))
    const nodes = [...hubs, ...articles]
    seedLayout(nodes, dimensions)
    const links = articles.map(node => ({ source: hubs[node.hub].id, target: node.id }))
    const sim = (dimensions === 2 ? forceSimulation(nodes) : forceSimulation3D(nodes, 3)).stop()
      .force('charge', (dimensions === 2 ? forceManyBody() : forceManyBody3D()).strength(-180).distanceMax(900))
      .force('hub', hubInteractions(links, settings, new Set(hubs.map(node => node.id)), () => 1, dimensions))
      .force('collision', (dimensions === 2 ? forceCollide() : forceCollide3D()).radius(26).iterations(2))
      .force('boundary', boundaryForce(boundaryRadius(nodes.length, dimensions), dimensions))
      .alpha(0.8).alphaDecay(0.015).velocityDecay(0.4)
    sim.tick(360)
    let matched = 0
    for (const article of articles) {
      const nearest = hubs.map((hub, i) => ({ i, distance: Math.hypot(article.x - hub.x, article.y - hub.y, dimensions === 3 ? article.z - hub.z : 0) })).sort((a, b) => a.distance - b.distance)[0]
      assert.ok(Number.isFinite(nearest.distance))
      if (nearest.i === article.hub) matched++
    }
    console.log(`${dimensions}D: ${matched}/3000 articles nearest their own hub`)
    assert.ok(matched / articles.length > 0.9)
  })
}
