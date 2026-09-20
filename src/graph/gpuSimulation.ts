import type { GraphLink, GraphNode, GraphSimulationSettings } from '../components/GraphCanvas'

type GpuObject = any

export type PhysicsController = {
  alpha: {
    (): number
    (value: number): PhysicsController
  }
  alphaMin: () => number
  alphaTarget: (value: number) => PhysicsController
  restart: () => PhysicsController
  stop: () => PhysicsController
  destroy?: () => void
}

export type GpuNodeParameters = {
  charge: number
  radius: number
  hubScore: number
}

export type GpuSimulationOptions = {
  nodes: GraphNode[]
  links: GraphLink[]
  attractionLinks: GraphLink[]
  dimensions: 2 | 3
  settings: GraphSimulationSettings
  readSettings: () => GraphSimulationSettings
  hubIds: ReadonlySet<string>
  nodeParameters: GpuNodeParameters[]
  spacing: number
  repulsionScale: number
  boundaryRadius: number
  largeGraph: boolean
  onTick: () => void
  onFailure: (error: unknown) => void
}

type Topology = {
  words: Uint32Array
  linkOffsetsBase: number
  linkEntriesBase: number
  hubIndicesBase: number
  nodeHubOffsetsBase: number
  nodeHubEntriesBase: number
  hubCountsBase: number
  relationOffsetsBase: number
  relationEntriesBase: number
  hubCount: number
  memberships: Float32Array
  relatedPairs: Set<number>
}

type SpatialTopology = {
  words: Uint32Array
  candidateCount: number
}

export const PHYSICS_TICKS_PER_SECOND = 60
export const PHYSICS_TICK_INTERVAL_MS = 1_000 / PHYSICS_TICKS_PER_SECOND
export const nextPhysicsTickDelay = (startedAt: number, completedAt: number) =>
  Math.max(0, PHYSICS_TICK_INTERVAL_MS - Math.max(0, completedAt - startedAt))

class Uint32Builder {
  private words: Uint32Array
  length = 0

  constructor(initialCapacity: number) {
    this.words = new Uint32Array(Math.max(16, initialCapacity))
  }

  push(value: number): void {
    if (this.length === this.words.length) {
      const grown = new Uint32Array(this.words.length * 2)
      grown.set(this.words)
      this.words = grown
    }
    this.words[this.length] = value
    this.length += 1
  }

  finish(): Uint32Array {
    return this.words.slice(0, this.length)
  }
}

const floatBitsBuffer = new ArrayBuffer(4)
const floatBitsF32 = new Float32Array(floatBitsBuffer)
const floatBitsU32 = new Uint32Array(floatBitsBuffer)
const floatBits = (value: number) => {
  floatBitsF32[0] = Math.fround(value)
  return floatBitsU32[0]
}

const endpointId = (endpoint: string | GraphNode) => typeof endpoint === 'string' ? endpoint : endpoint.id
const pairNumber = (first: number, second: number, count: number) => first < second
  ? first * count + second
  : second * count + first

export function prepareGpuTopology(
  nodes: GraphNode[],
  links: GraphLink[],
  hubIds: ReadonlySet<string>,
  linkWeightFloor: number,
  attractionLinks: GraphLink[] = links,
): Topology {
  const count = nodes.length
  const byId = new Map(nodes.map((node, index) => [node.id, index]))
  const resolved: Array<[number, number]> = []
  const degrees = new Uint32Array(count)
  const relatedPairs = new Set<number>()
  const relatedEntries = Array.from({ length: count }, () => new Set<number>())

  for (const link of links) {
    const source = byId.get(endpointId(link.source))
    const target = byId.get(endpointId(link.target))
    if (source == null || target == null || source === target) continue
    resolved.push([source, target])
    if (!(hubIds.has(nodes[source].id) && hubIds.has(nodes[target].id))) {
      relatedPairs.add(pairNumber(source, target, count))
      relatedEntries[source].add(target)
      relatedEntries[target].add(source)
    }
  }

  const attractionResolved: Array<[number, number]> = []
  for (const link of attractionLinks) {
    const source = byId.get(endpointId(link.source))
    const target = byId.get(endpointId(link.target))
    if (source == null || target == null || source === target) continue
    attractionResolved.push([source, target])
    degrees[source] += 1
    degrees[target] += 1
  }

  const weighted = attractionResolved.flatMap(([source, target]) => {
    if (hubIds.has(nodes[source].id) || hubIds.has(nodes[target].id)) return []
    const denominator = Math.sqrt(Math.max(1, degrees[source]) * Math.max(1, degrees[target]))
    const weight = Math.fround(Math.max(linkWeightFloor, 1 / denominator))
    return [{ source, target, weight }]
  })
  const totals = new Float32Array(count)
  for (const edge of weighted) {
    totals[edge.source] = Math.fround(totals[edge.source] + edge.weight)
    totals[edge.target] = Math.fround(totals[edge.target] + edge.weight)
  }
  const linkEntries = Array.from({ length: count }, () => [] as Array<[number, number]>)
  for (const edge of weighted) {
    const weight = Math.fround(edge.weight / Math.max(1, totals[edge.source], totals[edge.target]))
    const bits = floatBits(weight)
    linkEntries[edge.source].push([edge.target, bits])
    linkEntries[edge.target].push([edge.source, bits])
  }

  const hubIndices = nodes.flatMap((node, index) => hubIds.has(node.id) ? [index] : [])
  const hubOrdinalByIndex = new Map(hubIndices.map((index, ordinal) => [index, ordinal]))
  const nodeHubs = Array.from({ length: count }, () => new Set<number>())
  const hubCounts = new Uint32Array(hubIndices.length)
  for (const [source, target] of resolved) {
    const sourceHub = hubOrdinalByIndex.get(source)
    const targetHub = hubOrdinalByIndex.get(target)
    if (sourceHub != null && targetHub == null) nodeHubs[target].add(sourceHub)
    if (targetHub != null && sourceHub == null) nodeHubs[source].add(targetHub)
  }
  for (const memberships of nodeHubs) {
    for (const ordinal of memberships) hubCounts[ordinal] += 1
  }
  const membershipCounts = Float32Array.from(nodeHubs, (memberships) => memberships.size)

  const words: number[] = []
  const linkOffsetsBase = words.length
  let linkEntryCount = 0
  for (const entries of linkEntries) {
    words.push(linkEntryCount)
    linkEntryCount += entries.length
  }
  words.push(linkEntryCount)
  const linkEntriesBase = words.length
  for (const entries of linkEntries) for (const [other, weight] of entries) words.push(other, weight)

  const hubIndicesBase = words.length
  words.push(...hubIndices)
  const nodeHubOffsetsBase = words.length
  let nodeHubEntryCount = 0
  for (const memberships of nodeHubs) {
    words.push(nodeHubEntryCount)
    nodeHubEntryCount += memberships.size
  }
  words.push(nodeHubEntryCount)
  const nodeHubEntriesBase = words.length
  for (const memberships of nodeHubs) words.push(...memberships)
  const hubCountsBase = words.length
  words.push(...hubCounts)
  const relationOffsetsBase = words.length
  let relationEntryCount = 0
  for (const entries of relatedEntries) {
    words.push(relationEntryCount)
    relationEntryCount += entries.size
  }
  words.push(relationEntryCount)
  const relationEntriesBase = words.length
  for (const entries of relatedEntries) words.push(...entries)

  return {
    words: Uint32Array.from(words.length ? words : [0]),
    linkOffsetsBase,
    linkEntriesBase,
    hubIndicesBase,
    nodeHubOffsetsBase,
    nodeHubEntriesBase,
    hubCountsBase,
    relationOffsetsBase,
    relationEntriesBase,
    hubCount: hubIndices.length,
    memberships: membershipCounts,
    relatedPairs,
  }
}

