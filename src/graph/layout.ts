import type { GraphLink, GraphNode, GraphSimulationSettings } from '../components/GraphCanvas'

type ForceVector = { x: number; y: number; z: number }

/** Grow spacing smoothly through the thousands, without a tier boundary. */
export const layoutSpacing = (count: number) => Math.min(2.5, Math.max(1, Math.pow(count / 250, 0.25)))

/** Seed at roughly constant density, retaining cached positions. */
export function seedLayout(nodes: GraphNode[], dimensions: 2 | 3) {
  const spacing = 32 * layoutSpacing(nodes.length)
  nodes.forEach((node, index) => {
    if (Number.isFinite(node.x) && Number.isFinite(node.y) && (dimensions === 2 || Number.isFinite(node.z))) return
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    if (dimensions === 2) {
      const radius = spacing * Math.sqrt(index + 0.5)
      node.x = radius * Math.cos(angle)
      node.y = radius * Math.sin(angle)
    } else {
      const radius = spacing * Math.cbrt(index + 0.5)
      const vertical = 1 - 2 * ((index * 0.7548776662466927) % 1)
      const horizontal = Math.sqrt(1 - vertical * vertical)
      node.x = radius * horizontal * Math.cos(angle)
      node.y = radius * horizontal * Math.sin(angle)
      node.z = radius * vertical
    }
  })
}

const linkNode = (value: string | GraphNode, nodes: Map<string, GraphNode>) =>
  typeof value === 'string' ? nodes.get(value) : value

export function symmetricAttraction(
  links: GraphLink[],
  nodes: GraphNode[],
  settings: GraphSimulationSettings,
  dimensions: 2 | 3 = 2,
  hubIds: ReadonlySet<string>,
  readSettings: () => GraphSimulationSettings = () => settings,
) {
  // Cap the polynomial spring and each node's total impulse to keep extreme
  // slider settings finite.
  const maxBaseImpulse = 192
  const maxNodeImpulse = 1_024
  const forceDistanceLimit = 1_024
  let resolved: Array<[GraphNode, GraphNode, number]> = []
  const impulses = new Map<GraphNode, ForceVector>()
  const force = (alpha: number) => {
    impulses.clear()
    const maxImpulse = maxNodeImpulse * Math.max(0, alpha)
    const currentSettings = readSettings()
    for (const [source, target, weight] of resolved) {
      if (source.x == null || target.x == null || source.y == null || target.y == null || (dimensions === 3 && (source.z == null || target.z == null))) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const dz = dimensions === 3 ? (target.z as number) - (source.z as number) : 0
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
        source.vx = 0; source.vy = 0; target.vx = 0; target.vy = 0
        if (dimensions === 3) { source.vz = 0; target.vz = 0 }
        continue
      }
      const distance = Math.hypot(dx, dy, dz) || 1
      // Local link length does not grow with the whole collection. Related
      // articles should stay compact even when the map contains thousands.
      const restDistance = 48
      const safeDistance = Math.min(Math.max(0, distance - restDistance), forceDistanceLimit)
      const exponent = currentSettings.linkDistanceExponent === 3 ? 3 : 2
      const distanceScale = Number.isFinite(currentSettings.linkDistanceScale)
        ? Math.max(1, currentSettings.linkDistanceScale)
        : 150_000
      // The linear spring gathers related articles from distant seeds. The
      // polynomial adds tension on long links; both cool and share a bounded
      // per-node budget so dense regions cannot collapse the whole map.
      const baseImpulse = Math.min(
        maxBaseImpulse,
        Math.pow(safeDistance, exponent) / distanceScale + 0.16 * safeDistance,
      ) * Math.max(0, alpha)
      const pullMagnitude = baseImpulse * weight
      if (!Number.isFinite(pullMagnitude)) {
        continue
      }
      const pullX = dx / distance * pullMagnitude
      const pullY = dy / distance * pullMagnitude
      const pullZ = dz / distance * pullMagnitude

      // Accumulate equal-and-opposite impulses first so link direction remains
      // semantic rather than anchoring the target. The aggregate safety cap is
      // applied only after all incident links have been collected.
      const sourceImpulse = impulses.get(source) ?? { x: 0, y: 0, z: 0 }
      sourceImpulse.x += pullX
      sourceImpulse.y += pullY
      sourceImpulse.z += pullZ
      impulses.set(source, sourceImpulse)
      const targetImpulse = impulses.get(target) ?? { x: 0, y: 0, z: 0 }
      targetImpulse.x -= pullX
      targetImpulse.y -= pullY
      targetImpulse.z -= pullZ
      impulses.set(target, targetImpulse)
    }
    for (const [node, impulse] of impulses) {
      const magnitude = Math.hypot(impulse.x, impulse.y, impulse.z)
      if (!Number.isFinite(magnitude) || magnitude < Number.EPSILON) continue
      const scale = Math.min(1, maxImpulse / magnitude)
      node.vx = (node.vx ?? 0) + impulse.x * scale
      node.vy = (node.vy ?? 0) + impulse.y * scale
      if (dimensions === 3) node.vz = (node.vz ?? 0) + impulse.z * scale
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    const currentSettings = readSettings()
    const map = new Map(nodes.map((node) => [node.id, node]))
    const candidates = links.flatMap((link) => {
      const source = linkNode(link.source, map)
      const target = linkNode(link.target, map)
      return source && target ? [[source, target] as [GraphNode, GraphNode]] : []
    })
    // Use loaded links for degree weights, including graphs without metadata.
    // Hub links are handled separately by the asymmetric hub force.
    const degrees = new Map<GraphNode, number>()
    for (const [source, target] of candidates) {
      degrees.set(source, (degrees.get(source) ?? 0) + 1)
      degrees.set(target, (degrees.get(target) ?? 0) + 1)
    }
    const weighted = candidates
      .filter(([source, target]) => source !== target && !hubIds.has(source.id) && !hubIds.has(target.id))
      .map(([source, target]) => {
        const sourceDegree = Math.max(1, degrees.get(source) ?? 0)
        const targetDegree = Math.max(1, degrees.get(target) ?? 0)
        const weight = Math.max(currentSettings.linkWeightFloor, 1 / Math.sqrt(sourceDegree * targetDegree))
        return [source, target, Math.max(0, weight)] as const
      })
    const totals = new Map<GraphNode, number>()
    for (const [source, target, weight] of weighted) {
      totals.set(source, (totals.get(source) ?? 0) + weight)
      totals.set(target, (totals.get(target) ?? 0) + weight)
    }
    // Bound total attraction even when hundreds of links share a node or
    // degree metadata is absent. Both endpoints still get equal impulses.
    resolved = weighted.map(([source, target, weight]) => [
      source, target, weight / Math.max(1, totals.get(source) ?? 0, totals.get(target) ?? 0),
    ])
    void simulationNodes
  }
  return force
}

