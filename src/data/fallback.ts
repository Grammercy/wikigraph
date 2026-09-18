import type { WikiGraph, WikiNode } from '../types'

// A small, coherent seed graph keeps the app useful when the API is unavailable.
const ARTICLES = [
  'Science', 'Technology', 'Mathematics', 'Physics', 'Biology', 'Chemistry',
  'Computer science', 'Artificial intelligence', 'Internet', 'World Wide Web',
  'Programming language', 'Data science', 'Astronomy', 'Earth', 'Climate change',
  'Evolution', 'Medicine', 'Psychology', 'Philosophy', 'History', 'Geography',
  'Culture', 'Art', 'Music', 'Literature', 'Film', 'Architecture', 'Education',
  'Economics', 'Politics', 'Society', 'Language', 'Religion', 'Space exploration',
  'Solar System', 'Planet', 'Human', 'Animal', 'Plant', 'Ocean', 'Energy',
  'Renewable energy', 'Electricity', 'Quantum mechanics', 'Relativity', 'Genetics',
  'Neuroscience', 'Robotics', 'Machine learning', 'Computer network', 'Database',
]

export function buildFallbackGraph(count: number): WikiGraph {
  const size = Math.max(1, Math.min(Math.floor(count) || 1, ARTICLES.length))
  const titles = ARTICLES.slice(0, size)
  const links: Array<{ source: string; target: string }> = []
  const edgeKeys = new Set<string>()
  // The offline graph is intentionally small, but it should still feel like a
  // knowledge neighbourhood. Two circular neighbours per article guarantee a
  // two-link average for normal demo sizes instead of presenting a thin chain.
  for (let i = 0; i < size; i += 1) {
    for (const offset of [1, 2, 4]) {
      if (size < 2) continue
      const target = titles[(i + offset) % size]
      if (target === titles[i]) continue
      const edgeKey = `${titles[i]}\u0000${target}`
      if (edgeKeys.has(edgeKey)) continue
      edgeKeys.add(edgeKey)
      links.push({ source: titles[i], target })
    }
  }
  const inDegree = new Map(titles.map((title) => [title, 0]))
  const outDegree = new Map(titles.map((title) => [title, 0]))
  for (const link of links) {
    outDegree.set(link.source, (outDegree.get(link.source) ?? 0) + 1)
    inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1)
  }
  const nodes: WikiNode[] = titles.map((title) => ({
    id: title,
    title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, '_')}`,
    extract: `A Wikipedia article about ${title}.`,
    inDegree: inDegree.get(title),
    outDegree: outDegree.get(title),
  }))
  return { nodes, links, source: 'fallback' }
}