function spatialNeighborLimit(count: number): number {
  if (count > 50_000) return 64
  if (count > 20_000) return 128
  if (count > 5_000) return 256
  if (count > 2_000) return 512
  return Math.max(1, count - 1)
}

export function buildSpatialTopology(
  nodes: GraphNode[],
  dimensions: 2 | 3,
  settings: GraphSimulationSettings,
  spacing: number,
  radii: Float32Array,
  relatedPairs: ReadonlySet<number>,
  largeGraph: boolean,
  skin = 0,
): SpatialTopology {
  const count = nodes.length
  const chargeDistance = Math.max(1, settings.chargeDistance * spacing)
  const unrelatedDistance = dimensions === 2
    ? largeGraph ? Math.min(settings.unrelatedDistance, 480) : Math.min(settings.unrelatedDistance, 420)
    : 0
  let maxRadius = 1
  let maxVelocity = 0
  for (let index = 0; index < count; index += 1) {
    maxRadius = Math.max(maxRadius, radii[index])
    maxVelocity = Math.max(maxVelocity, Math.hypot(nodes[index].vx ?? 0, nodes[index].vy ?? 0, dimensions === 3 ? nodes[index].vz ?? 0 : 0))
  }
  const collisionReach = 2 * maxRadius + Math.min(512, 2 * maxVelocity)
  const safeSkin = Math.max(0, skin)
  const cutoff = Math.max(64, chargeDistance, unrelatedDistance, collisionReach) + safeSkin
  const cellX = new Int32Array(count)
  const cellY = new Int32Array(count)
  const cellZ = new Int32Array(count)
  const cells2D = new Map<number, Map<number, number[]>>()
  const cells3D = new Map<number, Map<number, Map<number, number[]>>>()
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index]
    const x = Math.floor((node.x ?? 0) / cutoff)
    const y = Math.floor((node.y ?? 0) / cutoff)
    const z = dimensions === 3 ? Math.floor((node.z ?? 0) / cutoff) : 0
    cellX[index] = x
    cellY[index] = y
    cellZ[index] = z
    if (dimensions === 2) {
      let column = cells2D.get(x)
      if (!column) {
        column = new Map()
        cells2D.set(x, column)
      }
      const bucket = column.get(y)
      if (bucket) bucket.push(index)
      else column.set(y, [index])
    } else {
      let plane = cells3D.get(x)
      if (!plane) {
        plane = new Map()
        cells3D.set(x, plane)
      }
      let column = plane.get(y)
      if (!column) {
        column = new Map()
        plane.set(y, column)
      }
      const bucket = column.get(z)
      if (bucket) bucket.push(index)
      else column.set(z, [index])
    }
  }

  const chargeDistanceSquared = (chargeDistance + safeSkin) * (chargeDistance + safeSkin)
  const unrelatedDistanceSquared = (unrelatedDistance + safeSkin) * (unrelatedDistance + safeSkin)
  const neighborLimit = spatialNeighborLimit(count)
  const offsets = new Uint32Array(count + 1)
  const entries = new Uint32Builder(Math.max(16, count * Math.min(16, neighborLimit + 1)))
  let candidateCount = 0
  for (let index = 0; index < count; index += 1) {
    offsets[index] = entries.length
    const node = nodes[index]
    const x = node.x ?? 0
    const y = node.y ?? 0
    const z = dimensions === 3 ? node.z ?? 0 : 0
    const vx = node.vx ?? 0
    const vy = node.vy ?? 0
    const vz = dimensions === 3 ? node.vz ?? 0 : 0
    const candidateIndices: number[] = []
    const candidateDistances: number[] = []
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const minZ = dimensions === 3 ? -1 : 0
        const maxZ = dimensions === 3 ? 1 : 0
        for (let oz = minZ; oz <= maxZ; oz += 1) {
          const bucket = dimensions === 2
            ? cells2D.get(cellX[index] + ox)?.get(cellY[index] + oy)
            : cells3D.get(cellX[index] + ox)?.get(cellY[index] + oy)?.get(cellZ[index] + oz)
          if (!bucket) continue
          for (const otherIndex of bucket) {
            if (otherIndex === index) continue
            const other = nodes[otherIndex]
            const dx = (other.x ?? 0) - x
            const dy = (other.y ?? 0) - y
            const dz = dimensions === 3 ? (other.z ?? 0) - z : 0
            const distanceSquared = dx * dx + dy * dy + dz * dz
            const predictedX = dx + (other.vx ?? 0) - vx
            const predictedY = dy + (other.vy ?? 0) - vy
            const predictedZ = dimensions === 3 ? dz + (other.vz ?? 0) - vz : 0
            const predictedSquared = predictedX * predictedX + predictedY * predictedY + predictedZ * predictedZ
            const collisionDistance = radii[index] + radii[otherIndex] + 2 + safeSkin
            if (distanceSquared <= chargeDistanceSquared
              || distanceSquared <= unrelatedDistanceSquared
              || predictedSquared <= collisionDistance * collisionDistance) {
              candidateIndices.push(otherIndex)
              candidateDistances.push(Math.min(distanceSquared, predictedSquared))
            }
          }
        }
      }
    }
    const totalCandidates = candidateIndices.length
    candidateCount += totalCandidates
    let selected: number[]
    if (totalCandidates > neighborLimit) {
      const order = Array.from({ length: totalCandidates }, (_, candidate) => candidate)
      order.sort((a, b) => candidateDistances[a] - candidateDistances[b] || candidateIndices[a] - candidateIndices[b])
      selected = new Array<number>(neighborLimit)
      for (let candidate = 0; candidate < neighborLimit; candidate += 1) selected[candidate] = candidateIndices[order[candidate]]
    } else {
      selected = candidateIndices
    }
    selected.sort((a, b) => a - b)
    const scale = selected.length ? Math.min(4, totalCandidates / selected.length) : 1
    entries.push(floatBits(scale))
    for (const otherIndex of selected) {
      const related = relatedPairs.has(pairNumber(index, otherIndex, count))
      entries.push(otherIndex | (related ? 0x80000000 : 0))
    }
  }
  offsets[count] = entries.length
  const entryWords = entries.finish()
  const words = new Uint32Array(offsets.length + entryWords.length)
  words.set(offsets)
  words.set(entryWords, offsets.length)
  return { words, candidateCount }
}

