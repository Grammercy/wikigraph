export type HubCandidate = {
  id: string
  inDegree?: number
  outDegree?: number
}

export type HubLink = {
  source: string | HubCandidate
  target: string | HubCandidate
}

export const HUB_PERCENT = 0.05
export const MAX_HUB_COUNT = 100

export function articleDegree(node: HubCandidate): number {
  return Math.max(0, (node.inDegree ?? 0) + (node.outDegree ?? 0))
}

/** Return the number of articles that should be treated as structural hubs. */
export function hubCount(articleCount: number): number {
  if (!Number.isFinite(articleCount) || articleCount <= 0) return 0
  return Math.min(MAX_HUB_COUNT, Math.max(1, Math.ceil(articleCount * HUB_PERCENT)))
}

/**
 * Select the most-connected non-adjacent articles. The requested hub count is
 * an upper bound: a direct link between two candidates prevents both from
 * being selected as hubs.
 */
export function selectHubIds(nodes: readonly HubCandidate[], links: readonly HubLink[] = []): Set<string> {
  const count = hubCount(nodes.length)
  if (count === 0) return new Set()
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]))
  const endpointId = (endpoint: string | HubCandidate) => typeof endpoint === 'string' ? endpoint : endpoint.id
  for (const link of links) {
    const source = endpointId(link.source)
    const target = endpointId(link.target)
    if (source === target) continue
    adjacency.get(source)?.add(target)
    adjacency.get(target)?.add(source)
  }

  const selected = new Set<string>()
  for (const node of [...nodes].sort((a, b) => articleDegree(b) - articleDegree(a) || a.id.localeCompare(b.id))) {
    let touchesSelected = false
    for (const neighbor of adjacency.get(node.id) ?? []) {
      if (selected.has(neighbor)) {
        touchesSelected = true
        break
      }
    }
    if (touchesSelected) continue
    selected.add(node.id)
    if (selected.size >= count) break
  }
  return selected
}
