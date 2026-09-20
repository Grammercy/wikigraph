import type { GraphLink, GraphNode } from '../components/GraphCanvas'

/** Scale repulsion from loaded neighbors, independent of article count. */
export function articleRepulsionScale(nodes: GraphNode[], links: GraphLink[]): number {
  if (nodes.length < 2) return 1
  const indices = new Map(nodes.map((node, index) => [node.id, index]))
  const pairs = new Set<string>()
  for (const link of links) {
    const source = indices.get(typeof link.source === 'string' ? link.source : link.source.id)
    const target = indices.get(typeof link.target === 'string' ? link.target : link.target.id)
    if (source == null || target == null || source === target) continue
    pairs.add(source < target ? `${source}:${target}` : `${target}:${source}`)
  }
  const averageDegree = 2 * pairs.size / nodes.length
  // Keep sparse maps unchanged. Square-root growth preserves clustering;
  // the ceiling limits pressure against the soft boundary on dense maps.
  return Math.min(3, Math.sqrt(Math.max(1, averageDegree / 6)))
}