const GPU_SHADER = String.raw`
struct NodeState {
  position: vec4<f32>,
  velocity: vec4<f32>,
}

struct Params {
  counts: vec4<u32>,
  topology: vec4<u32>,
  topology2: vec4<u32>,
  dynamics: vec4<f32>,
  link: vec4<f32>,
  hub_a: vec4<f32>,
  hub_b: vec4<f32>,
  boundary: vec4<f32>,
  grid: vec4<u32>,
  grid_values: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> center_state: array<NodeState>;
@group(0) @binding(1) var<storage, read_write> center_partials: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> center_params: Params;
@group(0) @binding(3) var<storage, read_write> center_value: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> build_grid_heads: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> build_grid_next: array<i32>;
@group(0) @binding(6) var<storage, read_write> build_grid_cells: array<vec4<i32>>;

var<workgroup> center_partial_sums: array<vec4<f32>, 256>;

@compute @workgroup_size(256)
fn center_partial_main(
  @builtin(global_invocation_id) invocation: vec3<u32>,
  @builtin(local_invocation_index) local_index: u32,
  @builtin(workgroup_id) group: vec3<u32>,
) {
  var value = vec4<f32>(0.0);
  if (invocation.x < center_params.counts.x) {
    value = vec4<f32>(center_state[invocation.x].position.xyz, 0.0);
  }
  center_partial_sums[local_index] = value;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (local_index < stride) {
      center_partial_sums[local_index] += center_partial_sums[local_index + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride /= 2u;
  }
  if (local_index == 0u) { center_partials[group.x] = center_partial_sums[0]; }
}

var<workgroup> center_final_sums: array<vec4<f32>, 256>;

@compute @workgroup_size(256)
fn center_finish_main(@builtin(local_invocation_index) local_index: u32) {
  let partial_count = (center_params.counts.x + 255u) / 256u;
  var sum = vec4<f32>(0.0);
  for (var index = local_index; index < partial_count; index += 256u) {
    sum += center_partials[index];
  }
  center_final_sums[local_index] = sum;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (local_index < stride) {
      center_final_sums[local_index] += center_final_sums[local_index + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride /= 2u;
  }
  let count = max(1.0, f32(center_params.counts.x));
  if (local_index == 0u) { center_value[0] = center_final_sums[0] / count; }
}

fn grid_hash(cell: vec3<i32>, mask: u32) -> u32 {
  let x = bitcast<u32>(cell.x);
  let y = bitcast<u32>(cell.y);
  let z = bitcast<u32>(cell.z);
  return ((x * 73856093u) ^ (y * 19349663u) ^ (z * 83492791u)) & mask;
}

@compute @workgroup_size(256)
fn grid_clear_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  if (invocation.x < center_params.grid.x) {
    atomicStore(&build_grid_heads[invocation.x], -1);
  }
}

@compute @workgroup_size(256)
fn grid_build_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= center_params.counts.x) { return; }
  let cell_size = center_params.grid_values.x;
  let position = center_state[index].position.xyz;
  var cell = vec3<i32>(floor(position / cell_size));
  if (center_params.counts.y == 2u) { cell.z = 0; }
  build_grid_cells[index] = vec4<i32>(cell, 0);
  let bucket = grid_hash(cell, center_params.grid.x - 1u);
  build_grid_next[index] = atomicExchange(&build_grid_heads[bucket], i32(index));
}

@group(1) @binding(0) var<storage, read> force_in: array<NodeState>;
@group(1) @binding(1) var<storage, read_write> force_out: array<NodeState>;
@group(1) @binding(2) var<storage, read> node_meta: array<vec4<f32>>;
@group(1) @binding(3) var<storage, read> topology_data: array<u32>;
@group(1) @binding(4) var<storage, read_write> force_grid_heads: array<atomic<i32>>;
@group(1) @binding(5) var<storage, read> force_grid_next: array<i32>;
@group(1) @binding(6) var<storage, read> force_grid_cells: array<vec4<i32>>;
@group(1) @binding(7) var<storage, read> graph_center: array<vec4<f32>>;
@group(1) @binding(8) var<uniform> force_params: Params;

fn pair_jiggle(first: u32, second: u32, axis: u32) -> f32 {
  let low = min(first, second);
  let high = max(first, second);
  var hash = low * 1664525u + high * 1013904223u + axis * 2246822519u;
  hash ^= hash >> 16u;
  let base = (f32(hash & 0xffffu) / 65535.0 - 0.5) * 1e-6;
  return select(-base, base, first < second);
}

fn centered_position(index: u32) -> vec3<f32> {
  return force_in[index].position.xyz - graph_center[0].xyz * force_params.dynamics.w;
}

fn connected_to_hub(node_index: u32, hub_ordinal: u32) -> bool {
  let offset_base = force_params.topology.w;
  let entry_base = force_params.topology2.x;
  let start = topology_data[offset_base + node_index];
  let end = topology_data[offset_base + node_index + 1u];
  for (var cursor = start; cursor < end; cursor += 1u) {
    if (topology_data[entry_base + cursor] == hub_ordinal) { return true; }
  }
  return false;
}

fn directly_related(first: u32, second: u32) -> bool {
  let offset_base = force_params.topology2.z;
  let entry_base = force_params.topology2.w;
  let start = topology_data[offset_base + first];
  let end = topology_data[offset_base + first + 1u];
  for (var cursor = start; cursor < end; cursor += 1u) {
    if (topology_data[entry_base + cursor] == second) { return true; }
  }
  return false;
}

fn safe_direction(delta_input: vec3<f32>, first: u32, second: u32, dimensions: u32) -> vec4<f32> {
  var delta = delta_input;
  if (delta.x == 0.0) { delta.x = pair_jiggle(first, second, 0u); }
  if (delta.y == 0.0) { delta.y = pair_jiggle(first, second, 1u); }
  if (dimensions == 3u && delta.z == 0.0) { delta.z = pair_jiggle(first, second, 2u); }
  if (dimensions == 2u) { delta.z = 0.0; }
  let distance = max(1e-12, length(delta));
  return vec4<f32>(delta / distance, distance);
}

@compute @workgroup_size(128)
fn force_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let node_count = force_params.counts.x;
  let dimensions = force_params.counts.y;
  if (index >= node_count) { return; }

  var state = force_in[index];
  let position = centered_position(index);
  var velocity = state.velocity.xyz;
  let alpha = force_params.dynamics.x;
  let charge_distance_squared = force_params.dynamics.y;
  let unrelated_distance = force_params.dynamics.z;

  let own_cell = force_grid_cells[index].xyz;
  let own_radius = node_meta[index].y;
  let neighbor_limit = force_params.grid.y;
  var selected_candidates = 0u;
  var total_candidates = 0u;
  var charge_impulse = vec3<f32>(0.0);
  var unrelated_used = 0u;
  var seen_hashes: array<u32, 27>;
  var seen_count = 0u;
  for (var ox = -1; ox <= 1; ox += 1) {
    for (var oy = -1; oy <= 1; oy += 1) {
      for (var oz = -1; oz <= 1; oz += 1) {
        if (dimensions == 2u && oz != 0) { continue; }
        let neighbor_cell = own_cell + vec3<i32>(ox, oy, oz);
        let bucket = grid_hash(neighbor_cell, force_params.grid.x - 1u);
        var duplicate_bucket = false;
        for (var seen = 0u; seen < seen_count; seen += 1u) {
          if (seen_hashes[seen] == bucket) { duplicate_bucket = true; }
        }
        if (duplicate_bucket) { continue; }
        seen_hashes[seen_count] = bucket;
        seen_count += 1u;
        var other = atomicLoad(&force_grid_heads[bucket]);
        loop {
          if (other < 0) { break; }
          let other_index = u32(other);
          other = force_grid_next[other_index];
          if (other_index == index || any(force_grid_cells[other_index].xyz != neighbor_cell)) { continue; }
          let other_position = centered_position(other_index);
          var delta = other_position - position;
          var squared = dot(delta, delta);
          let predicted_delta = delta + force_in[other_index].velocity.xyz - state.velocity.xyz;
          let collision_distance = own_radius + node_meta[other_index].y + 2.0;
          let qualifies = squared <= charge_distance_squared
            || squared <= unrelated_distance * unrelated_distance
            || dot(predicted_delta, predicted_delta) <= collision_distance * collision_distance;
          if (!qualifies) { continue; }
          total_candidates += 1u;
          if (selected_candidates >= neighbor_limit) { continue; }
          selected_candidates += 1u;
          if (squared < charge_distance_squared) {
            if (delta.x == 0.0) { delta.x = pair_jiggle(index, other_index, 0u); squared += delta.x * delta.x; }
            if (delta.y == 0.0) { delta.y = pair_jiggle(index, other_index, 1u); squared += delta.y * delta.y; }
            if (dimensions == 3u && delta.z == 0.0) { delta.z = pair_jiggle(index, other_index, 2u); squared += delta.z * delta.z; }
            if (squared < 1.0) { squared = sqrt(max(1e-20, squared)); }
            charge_impulse += delta * node_meta[other_index].x * alpha / squared;
          }

          if (dimensions == 2u && node_meta[index].z == 0.0 && node_meta[other_index].z == 0.0
              && unrelated_used < force_params.counts.w && !directly_related(index, other_index)) {
            var away = position - other_position;
            let direction = safe_direction(away, other_index, index, dimensions);
            if (direction.w <= unrelated_distance) {
              let falloff = 1.0 - direction.w / unrelated_distance;
              let magnitude = min(14.0, force_params.hub_b.z / max(28.0, direction.w) * falloff) * alpha;
              velocity += direction.xyz * magnitude;
              unrelated_used += 1u;
            }
          }
        }
      }
    }
  }
  if (selected_candidates > 0u) {
    let charge_scale = min(4.0, f32(total_candidates) / f32(selected_candidates));
    velocity += charge_impulse * charge_scale;
  }

  var link_impulse = vec3<f32>(0.0);
  let link_offset_base = force_params.topology.x;
  let link_entry_base = force_params.topology.y;
  let link_start = topology_data[link_offset_base + index];
  let link_end = topology_data[link_offset_base + index + 1u];
  for (var cursor = link_start; cursor < link_end; cursor += 1u) {
    let entry = link_entry_base + cursor * 2u;
    let other_index = topology_data[entry];
    let weight = bitcast<f32>(topology_data[entry + 1u]);
    let direction = safe_direction(centered_position(other_index) - position, index, other_index, dimensions);
    let extension = min(1024.0, max(0.0, direction.w - 48.0));
    let polynomial = select(extension * extension, extension * extension * extension, force_params.link.y > 2.5);
    let base_impulse = min(192.0, polynomial / max(1.0, force_params.link.x) + 0.16 * extension) * alpha;
    link_impulse += direction.xyz * base_impulse * weight;
  }
  let link_magnitude = length(link_impulse);
  if (link_magnitude > 0.0) {
    link_impulse *= min(1.0, force_params.link.z * alpha / link_magnitude);
    velocity += link_impulse;
  }

  var hub_impulse = vec3<f32>(0.0);
  let own_hub_score = node_meta[index].z;
  if (own_hub_score > 0.0) {
    for (var hub_ordinal = 0u; hub_ordinal < force_params.counts.z; hub_ordinal += 1u) {
      let other_index = topology_data[force_params.topology.z + hub_ordinal];
      if (other_index == index) { continue; }
      let direction = safe_direction(position - centered_position(other_index), other_index, index, dimensions);
      let other_score = node_meta[other_index].z;
      let radius = force_params.hub_a.x + force_params.hub_a.y * (own_hub_score + other_score) * 0.5;
      if (direction.w < radius && radius > 0.0) {
        let deficit = 1.0 - direction.w / radius;
        let strength = force_params.hub_a.z + force_params.hub_a.w * pow(own_hub_score * other_score, 1.2)
          + force_params.hub_b.y / max(28.0, direction.w);
        let push = min(force_params.hub_b.x, strength * deficit) * alpha;
        hub_impulse += direction.xyz * push;
      }
    }
    var own_ordinal = 0xffffffffu;
    for (var hub_ordinal = 0u; hub_ordinal < force_params.counts.z; hub_ordinal += 1u) {
      if (topology_data[force_params.topology.z + hub_ordinal] == index) { own_ordinal = hub_ordinal; }
    }
    if (own_ordinal != 0xffffffffu) {
      let connected_count = max(1.0, f32(topology_data[force_params.topology2.y + own_ordinal]));
      for (var other_index = 0u; other_index < node_count; other_index += 1u) {
        if (!connected_to_hub(other_index, own_ordinal)) { continue; }
        let direction = safe_direction(centered_position(other_index) - position, index, other_index, dimensions);
        let extension = min(1024.0, max(0.0, direction.w - 48.0));
        let polynomial = select(extension * extension, extension * extension * extension, force_params.link.y > 2.5);
        let pull = 3.0 * min(192.0, polynomial / max(1.0, force_params.link.x) + 0.16 * extension) * alpha;
        hub_impulse += direction.xyz * pull * 0.02 / connected_count;
      }
    }
  } else {
    for (var hub_ordinal = 0u; hub_ordinal < force_params.counts.z; hub_ordinal += 1u) {
      let hub_index = topology_data[force_params.topology.z + hub_ordinal];
      let direction = safe_direction(position - centered_position(hub_index), hub_index, index, dimensions);
      let connected = connected_to_hub(index, hub_ordinal);
      if (connected) {
        let extension = min(1024.0, max(0.0, direction.w - 48.0));
        let polynomial = select(extension * extension, extension * extension * extension, force_params.link.y > 2.5);
        let pull = 3.0 * min(192.0, polynomial / max(1.0, force_params.link.x) + 0.16 * extension) * alpha;
        hub_impulse -= direction.xyz * pull / max(1.0, node_meta[index].w);
      } else if (direction.w < unrelated_distance && unrelated_distance > 0.0) {
        let score = node_meta[hub_index].z;
        let deficit = 1.0 - direction.w / unrelated_distance;
        let strength = 4.0 * (force_params.hub_b.z + force_params.hub_b.w * score) / max(28.0, direction.w);
        let push = min(force_params.hub_b.x, strength * deficit) * alpha;
        hub_impulse += direction.xyz * push;
      }
    }
  }
  let hub_magnitude = length(hub_impulse);
  if (hub_magnitude > 0.0) {
    hub_impulse *= min(1.0, 1024.0 * alpha / hub_magnitude);
    velocity += hub_impulse;
  }

  let boundary_distance = length(position);
  if (boundary_distance > force_params.boundary.x && boundary_distance > 0.0) {
    let excess = boundary_distance - force_params.boundary.x;
    let band = max(1.0, min(120.0, force_params.boundary.x * 0.08));
    let exponential = band * 0.12 * (exp(min(50.0, excess / band)) - 1.0);
    let magnitude = min(exponential, 0.6 * excess);
    velocity -= position / boundary_distance * magnitude;
  }

  state.position = vec4<f32>(position, 0.0);
  state.velocity = vec4<f32>(velocity, 0.0);
  force_out[index] = state;
}

@group(2) @binding(0) var<storage, read> collision_in: array<NodeState>;
@group(2) @binding(1) var<storage, read_write> collision_out: array<NodeState>;
@group(2) @binding(2) var<storage, read> collision_meta: array<vec4<f32>>;
@group(2) @binding(3) var<storage, read_write> collision_grid_heads: array<atomic<i32>>;
@group(2) @binding(4) var<storage, read> collision_grid_next: array<i32>;
@group(2) @binding(5) var<storage, read> collision_grid_cells: array<vec4<i32>>;
@group(2) @binding(6) var<uniform> collision_params: Params;

@compute @workgroup_size(128)
fn collision_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let node_count = collision_params.counts.x;
  let dimensions = collision_params.counts.y;
  if (index >= node_count) { return; }
  var state = collision_in[index];
  let predicted = state.position.xyz + state.velocity.xyz;
  let own_radius = collision_meta[index].y;
  let own_radius_squared = own_radius * own_radius;
  var impulse = vec3<f32>(0.0);
  let own_cell = collision_grid_cells[index].xyz;
  let charge_distance_squared = collision_params.dynamics.y;
  let unrelated_distance_squared = collision_params.dynamics.z * collision_params.dynamics.z;
  let neighbor_limit = collision_params.grid.y;
  var selected_candidates = 0u;
  var seen_hashes: array<u32, 27>;
  var seen_count = 0u;
  for (var ox = -1; ox <= 1; ox += 1) {
    for (var oy = -1; oy <= 1; oy += 1) {
      for (var oz = -1; oz <= 1; oz += 1) {
        if (dimensions == 2u && oz != 0) { continue; }
        let neighbor_cell = own_cell + vec3<i32>(ox, oy, oz);
        let bucket = grid_hash(neighbor_cell, collision_params.grid.x - 1u);
        var duplicate_bucket = false;
        for (var seen = 0u; seen < seen_count; seen += 1u) {
          if (seen_hashes[seen] == bucket) { duplicate_bucket = true; }
        }
        if (duplicate_bucket) { continue; }
        seen_hashes[seen_count] = bucket;
        seen_count += 1u;
        var other_pointer = atomicLoad(&collision_grid_heads[bucket]);
        loop {
          if (other_pointer < 0) { break; }
          let other_index = u32(other_pointer);
          other_pointer = collision_grid_next[other_index];
          if (other_index == index || any(collision_grid_cells[other_index].xyz != neighbor_cell)) { continue; }
          let other = collision_in[other_index];
          let other_radius = collision_meta[other_index].y;
          let candidate_delta = other.position.xyz - state.position.xyz;
          let candidate_squared = dot(candidate_delta, candidate_delta);
          let combined_with_padding = own_radius + other_radius + 2.0;
          var delta = predicted - other.position.xyz - other.velocity.xyz;
          if (dimensions == 2u) { delta.z = 0.0; }
          var squared = dot(delta, delta);
          let qualifies = candidate_squared <= charge_distance_squared
            || candidate_squared <= unrelated_distance_squared
            || squared <= combined_with_padding * combined_with_padding;
          if (!qualifies) { continue; }
          if (selected_candidates >= neighbor_limit) { continue; }
          selected_candidates += 1u;
          let combined = own_radius + other_radius;
          if (squared >= combined * combined) { continue; }
          if (delta.x == 0.0) { delta.x = pair_jiggle(other_index, index, 0u); squared += delta.x * delta.x; }
          if (delta.y == 0.0) { delta.y = pair_jiggle(other_index, index, 1u); squared += delta.y * delta.y; }
          if (dimensions == 3u && delta.z == 0.0) { delta.z = pair_jiggle(other_index, index, 2u); squared += delta.z * delta.z; }
          let distance = sqrt(max(1e-20, squared));
          let other_radius_squared = other_radius * other_radius;
          let weight = other_radius_squared / max(1e-20, own_radius_squared + other_radius_squared);
          impulse += delta / distance * (combined - distance) * weight;
        }
      }
    }
  }
  state.velocity = vec4<f32>(state.velocity.xyz + impulse, 0.0);
  collision_out[index] = state;
}

@group(3) @binding(0) var<storage, read> integrate_in: array<NodeState>;
@group(3) @binding(1) var<storage, read_write> integrate_out: array<NodeState>;
@group(3) @binding(2) var<storage, read> pins: array<vec4<f32>>;
@group(3) @binding(3) var<uniform> integrate_params: Params;

@compute @workgroup_size(128)
fn integrate_main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if (index >= integrate_params.counts.x) { return; }
  var state = integrate_in[index];
  let pin = pins[index];
  let keep = integrate_params.boundary.y;
  if (abs(pin.x) < 1e30) { state.position.x = pin.x; state.velocity.x = 0.0; }
  else { state.velocity.x *= keep; state.position.x += state.velocity.x; }
  if (abs(pin.y) < 1e30) { state.position.y = pin.y; state.velocity.y = 0.0; }
  else { state.velocity.y *= keep; state.position.y += state.velocity.y; }
  if (integrate_params.counts.y == 3u) {
    if (abs(pin.z) < 1e30) { state.position.z = pin.z; state.velocity.z = 0.0; }
    else { state.velocity.z *= keep; state.position.z += state.velocity.z; }
  } else {
    state.position.z = 0.0;
    state.velocity.z = 0.0;
  }
  integrate_out[index] = state;
}
`