function pairKey(first: string, second: string) {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`
}

/** Exact hub interactions cost O(articles × hubs), with at most 100 hubs. */
export function hubInteractions(
  links: GraphLink[],
  settings: GraphSimulationSettings,
  hubIds: ReadonlySet<string>,
  hubScore: (node: GraphNode) => number,
  dimensions: 2 | 3 = 2,
  readSettings: () => GraphSimulationSettings = () => settings,
) {
  let nodes: GraphNode[] = []
  let hubs: number[] = []
  let neighbors = new Map<number, Set<number>>()
  let memberships: number[] = []
  let scores: number[] = []
  let impulses = new Float64Array(0)
  const force = (alpha: number) => {
    const current = readSettings()
    const temperature = Math.max(0, alpha)
    impulses.fill(0)
    const add = (index: number, x: number, y: number, z: number, magnitude: number) => {
      impulses[index * 3] += x * magnitude
      impulses[index * 3 + 1] += y * magnitude
      impulses[index * 3 + 2] += z * magnitude
    }
    for (const hubIndex of hubs) {
      const hub = nodes[hubIndex]
      const connected = neighbors.get(hubIndex)!
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]
        const otherHub = hubIds.has(node.id)
        if (index === hubIndex || (otherHub && index < hubIndex)) continue
        let dx = (node.x ?? 0) - (hub.x ?? 0)
        let dy = (node.y ?? 0) - (hub.y ?? 0)
        let dz = dimensions === 3 ? (node.z ?? 0) - (hub.z ?? 0) : 0
        let distance = Math.hypot(dx, dy, dz)
        if (!Number.isFinite(distance)) continue
        if (distance < 0.001) {
          const angle = (hubIndex * 7919 + index * 104729) * 2.399963229728653
          dx = Math.cos(angle); dy = Math.sin(angle); dz = 0; distance = 1
        }
        const ux = dx / distance; const uy = dy / distance; const uz = dz / distance
        if (!otherHub && connected.has(index)) {
          const extension = Math.min(1024, Math.max(0, distance - 48))
          const exponent = current.linkDistanceExponent === 3 ? 3 : 2
          const distanceScale = Number.isFinite(current.linkDistanceScale) ? Math.max(1, current.linkDistanceScale) : 150_000
          const pull = 3 * Math.min(192, extension ** exponent / distanceScale + 0.16 * extension) * temperature
          // A hub's popularity does not weaken its pull on each article.
          // Shared articles split their response between their linked hubs.
          add(index, ux, uy, uz, -pull / Math.max(1, memberships[index]))
          // All of a hub's articles together exert only a small reaction.
          add(hubIndex, ux, uy, uz, pull * 0.02 / Math.max(1, connected.size))
        } else {
          const score = scores[hubIndex]
          const radius = otherHub
            ? current.hubTerritoryBase + current.hubTerritoryScale * (score + scores[index]) / 2
            : current.unrelatedDistance
          if (distance >= radius || radius <= 0) continue
          const deficit = 1 - distance / radius
          const strength = otherHub
            ? current.hubForceBase + current.hubForceScale * (score * scores[index]) ** 1.2 + current.hubCharge / Math.max(28, distance)
            : 4 * (current.unrelatedBaseStrength + current.unrelatedHubStrength * score) / Math.max(28, distance)
          const push = Math.min(current.hubForceMax, strength * deficit) * temperature
          add(index, ux, uy, uz, push)
          // Unrelated articles move out of the territory without dragging its hub.
          if (otherHub) add(hubIndex, ux, uy, uz, -push)
        }
      }
    }
    nodes.forEach((node, index) => {
      const x = impulses[index * 3]; const y = impulses[index * 3 + 1]; const z = impulses[index * 3 + 2]
      const magnitude = Math.hypot(x, y, z)
      if (!Number.isFinite(magnitude) || magnitude === 0) return
      const scale = Math.min(1, 1024 * temperature / magnitude)
      node.vx = (node.vx ?? 0) + x * scale
      node.vy = (node.vy ?? 0) + y * scale
      if (dimensions === 3) node.vz = (node.vz ?? 0) + z * scale
    })
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    nodes = simulationNodes
    hubs = nodes.flatMap((node, index) => hubIds.has(node.id) ? [index] : [])
    neighbors = new Map(hubs.map(index => [index, new Set<number>()]))
    const byId = new Map(nodes.map((node, index) => [node.id, index]))
    for (const link of links) {
      const source = byId.get(typeof link.source === 'string' ? link.source : link.source.id)
      const target = byId.get(typeof link.target === 'string' ? link.target : link.target.id)
      if (source == null || target == null || source === target) continue
      if (!hubIds.has(nodes[target].id)) neighbors.get(source)?.add(target)
      if (!hubIds.has(nodes[source].id)) neighbors.get(target)?.add(source)
    }
    memberships = nodes.map(() => 0)
    for (const connected of neighbors.values()) for (const index of connected) memberships[index]++
    scores = nodes.map(node => hubIds.has(node.id) ? hubScore(node) : 0)
    impulses = new Float64Array(nodes.length * 3)
  }
  return force
}

/**
 * Adds relationship-aware separation on top of d3's Barnes–Hut charge. A
 * spatial grid keeps the exact unlinked-pair check local; the interaction
 * budget and rotating traversal keep dense 25k-node tiers responsive.
 */
export function unrelatedRepulsion(
  links: GraphLink[],
  initialNodes: GraphNode[],
  largeGraph: boolean,
  settings: GraphSimulationSettings,
  hubIds: ReadonlySet<string>,
  hubScore: (node: GraphNode) => number,
  repulsionScale = 1,
) {
  const relatedLinkBudget = largeGraph ? 250_000 : Number.POSITIVE_INFINITY
  let orderedNodes = initialNodes
  let nodeOrder = new Map<GraphNode, number>()
  let relatedPairs = new Set<string>()
  let hubScores = new Map<GraphNode, number>()
  let tickIndex = 0
  const force = (alpha: number) => {
    const cellSize = largeGraph ? 240 : 200
    const maxDistance = largeGraph ? Math.min(settings.unrelatedDistance, 480) : Math.min(settings.unrelatedDistance, 420)
    const cellRadius = Math.ceil(maxDistance / cellSize)
    const cells = new Map<string, GraphNode[]>()
    for (const node of orderedNodes) {
      if (node.x == null || node.y == null || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`
      const bucket = cells.get(key)
      if (bucket) bucket.push(node)
      else cells.set(key, [node])
    }

    let examinedPairs = 0
    const interactionBudget = orderedNodes.length < 2_000
      ? Number.POSITIVE_INFINITY
      : largeGraph ? settings.unrelatedInteractionBudget : settings.unrelatedInteractionBudget * 1.45
    // Spread budgeted work across the graph instead of moving just one
    // article per tick and starving the tail of a multi-thousand-node list.
    const start = orderedNodes.length ? Math.floor(((tickIndex++ * 0.618033988749895) % 1) * orderedNodes.length) : 0
    outer: for (let visited = 0; visited < orderedNodes.length; visited += 1) {
      const sourceIndex = (start + visited) % orderedNodes.length
      const source = orderedNodes[sourceIndex]
      if (source.x == null || source.y == null || !Number.isFinite(source.x) || !Number.isFinite(source.y)) continue
      const sourceCellX = Math.floor(source.x / cellSize)
      const sourceCellY = Math.floor(source.y / cellSize)
      for (let cellX = sourceCellX - cellRadius; cellX <= sourceCellX + cellRadius; cellX += 1) {
        for (let cellY = sourceCellY - cellRadius; cellY <= sourceCellY + cellRadius; cellY += 1) {
          const bucket = cells.get(`${cellX},${cellY}`)
          if (!bucket) continue
          for (const target of bucket) {
            examinedPairs += 1
            if (examinedPairs > interactionBudget) break outer
            const targetIndex = nodeOrder.get(target)
            if (targetIndex == null || targetIndex <= sourceIndex) continue
            // Hub interactions have their own exact, unbudgeted pass.
            if (hubIds.has(source.id) || hubIds.has(target.id)) continue
            if (relatedPairs.has(pairKey(source.id, target.id))) continue
            let dx = source.x - (target.x as number)
            let dy = source.y - (target.y as number)
            let distance = Math.hypot(dx, dy)
            if (distance < 0.001) {
              const angle = ((sourceIndex * 7919 + targetIndex * 104729) % 360) * Math.PI / 180
              dx = Math.cos(angle)
              dy = Math.sin(angle)
              distance = 1
            }
            if (distance > maxDistance) continue
            const falloff = 1 - distance / maxDistance
            const hubBoost = Math.max(hubScores.get(source) ?? 0, hubScores.get(target) ?? 0)
            const magnitude = Math.min(14, ((settings.unrelatedBaseStrength * repulsionScale + settings.unrelatedHubStrength * hubBoost) / Math.max(28, distance)) * falloff) * alpha
            const vx = dx / distance * magnitude
            const vy = dy / distance * magnitude
            source.vx = (source.vx ?? 0) + vx
            source.vy = (source.vy ?? 0) + vy
            target.vx = (target.vx ?? 0) - vx
            target.vy = (target.vy ?? 0) - vy
          }
        }
      }
    }
  }
  force.initialize = (simulationNodes: GraphNode[]) => {
    orderedNodes = [...simulationNodes]
      .sort((a, b) => ((b.inDegree ?? 0) + (b.outDegree ?? 0)) - ((a.inDegree ?? 0) + (a.outDegree ?? 0)) || a.id.localeCompare(b.id))
    nodeOrder = new Map(orderedNodes.map((node, index) => [node, index]))
    hubScores = new Map(orderedNodes.map((node) => [node, hubScore(node)]))
    const byId = new Map(orderedNodes.map((node) => [node.id, node]))
    relatedPairs = new Set<string>()
    const relatedLinks = links.length > relatedLinkBudget
      ? links.filter((_, index) => index % Math.ceil(links.length / relatedLinkBudget) === 0)
      : links
    for (const link of relatedLinks) {
      const source = linkNode(link.source, byId)
      const target = linkNode(link.target, byId)
      // A direct hub-to-hub edge is intentionally not a physics relationship;
      // let the hub territory force keep those structural anchors apart.
      if (source && target && source !== target && !(hubIds.has(source.id) && hubIds.has(target.id))) {
        relatedPairs.add(pairKey(source.id, target.id))
      }
    }
  }
  return force
}
