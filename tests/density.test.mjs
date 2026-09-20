import assert from 'node:assert/strict'
import test from 'node:test'
import { articleRepulsionScale } from '../src/graph/density.ts'
import { unrelatedRepulsion } from '../src/graph/layout.ts'

const graph = (count, outgoing) => {
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `${i}` }))
  const links = nodes.flatMap(node => Array.from({ length: outgoing }, (_, offset) => ({ source: node.id, target: `${(+node.id + offset + 1) % count}` })))
  return { nodes, links }
}
test('average connectivity strengthens repulsion without depending on article count', () => {
  const sparse = graph(1000, 3)
  const dense = graph(1000, 12)
  const larger = graph(3000, 12)
  assert.equal(articleRepulsionScale(sparse.nodes, sparse.links), 1)
  assert.equal(articleRepulsionScale(dense.nodes, dense.links), 2)
  assert.equal(articleRepulsionScale(larger.nodes, larger.links), 2)
  const veryDense = graph(100, 40)
  assert.equal(articleRepulsionScale(veryDense.nodes, veryDense.links), 3)
})
test('duplicates, reciprocal edges, self-links, missing endpoints and global degree metadata do not inflate density', () => {
  const { nodes, links } = graph(40, 6)
  const expected = articleRepulsionScale(nodes, links)
  const duplicateLinks = [...links, ...links.map(link => ({ source: link.target, target: link.source })), ...links, { source: '0', target: '0' }, { source: '0', target: 'missing' }]
  assert.equal(articleRepulsionScale(nodes.map(node => ({ ...node, inDegree: 999999 })), duplicateLinks), expected)
  const byId = new Map(nodes.map(node => [node.id, node]))
  assert.equal(articleRepulsionScale(nodes, links.map(link => ({ source: byId.get(link.source), target: byId.get(link.target) }))), expected)
  assert.equal(articleRepulsionScale([], []), 1)
})
test('unrelated article repulsion uses the graph density multiplier', () => {
  const impulse = multiplier => {
    const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }]
    const force = unrelatedRepulsion([], nodes, false, { unrelatedDistance: 480, unrelatedBaseStrength: 40, unrelatedHubStrength: 600 }, new Set(), () => 0, multiplier)
    force.initialize(nodes); force(1)
    return -nodes[0].vx
  }
  assert.equal(impulse(2), impulse(1) * 2)
})