function createBuffer(device: GpuObject, size: number, usage: number): GpuObject {
  return device.createBuffer({ size: Math.max(4, Math.ceil(size / 4) * 4), usage })
}

function nextPowerOfTwo(value: number): number {
  let result = 1
  while (result < value) result *= 2
  return result
}

class GpuPhysicsKernel {
  private readonly device: GpuObject
  private readonly options: GpuSimulationOptions
  private readonly topology: Topology
  private readonly usage: Record<string, number>
  private readonly mapMode: Record<string, number>
  private readonly stateBuffers: [GpuObject, GpuObject]
  private readonly metadataBuffer: GpuObject
  private readonly topologyBuffer: GpuObject
  private readonly pinsBuffer: GpuObject
  private readonly paramsBuffer: GpuObject
  private readonly centerBuffer: GpuObject
  private readonly centerPartialBuffer: GpuObject
  private readonly readbackBuffer: GpuObject
  private readonly gridHeadsBuffer: GpuObject
  private readonly gridNextBuffer: GpuObject
  private readonly gridCellsBuffer: GpuObject
  private readonly gridCapacity: number
  private activeState = 0
  private destroyed = false
  private readonly centerPartialPipeline: GpuObject
  private readonly centerFinishPipeline: GpuObject
  private readonly gridClearPipeline: GpuObject
  private readonly gridBuildPipeline: GpuObject
  private readonly forcePipeline: GpuObject
  private readonly collisionPipeline: GpuObject
  private readonly integratePipeline: GpuObject
  private readonly maxRadius: number
  private readonly pins: Float32Array
  private readonly params: ArrayBuffer
  private gridClearGroup: GpuObject | null = null
  private gridBuildGroups: [GpuObject | null, GpuObject | null] = [null, null]
  private centerPartialGroups: [GpuObject | null, GpuObject | null] = [null, null]
  private centerFinishGroup: GpuObject | null = null
  private forceGroups: [GpuObject | null, GpuObject | null] = [null, null]
  private collisionGroups: [GpuObject | null, GpuObject | null] = [null, null]
  private integrateGroups: [GpuObject | null, GpuObject | null] = [null, null]

