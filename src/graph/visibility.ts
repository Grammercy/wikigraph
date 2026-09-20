import { articleDegree, selectHubIds, type HubCandidate, type HubLink } from './hubs'

/**
 * Pick the nodes that should be painted without changing the force-layout
 * graph. Hubs are always retained, then the remaining slots go to the most
 * connected articles. A selected article expands the paint set to its whole
 * one-hop neighbourhood so its relationships can be explored even when the
 * display limit is small.
 */
export function selectVisibleArticleIds(
  nodes: readonly HubCandidate[],
  links: readonly HubLink[],
  displayCount: number,
  selectedId?: string | null,
): Set<string> {
  const hubIds = selectHubIds(nodes, links)
  const visible = new Set<string>(hubIds)
  const limit = Math.max(hubIds.size, Math.min(nodes.length, Math.floor(displayCount) || hubIds.size))

  const ranked = [...nodes]
    .filter((node) => !hubIds.has(node.id))
    .sort((a, b) => articleDegree(b) - articleDegree(a) || a.id.localeCompare(b.id))
  for (const node of ranked) {
    if (visible.size >= limit) break
    visible.add(node.id)
  }

  if (selectedId) {
    if (nodes.some((node) => node.id === selectedId)) visible.add(selectedId)
    const endpointId = (endpoint: string | HubCandidate) => typeof endpoint === 'string' ? endpoint : endpoint.id
    for (const link of links) {
      const source = endpointId(link.source)
      const target = endpointId(link.target)
      if (source === selectedId) visible.add(target)
      if (target === selectedId) visible.add(source)
    }
  }

  return visible
}
