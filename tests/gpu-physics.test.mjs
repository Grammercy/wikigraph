import assert from 'node:assert/strict'
import test from 'node:test'
import { roundSimulationNodesF32 } from '../src/graph/f32.ts'
import { buildSpatialTopology, prepareGpuTopology } from '../src/graph/gpuSimulation.ts'

test('CPU fallback stores every simulation coordinate as f32', () => {
  const nodes = [{
    id: 'a', x: 1 / 3, y: Math.PI, z: Math.E,
    vx: -1 / 7, vy: Math.SQRT2, vz: 1 / 11,
    fx: 1 / 13, fy: null, fz: 1 / 17,
  }]
  roundSimulationNodesF32(nodes, 3)
  assert.equal(nodes[0].x, Math.fround(1 / 3))
  assert.equal(nodes[0].y, Math.fround(Math.PI))
  assert.equal(nodes[0].z, Math.fround(Math.E))
  assert.equal(nodes[0].vx, Math.fround(-1 / 7))
  assert.equal(nodes[0].vy, Math.fround(Math.SQRT2))
  assert.equal(nodes[0].vz, Math.fround(1 / 11))
  assert.equal(nodes[0].fx, Math.fround(1 / 13))
  assert.equal(nodes[0].fy, null)
  assert.equal(nodes[0].fz, Math.fround(1 / 17))
})

test('GPU topology preserves non-hub links and hub memberships', () => {
  const nodes = [{ id: 'hub' }, { id: 'a' }, { id: 'b' }]
  const links = [{ source: 'hub', target: 'a' }, { source: 'a', target: 'b' }]
  const topology = prepareGpuTopology(nodes, links, new Set(['hub']), 0.02)
  assert.equal(topology.hubCount, 1)
  assert.deepEqual([...topology.memberships], [0, 1, 0])
  assert.equal(topology.relatedPairs.size, 2)

  const aStart = topology.words[topology.linkOffsetsBase + 1]
  const aEnd = topology.words[topology.linkOffsetsBase + 2]
  const bStart = topology.words[topology.linkOffsetsBase + 2]
  const bEnd = topology.words[topology.linkOffsetsBase + 3]
  assert.equal(aEnd - aStart, 1)
  assert.equal(bEnd - bStart, 1)
  assert.equal(topology.words[topology.linkEntriesBase + aStart * 2], 2)
  assert.equal(topology.words[topology.linkEntriesBase + bStart * 2], 1)
})

test('GPU spatial topology marks related neighbors and omits distant nodes', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, vx: 0, vy: 0 },
    { id: 'b', x: 20, y: 0, vx: 0, vy: 0 },
    { id: 'c', x: 2_000, y: 0, vx: 0, vy: 0 },
  ]
  const links = [{ source: 'a', target: 'b' }]
  const topology = prepareGpuTopology(nodes, links, new Set(), 0.02)
  const settings = { chargeDistance: 100, unrelatedDistance: 100 }
  const spatial = buildSpatialTopology(nodes, 2, settings, 1, new Float32Array([10, 10, 10]), topology.relatedPairs, false)
  const entriesBase = nodes.length + 1
  const firstStart = entriesBase + spatial.words[0]
  const firstEnd = entriesBase + spatial.words[1]
  assert.equal(firstEnd - firstStart, 2)
  assert.equal(spatial.words[firstStart + 1] & 0x7fffffff, 1)
  assert.equal(spatial.words[firstStart + 1] >>> 31, 1)
  const thirdStart = entriesBase + spatial.words[2]
  const thirdEnd = entriesBase + spatial.words[3]
  assert.equal(thirdEnd - thirdStart, 1)
})