  static async create(device: GpuObject, options: GpuSimulationOptions): Promise<GpuPhysicsKernel> {
    const shader = device.createShaderModule({ label: 'WikiGraph f32 physics', code: GPU_SHADER })
    const [centerPartialPipeline, centerFinishPipeline, gridClearPipeline, gridBuildPipeline, forcePipeline, collisionPipeline, integratePipeline] = await Promise.all([
      device.createComputePipelineAsync({ label: 'WikiGraph center partials', layout: 'auto', compute: { module: shader, entryPoint: 'center_partial_main' } }),
      device.createComputePipelineAsync({ label: 'WikiGraph center finish', layout: 'auto', compute: { module: shader, entryPoint: 'center_finish_main' } }),
      device.createComputePipelineAsync({ label: 'WikiGraph grid clear', layout: 'auto', compute: { module: shader, entryPoint: 'grid_clear_main' } }),
      device.createComputePipelineAsync({ label: 'WikiGraph grid build', layout: 'auto', compute: { module: shader, entryPoint: 'grid_build_main' } }),
      device.createComputePipelineAsync({ label: 'WikiGraph forces', layout: 'auto', compute: { module: shader, entryPoint: 'force_main' } }),
      device.createComputePipelineAsync({ label: 'WikiGraph collisions', layout: 'auto', compute: { module: shader, entryPoint: 'collision_main' } }),
      device.createComputePipelineAsync({ label: 'WikiGraph integration', layout: 'auto', compute: { module: shader, entryPoint: 'integrate_main' } }),
    ])
    return new GpuPhysicsKernel(device, options, { centerPartialPipeline, centerFinishPipeline, gridClearPipeline, gridBuildPipeline, forcePipeline, collisionPipeline, integratePipeline })
  }

