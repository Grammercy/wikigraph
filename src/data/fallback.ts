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
  const links = []
  // Local chain plus longer-range links gives the fallback a few visible clusters.
  for (let i = 0; i < size; i += 1) {
    if (i + 1 < size) links.push({ source: titles[i], target: titles[i + 1] })
    if (i + 3 < size && i % 2 === 0) links.push({ source: titles[i], target: titles[i + 3] })
    if (i + 8 < size && i % 5 === 0) links.push({ source: titles[i], target: titles[i + 8] })
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
