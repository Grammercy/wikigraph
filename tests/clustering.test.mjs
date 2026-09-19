import assert from 'node:assert/strict'
import test from 'node:test'
import { forceSimulation, forceManyBody, forceCollide } from 'd3-force'
import { forceSimulation as forceSimulation3D, forceManyBody as forceManyBody3D, forceCollide as forceCollide3D } from 'd3-force-3d'
import { layoutSpacing, seedLayout, symmetricAttraction, unrelatedRepulsion } from '../src/graph/layout.ts'

for (const dimensions of [2, 3]) {
  for (const count of [1000, 3000]) {
    test(`${count} interleaved articles form distinct clusters in ${dimensions}D`, () => {
      const clusterCount = count / 50
      // Interleave the groups so initial proximity cannot satisfy this test.
      const nodes = Array.from({ length: count }, (_, i) => ({ id: `${i}`, cluster: i % clusterCount }))
      const links = nodes.flatMap((node, i) => [1, 3, 7, 11, 17, 23].map(offset => ({ source: node.id, target: `${(i + offset * clusterCount) % count}` })))
      // Keep the graph connected through sparse bridges between topics.
      for (let i = 0; i < clusterCount; i++) links.push({ source: `${i}`, target: `${(i + 1) % clusterCount}` })
      seedLayout(nodes, dimensions)
      const spacing = layoutSpacing(count)
      const settings = { linkDistanceScale: 150_000, linkDistanceExponent: 3, linkWeightFloor: 0.02, unrelatedDistance: 480, unrelatedBaseStrength: 40, unrelatedHubStrength: 600, unrelatedInteractionBudget: 220_000 }
      const simulation = (dimensions === 2 ? forceSimulation(nodes) : forceSimulation3D(nodes, 3)).stop()
        .force('charge', (dimensions === 2 ? forceManyBody() : forceManyBody3D()).strength(-180).distanceMax(480 * spacing))
        .force('unrelated', dimensions === 2 ? unrelatedRepulsion(links, nodes, count > 2000, settings, new Set(), () => 0) : null)
        .force('links', symmetricAttraction(links, nodes, settings, dimensions, new Set()))
        .force('collision', (dimensions === 2 ? forceCollide() : forceCollide3D()).radius(26).iterations(2))
        .alpha(0.8).alphaDecay(0.01).velocityDecay(0.4)
      simulation.tick(670)
      let sameCluster = 0
      for (const node of nodes) {
        let closest = null
        let distance = Infinity
        for (const other of nodes) {
          if (node === other) continue
          const gap = Math.hypot(node.x - other.x, node.y - other.y, dimensions === 3 ? node.z - other.z : 0)
          assert.ok(Number.isFinite(gap))
          if (gap < distance) { distance = gap; closest = other }
        }
        if (closest.cluster === node.cluster) sameCluster++
      }
      const purity = sameCluster / count
      console.log(`${count} articles, ${dimensions}D: ${(purity * 100).toFixed(1)}% of nearest neighbors share a cluster`)
      assert.ok(purity > 0.9, `Cluster purity ${purity} must exceed 90%`)
    })
  }
}