  private constructor(
    device: GpuObject,
    options: GpuSimulationOptions,
    pipelines: { centerPartialPipeline: GpuObject; centerFinishPipeline: GpuObject; gridClearPipeline: GpuObject; gridBuildPipeline: GpuObject; forcePipeline: GpuObject; collisionPipeline: GpuObject; integratePipeline: GpuObject },
  ) {
    this.device = device
    this.options = options
    this.centerPartialPipeline = pipelines.centerPartialPipeline
    this.centerFinishPipeline = pipelines.centerFinishPipeline
    this.gridClearPipeline = pipelines.gridClearPipeline
    this.gridBuildPipeline = pipelines.gridBuildPipeline
    this.forcePipeline = pipelines.forcePipeline
    this.collisionPipeline = pipelines.collisionPipeline
    this.integratePipeline = pipelines.integratePipeline
    this.usage = (globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage
    this.mapMode = (globalThis as unknown as { GPUMapMode: Record<string, number> }).GPUMapMode
    this.topology = prepareGpuTopology(options.nodes, options.links, options.hubIds, options.settings.linkWeightFloor, options.attractionLinks)

    const stateBytes = Math.max(32, options.nodes.length * 8 * Float32Array.BYTES_PER_ELEMENT)
    this.stateBuffers = [
      createBuffer(device, stateBytes, this.usage.STORAGE | this.usage.COPY_DST | this.usage.COPY_SRC),
      createBuffer(device, stateBytes, this.usage.STORAGE | this.usage.COPY_DST | this.usage.COPY_SRC),
    ]
    this.metadataBuffer = createBuffer(device, Math.max(16, options.nodes.length * 4 * Float32Array.BYTES_PER_ELEMENT), this.usage.STORAGE | this.usage.COPY_DST)
    this.topologyBuffer = createBuffer(device, this.topology.words.byteLength, this.usage.STORAGE | this.usage.COPY_DST)
    this.pinsBuffer = createBuffer(device, Math.max(16, options.nodes.length * 4 * Float32Array.BYTES_PER_ELEMENT), this.usage.STORAGE | this.usage.COPY_DST)
    this.paramsBuffer = createBuffer(device, 160, this.usage.UNIFORM | this.usage.COPY_DST)
    this.centerBuffer = createBuffer(device, 16, this.usage.STORAGE | this.usage.COPY_DST)
    this.centerPartialBuffer = createBuffer(device, Math.ceil(options.nodes.length / 256) * 4 * Float32Array.BYTES_PER_ELEMENT, this.usage.STORAGE)
    this.readbackBuffer = createBuffer(device, stateBytes, this.usage.MAP_READ | this.usage.COPY_DST)
    this.gridCapacity = nextPowerOfTwo(Math.max(256, options.nodes.length * 4))
    this.gridHeadsBuffer = createBuffer(device, this.gridCapacity * Int32Array.BYTES_PER_ELEMENT, this.usage.STORAGE)
    this.gridNextBuffer = createBuffer(device, options.nodes.length * Int32Array.BYTES_PER_ELEMENT, this.usage.STORAGE)
    this.gridCellsBuffer = createBuffer(device, options.nodes.length * 4 * Int32Array.BYTES_PER_ELEMENT, this.usage.STORAGE)
    this.maxRadius = options.nodeParameters.reduce((maximum, parameter) => Math.max(maximum, parameter.radius), 1)
    this.pins = new Float32Array(options.nodes.length * 4)
    this.params = new ArrayBuffer(160)

    const state = new Float32Array(options.nodes.length * 8)
    const metadata = new Float32Array(options.nodes.length * 4)
    for (let index = 0; index < options.nodes.length; index += 1) {
      const node = options.nodes[index]
      const parameter = options.nodeParameters[index]
      const stateOffset = index * 8
      state[stateOffset] = Math.fround(node.x ?? 0)
      state[stateOffset + 1] = Math.fround(node.y ?? 0)
      state[stateOffset + 2] = Math.fround(options.dimensions === 3 ? node.z ?? 0 : 0)
      state[stateOffset + 4] = Math.fround(node.vx ?? 0)
      state[stateOffset + 5] = Math.fround(node.vy ?? 0)
      state[stateOffset + 6] = Math.fround(options.dimensions === 3 ? node.vz ?? 0 : 0)
      const metadataOffset = index * 4
      metadata[metadataOffset] = Math.fround(parameter.charge)
      metadata[metadataOffset + 1] = Math.fround(parameter.radius)
      metadata[metadataOffset + 2] = Math.fround(parameter.hubScore)
      metadata[metadataOffset + 3] = this.topology.memberships[index]
    }
    device.queue.writeBuffer(this.stateBuffers[0], 0, state)
    device.queue.writeBuffer(this.stateBuffers[1], 0, state)
    device.queue.writeBuffer(this.metadataBuffer, 0, metadata)
    device.queue.writeBuffer(this.topologyBuffer, 0, this.topology.words)
  }

  private writePins(): void {
    const sentinel = Math.fround(3.4e38)
    for (let index = 0; index < this.options.nodes.length; index += 1) {
      const node = this.options.nodes[index]
      const offset = index * 4
      this.pins[offset] = node.fx == null ? sentinel : Math.fround(node.fx)
      this.pins[offset + 1] = node.fy == null ? sentinel : Math.fround(node.fy)
      this.pins[offset + 2] = this.options.dimensions === 3 && node.fz != null ? Math.fround(node.fz) : sentinel
    }
    this.device.queue.writeBuffer(this.pinsBuffer, 0, this.pins)
  }

  private writeParams(alpha: number, settings: GraphSimulationSettings): void {
    const floats = new Float32Array(this.params)
    const integers = new Uint32Array(this.params)
    const unrelatedQuota = this.options.nodes.length < 2_000
      ? 0xffffffff
      : Math.max(1, Math.ceil(settings.unrelatedInteractionBudget / Math.max(1, this.options.nodes.length)))
    integers[0] = this.options.nodes.length
    integers[1] = this.options.dimensions
    integers[2] = this.topology.hubCount
    integers[3] = unrelatedQuota
    integers[4] = this.topology.linkOffsetsBase
    integers[5] = this.topology.linkEntriesBase
    integers[6] = this.topology.hubIndicesBase
    integers[7] = this.topology.nodeHubOffsetsBase
    integers[8] = this.topology.nodeHubEntriesBase
    integers[9] = this.topology.hubCountsBase
    integers[10] = this.topology.relationOffsetsBase
    integers[11] = this.topology.relationEntriesBase
    floats[12] = Math.fround(alpha)
    const chargeDistance = Math.fround(settings.chargeDistance * this.options.spacing)
    floats[13] = Math.fround(chargeDistance * chargeDistance)
    floats[14] = Math.fround(this.options.dimensions === 2
      ? this.options.largeGraph ? Math.min(settings.unrelatedDistance, 480) : Math.min(settings.unrelatedDistance, 420)
      : 0)
    floats[15] = Math.fround(settings.centerStrength)
    floats[16] = Math.fround(Math.max(1, settings.linkDistanceScale))
    floats[17] = settings.linkDistanceExponent
    floats[18] = 1_024
    floats[20] = Math.fround(settings.hubTerritoryBase)
    floats[21] = Math.fround(settings.hubTerritoryScale)
    floats[22] = Math.fround(settings.hubForceBase)
    floats[23] = Math.fround(settings.hubForceScale)
    floats[24] = Math.fround(settings.hubForceMax)
    floats[25] = Math.fround(settings.hubCharge)
    floats[26] = Math.fround(settings.unrelatedBaseStrength * this.options.repulsionScale)
    floats[27] = Math.fround(settings.unrelatedHubStrength)
    floats[28] = Math.fround(this.options.boundaryRadius)
    floats[29] = Math.fround(1 - settings.velocityDecay)
    integers[32] = this.gridCapacity
    integers[33] = spatialNeighborLimit(this.options.nodes.length)
    floats[36] = Math.fround(Math.max(
      64,
      chargeDistance,
      this.options.dimensions === 2 ? floats[14] : 0,
      2 * this.maxRadius + 512,
    ))
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params)
  }

  private bindGroup(pipeline: GpuObject, group: number, entries: Array<{ binding: number; buffer: GpuObject }>): GpuObject {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(group),
      entries: entries.map(({ binding, buffer }) => ({ binding, resource: { buffer } })),
    })
  }

  private centerPartialGroup(input: number): GpuObject {
    this.centerPartialGroups[input] ??= this.bindGroup(this.centerPartialPipeline, 0, [
      { binding: 0, buffer: this.stateBuffers[input] },
      { binding: 1, buffer: this.centerPartialBuffer },
      { binding: 2, buffer: this.paramsBuffer },
    ])
    return this.centerPartialGroups[input]
  }

  private getCenterFinishGroup(): GpuObject {
    this.centerFinishGroup ??= this.bindGroup(this.centerFinishPipeline, 0, [
      { binding: 1, buffer: this.centerPartialBuffer },
      { binding: 2, buffer: this.paramsBuffer },
      { binding: 3, buffer: this.centerBuffer },
    ])
    return this.centerFinishGroup
  }

  private getGridClearGroup(): GpuObject {
    this.gridClearGroup ??= this.bindGroup(this.gridClearPipeline, 0, [
      { binding: 2, buffer: this.paramsBuffer },
      { binding: 4, buffer: this.gridHeadsBuffer },
    ])
    return this.gridClearGroup
  }

  private gridBuildGroup(input: number): GpuObject {
    this.gridBuildGroups[input] ??= this.bindGroup(this.gridBuildPipeline, 0, [
      { binding: 0, buffer: this.stateBuffers[input] },
      { binding: 2, buffer: this.paramsBuffer },
      { binding: 4, buffer: this.gridHeadsBuffer },
      { binding: 5, buffer: this.gridNextBuffer },
      { binding: 6, buffer: this.gridCellsBuffer },
    ])
    return this.gridBuildGroups[input]
  }

  private forceGroup(input: number): GpuObject {
    this.forceGroups[input] ??= this.bindGroup(this.forcePipeline, 1, [
      { binding: 0, buffer: this.stateBuffers[input] },
      { binding: 1, buffer: this.stateBuffers[1 - input] },
      { binding: 2, buffer: this.metadataBuffer },
      { binding: 3, buffer: this.topologyBuffer },
      { binding: 4, buffer: this.gridHeadsBuffer },
      { binding: 5, buffer: this.gridNextBuffer },
      { binding: 6, buffer: this.gridCellsBuffer },
      { binding: 7, buffer: this.centerBuffer },
      { binding: 8, buffer: this.paramsBuffer },
    ])
    return this.forceGroups[input]
  }

  private collisionGroup(input: number): GpuObject {
    this.collisionGroups[input] ??= this.bindGroup(this.collisionPipeline, 2, [
      { binding: 0, buffer: this.stateBuffers[input] },
      { binding: 1, buffer: this.stateBuffers[1 - input] },
      { binding: 2, buffer: this.metadataBuffer },
      { binding: 3, buffer: this.gridHeadsBuffer },
      { binding: 4, buffer: this.gridNextBuffer },
      { binding: 5, buffer: this.gridCellsBuffer },
      { binding: 6, buffer: this.paramsBuffer },
    ])
    return this.collisionGroups[input]
  }

  private integrateGroup(input: number): GpuObject {
    this.integrateGroups[input] ??= this.bindGroup(this.integratePipeline, 3, [
      { binding: 0, buffer: this.stateBuffers[input] },
      { binding: 1, buffer: this.stateBuffers[1 - input] },
      { binding: 2, buffer: this.pinsBuffer },
      { binding: 3, buffer: this.paramsBuffer },
    ])
    return this.integrateGroups[input]
  }

  async tick(alpha: number, settings: GraphSimulationSettings): Promise<void> {
    if (this.destroyed || this.options.nodes.length === 0) return
    this.writePins()
    this.writeParams(alpha, settings)

    const workgroups = Math.ceil(this.options.nodes.length / 128)
    const centerWorkgroups = Math.ceil(this.options.nodes.length / 256)
    const gridHeadWorkgroups = Math.ceil(this.gridCapacity / 256)
    const encoder = this.device.createCommandEncoder({ label: 'WikiGraph physics tick' })
    const pass = encoder.beginComputePass({ label: 'WikiGraph physics' })
    pass.setPipeline(this.gridClearPipeline)
    pass.setBindGroup(0, this.getGridClearGroup())
    pass.dispatchWorkgroups(gridHeadWorkgroups)
    pass.setPipeline(this.gridBuildPipeline)
    pass.setBindGroup(0, this.gridBuildGroup(this.activeState))
    pass.dispatchWorkgroups(centerWorkgroups)
    pass.setPipeline(this.centerPartialPipeline)
    pass.setBindGroup(0, this.centerPartialGroup(this.activeState))
    pass.dispatchWorkgroups(centerWorkgroups)
    pass.setPipeline(this.centerFinishPipeline)
    pass.setBindGroup(0, this.getCenterFinishGroup())
    pass.dispatchWorkgroups(1)

    let input = this.activeState
    let output = 1 - input
    pass.setPipeline(this.forcePipeline)
    pass.setBindGroup(1, this.forceGroup(input))
    pass.dispatchWorkgroups(workgroups)
    input = output

    const collisionIterations = Math.max(1, Math.round(settings.collisionIterations))
    for (let iteration = 0; iteration < collisionIterations; iteration += 1) {
      output = 1 - input
      pass.setPipeline(this.collisionPipeline)
      pass.setBindGroup(2, this.collisionGroup(input))
      pass.dispatchWorkgroups(workgroups)
      input = output
    }

    output = 1 - input
    pass.setPipeline(this.integratePipeline)
    pass.setBindGroup(3, this.integrateGroup(input))
    pass.dispatchWorkgroups(workgroups)
    pass.end()
    this.activeState = output
    encoder.copyBufferToBuffer(this.stateBuffers[this.activeState], 0, this.readbackBuffer, 0, this.options.nodes.length * 8 * Float32Array.BYTES_PER_ELEMENT)
    this.device.queue.submit([encoder.finish()])

    await this.readbackBuffer.mapAsync(this.mapMode.READ)
    const state = new Float32Array(this.readbackBuffer.getMappedRange())
    for (let index = 0; index < this.options.nodes.length; index += 1) {
      const node = this.options.nodes[index]
      const offset = index * 8
      node.x = state[offset]
      node.y = state[offset + 1]
      node.z = this.options.dimensions === 3 ? state[offset + 2] : undefined
      node.vx = state[offset + 4]
      node.vy = state[offset + 5]
      node.vz = this.options.dimensions === 3 ? state[offset + 6] : undefined
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.vx) || !Number.isFinite(node.vy)
        || (this.options.dimensions === 3 && (!Number.isFinite(node.z) || !Number.isFinite(node.vz)))) {
        throw new Error(`WebGPU produced a non-finite state for node ${node.id}`)
      }
    }
    this.readbackBuffer.unmap()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const buffer of this.stateBuffers) buffer.destroy()
    this.metadataBuffer.destroy()
    this.topologyBuffer.destroy()
    this.pinsBuffer.destroy()
    this.paramsBuffer.destroy()
    this.centerBuffer.destroy()
    this.centerPartialBuffer.destroy()
    this.readbackBuffer.destroy()
    this.gridHeadsBuffer.destroy()
    this.gridNextBuffer.destroy()
    this.gridCellsBuffer.destroy()
  }
}

class GpuSimulationController implements PhysicsController {
  private readonly kernel: GpuPhysicsKernel
  private readonly options: GpuSimulationOptions
  private alphaValue: number
  private alphaTargetValue: number
  private running = false
  private destroyed = false
  private timerHandle: number | null = null
  private inFlight = false
  private nextTickAt = 0

  constructor(kernel: GpuPhysicsKernel, options: GpuSimulationOptions) {
    this.kernel = kernel
    this.options = options
    this.alphaValue = Math.fround(Math.max(options.settings.alphaMin, Math.min(1, options.settings.initialTemperature)))
    this.alphaTargetValue = Math.fround(options.settings.alphaTarget)
  }

  alpha(): number
  alpha(value: number): PhysicsController
  alpha(value?: number): number | PhysicsController {
    if (value == null) return this.alphaValue
    this.alphaValue = Math.fround(value)
    return this
  }

  alphaMin(): number {
    return this.options.readSettings().alphaMin
  }

  alphaTarget(value: number): PhysicsController {
    this.alphaTargetValue = Math.fround(value)
    return this
  }

  restart(): PhysicsController {
    if (this.destroyed) return this
    if (!this.running) this.nextTickAt = typeof performance === 'undefined' ? Date.now() : performance.now()
    this.running = true
    this.schedule()
    return this
  }

  stop(): PhysicsController {
    this.running = false
    if (this.timerHandle != null) window.clearTimeout(this.timerHandle)
    this.timerHandle = null
    return this
  }

  private schedule(): void {
    if (!this.running || this.destroyed || this.inFlight || this.timerHandle != null) return
    const now = typeof performance === 'undefined' ? Date.now() : performance.now()
    const delay = Math.max(0, this.nextTickAt - now)
    this.timerHandle = window.setTimeout(() => {
      this.timerHandle = null
      void this.runTick()
    }, delay)
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.destroyed || this.inFlight) return
    this.inFlight = true
    const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
    this.nextTickAt = startedAt + PHYSICS_TICK_INTERVAL_MS
    const settings = this.options.readSettings()
    this.alphaValue = Math.fround(this.alphaValue + Math.fround((this.alphaTargetValue - this.alphaValue) * settings.alphaDecay))
    try {
      await this.kernel.tick(this.alphaValue, settings)
      if (this.destroyed) return
      this.options.onTick()
      if (this.alphaValue < settings.alphaMin) this.running = false
    } catch (error) {
      this.running = false
      this.options.onFailure(error)
    } finally {
      this.inFlight = false
      this.schedule()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.stop()
    this.destroyed = true
    this.kernel.destroy()
  }
}

export async function createGpuGraphSimulation(options: GpuSimulationOptions): Promise<PhysicsController | null> {
  if (options.nodes.length === 0 || typeof navigator === 'undefined') return null
  const gpu = (navigator as Navigator & { gpu?: GpuObject }).gpu
  if (!gpu) return null
  const usage = (globalThis as unknown as { GPUBufferUsage?: Record<string, number> }).GPUBufferUsage
  const mapMode = (globalThis as unknown as { GPUMapMode?: Record<string, number> }).GPUMapMode
  if (!usage || !mapMode) return null
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) return null
  const device = await adapter.requestDevice()
  const kernel = await GpuPhysicsKernel.create(device, options)
  return new GpuSimulationController(kernel, options)
}
