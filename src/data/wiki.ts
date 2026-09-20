import type { WikiGraph, WikiLink, WikiNode, WikiStats } from '../types'
import { buildFallbackGraph } from './fallback'

const API = 'https://en.wikipedia.org/w/api.php'
const REQUEST_TIMEOUT = 12_000
const MAX_BATCH = 50
const PUBLIC_MAX_NODES = 500
const LOCAL_API_PREVIEW_MAX_NODES = 1_000
const PUBLIC_CANDIDATE_MAX_NODES = 1_500
const MAX_LINKS_PER_PAGE = 500
const CANDIDATE_MULTIPLIER = 3
// Keep the browser crawl bounded while retaining enough of each page's local
// neighbourhood to form a link-dense induced subgraph. A thin 45-link sample
// tends to produce a tree after filtering to the requested node count.
const MAX_LINK_CONTINUATIONS = 0

// Random Wikipedia pages are frequently leaves or tiny disjoint topics. Each
// cluster below starts from a well-connected neighbourhood, then the crawler
// still adds random titles so repeated generations do not become identical.
const DENSE_SEED_CLUSTERS = [
  ['Science', 'Physics', 'Mathematics', 'Chemistry', 'Biology', 'Astronomy', 'Earth', 'Medicine', 'Technology', 'Engineering', 'Computer science', 'Artificial intelligence'],
  ['History', 'Geography', 'Politics', 'Economics', 'Society', 'Culture', 'Philosophy', 'Religion', 'Language', 'Education', 'Law', 'Government'],
  ['Art', 'Music', 'Literature', 'Film', 'Architecture', 'Theatre', 'Painting', 'Sculpture', 'Dance', 'Photography', 'Design', 'Poetry'],
  ['Internet', 'World Wide Web', 'Software', 'Programming language', 'Data science', 'Machine learning', 'Robotics', 'Computer network', 'Database', 'Information technology', 'Cryptography', 'Video game'],
  ['Association football', 'Football', 'Olympic Games', 'Sport', 'Basketball', 'Baseball', 'Tennis', 'Cricket', 'Rugby football', 'Athletics', 'Swimming', 'Motorsport'],
]

interface ApiPage {
  pageid?: number
  ns?: number
  title?: string
  extract?: string
  length?: number
  links?: Array<{ ns?: number; title?: string }>
  pageprops?: { disambiguation?: string }
}

function isDisambiguationPage(page: ApiPage): boolean {
  return Boolean(page.pageprops && Object.prototype.hasOwnProperty.call(page.pageprops, 'disambiguation'))
}

interface ApiResponse {
  continue?: { plcontinue?: string; continue?: string }
  query?: {
    random?: Array<{ title?: string }>
    normalized?: Array<{ from?: string; to?: string }>
    redirects?: Array<{ from?: string; to?: string }>
    pages?: ApiPage[] | Record<string, ApiPage>
  }
}

/**
 * Optional local corpus endpoint. A dump-backed service can expose the same
 * compact graph shape as the browser crawler and be enabled with
 * VITE_WIKIGRAPH_INDEX_URL (for example, http://127.0.0.1:8787/api/graph).
 * Keeping this opt-in means the hosted/static UI still works without a local
 * multi-gigabyte Wikipedia index.
 */
const configuredLocalIndex = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_WIKIGRAPH_INDEX_URL?.trim()
const localHost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
// Use the host directly for local browsers instead of relying only on the
// Vite proxy. That keeps the corpus-size probe working from both `vite dev`
// and `vite preview`; the host explicitly allows cross-origin local requests.
// GitHub Pages and other public hosts stay on Wikipedia's API.
const LOCAL_INDEX_URL = configuredLocalIndex || (localHost ? 'http://127.0.0.1:8787/api/graph' : undefined)
// The local corpus size is discovered from /api/stats. Keep this transport
// guard above any realistic Wikipedia dump so a complete downloaded index is
// not silently truncated before the request reaches the local server.
const LOCAL_MAX_NODES = Number.MAX_SAFE_INTEGER
export const usesLocalCorpus = Boolean(LOCAL_INDEX_URL)

function isWikiGraph(value: unknown): value is WikiGraph {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WikiGraph>
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.links)) return false
  // Full tiers can contain hundreds of thousands of nodes and many more
  // links. Validate a deterministic sample plus the endpoints instead of
  // walking every object on the main thread before rendering anything.
  const sampled = <T>(items: T[], valid: (item: T) => boolean) => {
    const step = Math.max(1, Math.ceil(items.length / 2_000))
    for (let index = 0; index < items.length; index += step) {
      if (!valid(items[index])) return false
    }
    return (items.length === 0 || valid(items[items.length - 1]))
  }
  return sampled(candidate.nodes, (node) => Boolean(node && typeof node.id === 'string' && typeof node.title === 'string'))
    && sampled(candidate.links, (link) => Boolean(link && link.source != null && link.target != null))
}

async function fetchLocalGraph(count: number, signal?: AbortSignal): Promise<WikiGraph | null> {
  if (!LOCAL_INDEX_URL) return null
  const url = new URL(LOCAL_INDEX_URL, window.location.origin)
  url.searchParams.set('count', String(count))
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Local Wikipedia index returned HTTP ${response.status}`)
  const graph = await response.json() as unknown
  if (!isWikiGraph(graph)) throw new Error('Local Wikipedia index returned an invalid graph')
  // The local server uses a tiny fallback payload while an index is being
  // built. Treat that as unavailable so the live API remains the next source
  // of truth instead of mislabeling synthetic edges as Wikipedia data.
  const metadata = graph as WikiGraph & { indexed?: boolean }
  if (metadata.source === 'fallback' || metadata.indexed === false) return null
  if (graph.nodes.length < count) {
    throw new Error(`Local Wikipedia index returned ${graph.nodes.length.toLocaleString()} of ${count.toLocaleString()} requested articles`)
  }
  return { ...graph, source: 'wikipedia', local: true }
}

function titleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ')
}

function titleId(title: string): string {
  return titleKey(title).toLocaleLowerCase('en-US')
}

function articleUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, '_')}`
}

async function request(params: Record<string, string>, signal?: AbortSignal): Promise<ApiResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const url = new URL(API)
    Object.entries({ ...params, format: 'json', formatversion: '2', origin: '*' }).forEach(([key, value]) => url.searchParams.set(key, value))
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}`)
    return await response.json() as ApiResponse
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

async function randomTitles(count: number, signal?: AbortSignal): Promise<string[]> {
  try {
    const data = await request({ action: 'query', list: 'random', rnnamespace: '0', rnlimit: String(Math.min(count, 50)) }, signal)
    return (data.query?.random ?? []).map((item) => item.title ? titleKey(item.title) : '').filter(Boolean)
  } catch (error) {
    if (signal?.aborted) throw error
    return []
  }
}

function denseSeedTitles(randomTitlesFromApi: string[], maxSeeds: number): string[] {
  // Seed every broad neighbourhood in a round-robin order. That gives the
  // density selector several genuinely connected pockets to choose from,
  // instead of betting the whole request on one occasionally sparse topic.
  const clusterSeeds: string[] = []
  const start = Math.floor(Math.random() * DENSE_SEED_CLUSTERS.length)
  for (let index = 0; index < maxSeeds; index += 1) {
    const cluster = DENSE_SEED_CLUSTERS[(start + index) % DENSE_SEED_CLUSTERS.length]
    const item = cluster[Math.floor(index / DENSE_SEED_CLUSTERS.length)]
    if (item) clusterSeeds.push(item)
  }
  const randomTail = randomTitlesFromApi.slice(0, Math.min(8, Math.max(0, maxSeeds - clusterSeeds.length)))
  return [...new Set([...clusterSeeds, ...randomTail])].slice(0, Math.min(maxSeeds, 50))
}

interface PageBatchResult {
  pages: ApiPage[]
  aliases: Map<string, string>
}

/**
 * Pick a link-dense neighbourhood instead of taking the first breadth-first
 * pages that happen to be discovered. The public API crawl often finds a
 * dozen plausible neighbours for every page; selecting the densest connected
 * pocket keeps the map useful and targets at least two internal links per
 * article on average whenever the fetched candidates can support it.
 */
function linkDensePageOrder(pages: Map<string, ApiPage>, rawLinks: Array<[string, string]>, limit: number): string[] {
  const titles = [...pages.keys()]
  const byTitle = new Map(titles.map((title) => [titleId(title), title]))
  const outgoing = new Map(titles.map((title) => [title, new Set<string>()]))
  const incoming = new Map(titles.map((title) => [title, new Set<string>()]))
  for (const [source, target] of rawLinks) {
    const sourceTitle = byTitle.get(titleId(source))
    const targetTitle = byTitle.get(titleId(target))
    if (!sourceTitle || !targetTitle || sourceTitle === targetTitle) continue
    outgoing.get(sourceTitle)?.add(targetTitle)
    incoming.get(targetTitle)?.add(sourceTitle)
  }

  const wanted = Math.min(Math.max(1, limit), titles.length)
  const degree = (title: string) => (outgoing.get(title)?.size ?? 0) + (incoming.get(title)?.size ?? 0)
  const compareTitles = (a: string, b: string) => titleId(a).localeCompare(titleId(b)) || a.localeCompare(b)
  // Peel the lowest-outlink pages first. This is a directed k-core style
  // selection: every removal updates the pages that pointed at it, so the
  // surviving set maximizes internal outgoing links instead of preserving a
  // breadth-first tree by accident.
  const core = new Set(titles)
  const internalOut = new Map(titles.map((title) => [title, [...(outgoing.get(title) ?? [])].filter((target) => core.has(target)).length]))
  while (core.size > wanted) {
    let remove = ''
    for (const candidate of core) {
      if (!remove) {
        remove = candidate
        continue
      }
      const candidateOut = internalOut.get(candidate) ?? 0
      const removeOut = internalOut.get(remove) ?? 0
      const candidateDegree = degree(candidate)
      const removeDegree = degree(remove)
      if (candidateOut < removeOut
        || (candidateOut === removeOut && candidateDegree < removeDegree)
        || (candidateOut === removeOut && candidateDegree === removeDegree && compareTitles(candidate, remove) > 0)) remove = candidate
    }
    if (!remove) break
    core.delete(remove)
    for (const source of incoming.get(remove) ?? []) {
      if (core.has(source)) internalOut.set(source, Math.max(0, (internalOut.get(source) ?? 0) - 1))
    }
  }

  // The peel above keeps the strongest local core, but ties can leave a
  // slightly less dense exact-size pocket than another nearby combination.
  // Make a bounded series of improving swaps while preserving the requested
  // article count. This stays bounded by the public candidate pool and
  // directly optimizes the number of links that remain inside the selection.
  const incidentLinks = (title: string, set: Set<string>) => {
    let total = 0
    for (const target of outgoing.get(title) ?? []) if (set.has(target)) total += 1
    for (const source of incoming.get(title) ?? []) if (set.has(source)) total += 1
    return total
  }
  const selected = new Set(core)
  const excluded = new Set(titles.filter((title) => !selected.has(title)))
  for (let pass = 0; pass < Math.min(16, wanted); pass += 1) {
    let bestCandidate = ''
    let bestRemove = ''
    let bestDelta = 0
    for (const candidate of excluded) {
      for (const remove of selected) {
        let added = 0
        for (const target of outgoing.get(candidate) ?? []) if (selected.has(target) && target !== remove) added += 1
        for (const source of incoming.get(candidate) ?? []) if (selected.has(source) && source !== remove) added += 1
        const delta = added - incidentLinks(remove, selected)
        if (delta > bestDelta || (delta === bestDelta && delta > 0 && (!bestCandidate || compareTitles(candidate, bestCandidate) < 0))) {
          bestCandidate = candidate
          bestRemove = remove
          bestDelta = delta
        }
      }
    }
    if (!bestCandidate || bestDelta <= 0) break
    selected.delete(bestRemove)
    selected.add(bestCandidate)
    excluded.delete(bestCandidate)
    excluded.add(bestRemove)
  }

  // Render the retained core as one connected walk for a coherent first view.
  const remaining = new Set(selected)
  const order: string[] = []
  while (order.length < selected.size && remaining.size) {
    let best = ''
    let bestConnection = -1
    let bestDegree = -1
    for (const candidate of remaining) {
      let connection = 0
      for (const target of outgoing.get(candidate) ?? []) if (selected.has(target) && !remaining.has(target)) connection += 1
      for (const source of incoming.get(candidate) ?? []) if (selected.has(source) && !remaining.has(source)) connection += 1
      const candidateDegree = degree(candidate)
      if (connection > bestConnection || (connection === bestConnection && candidateDegree > bestDegree) || (connection === bestConnection && candidateDegree === bestDegree && (!best || compareTitles(candidate, best) < 0))) {
        best = candidate
        bestConnection = connection
        bestDegree = candidateDegree
      }
    }
    if (!best) break
    remaining.delete(best)
    order.push(best)
  }
  return order
}

async function pageBatch(titles: string[], signal?: AbortSignal): Promise<PageBatchResult> {
  if (!titles.length) return { pages: [], aliases: new Map() }
  const pages: ApiPage[] = []
  const aliases = new Map<string, string>()
  let continuation: { plcontinue?: string; continue?: string } | undefined
  for (let attempt = 0; attempt <= MAX_LINK_CONTINUATIONS; attempt += 1) {
    const data = await request({
      action: 'query', titles: titles.join('|'), prop: 'extracts|links|info|pageprops', inprop: 'url', exintro: '1', explaintext: '1', exchars: '280',
      plnamespace: '0', pllimit: String(MAX_LINKS_PER_PAGE), redirects: '1', ...(continuation ?? {}),
    }, signal)
    for (const mapping of [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])]) {
      if (mapping.from && mapping.to) aliases.set(titleId(mapping.from), titleKey(mapping.to))
    }
    const batch = Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages ?? {})
    pages.push(...batch.filter((page) => page.title
      && (page.ns == null || page.ns === 0)
      && !/\s+\(disambiguation\)$/i.test(page.title)
      && !isDisambiguationPage(page)))
    continuation = data.continue?.plcontinue ? data.continue : undefined
    if (!continuation) break
  }
  return { pages, aliases }
}

/** Fetch a bounded graph grown from random article seeds; falls back gracefully offline. */
export async function fetchWikiGraph(count: number, signal?: AbortSignal): Promise<WikiGraph> {
  const wanted = Math.max(1, Math.min(Math.floor(count) || 1, LOCAL_INDEX_URL ? LOCAL_MAX_NODES : PUBLIC_MAX_NODES))
  try {
    // Prefer a dump-backed local service when configured. It can serve the
    // complete corpus while preserving the same UI contract and slider.
    try {
      const local = await fetchLocalGraph(wanted, signal)
      if (local) return local
    } catch (localError) {
      // A local index is optional: if it is offline, malformed, or still
      // rebuilding, continue with the public API instead of jumping straight
      // to demo data. Preserve cancellation semantics for the active request.
      // Once a large local request is made, do not silently replace it with a
      // 1k public preview; that makes a stale 100k host look successful.
      if (signal?.aborted || (LOCAL_INDEX_URL && wanted > LOCAL_API_PREVIEW_MAX_NODES)) throw localError
    }
    // A local endpoint can be present while its dump is still being parsed or
    // indexed. Never turn that temporary state into a huge public-API crawl.
    // The public API remains intentionally bounded and is only a preview until
    // the local tiers become available.
    const publicWanted = Math.min(wanted, LOCAL_INDEX_URL ? LOCAL_API_PREVIEW_MAX_NODES : PUBLIC_MAX_NODES)
    // Over-fetch a bounded candidate pool, then choose a dense neighbourhood.
    // A 50-article request therefore has enough context to avoid returning a
    // thin tree even when the random seeds land in unrelated topics.
    const candidateTarget = Math.min(PUBLIC_CANDIDATE_MAX_NODES, Math.max(publicWanted, publicWanted * CANDIDATE_MULTIPLIER))
    const randomSeeds = await randomTitles(Math.min(Math.max(5, Math.ceil(candidateTarget / 32)), 12), signal)
    const seeds = denseSeedTitles(randomSeeds, Math.min(Math.max(12, Math.ceil(candidateTarget / 8)), 50))
    const queue = [...new Map(seeds.map((title) => [titleId(title), title])).values()]
    const queued = new Set(queue.map(titleId))
    const frontierScore = new Map<string, number>()
    const aliases = new Map<string, string>()
    const seen = new Set<string>()
    const pages = new Map<string, ApiPage>()
    const rawLinks: Array<[string, string]> = []
    while (queue.length && seen.size < candidateTarget) {
      queue.sort((a, b) => (frontierScore.get(titleId(b)) ?? 0) - (frontierScore.get(titleId(a)) ?? 0) || titleId(a).localeCompare(titleId(b)))
      const batch = queue.splice(0, MAX_BATCH).filter((title) => {
        queued.delete(titleId(title))
        return !seen.has(titleId(title))
      })
      if (!batch.length) continue
      const fetched = await pageBatch(batch, signal)
      for (const [alias, canonical] of fetched.aliases) aliases.set(alias, canonical)
      for (const page of fetched.pages) {
        const source = titleKey(page.title!)
        const sourceId = titleId(source)
        if (seen.has(sourceId)) continue
        seen.add(sourceId)
        pages.set(source, page)
        for (const link of (page.links ?? [])) {
          if (!link.title) continue
          const target = titleKey(link.title)
          const targetCanonical = aliases.get(titleId(target)) ?? target
          const targetId = titleId(targetCanonical)
          rawLinks.push([source, targetCanonical])
          frontierScore.set(targetId, (frontierScore.get(targetId) ?? 0) + 1)
          if (!seen.has(targetId) && !queued.has(targetId) && queue.length + seen.size < candidateTarget * 2) {
            queue.push(targetCanonical)
            queued.add(targetId)
          }
        }
      }
    }
    // Resolve aliases after the complete crawl. A page can link to a redirect
    // before the batch containing that redirect's canonical title is fetched;
    // canonicalizing only at enqueue time silently drops those edges later.
    const resolveAlias = (value: string) => {
      let current = titleKey(value)
      const visited = new Set<string>()
      while (!visited.has(titleId(current))) {
        visited.add(titleId(current))
        const next = aliases.get(titleId(current))
        if (!next) break
        current = titleKey(next)
      }
      return current
    }
    const canonicalPages = new Map<string, ApiPage>()
    for (const [title, page] of pages) canonicalPages.set(resolveAlias(title), page)
    const canonicalLinks = rawLinks.map(([source, target]) => [resolveAlias(source), resolveAlias(target)] as [string, string])
    const orderedTitles = linkDensePageOrder(canonicalPages, canonicalLinks, publicWanted)
    const nodes: WikiNode[] = orderedTitles.slice(0, publicWanted).map((title) => {
      const page = canonicalPages.get(title)!
      return { id: title, title, url: articleUrl(title), extract: page.extract, byteLength: page.length }
    })
    const canonicalById = new Map(nodes.map((node) => [titleId(node.id), node.id]))
    const uniqueLinks = new Map<string, [string, string]>()
    for (const [source, target] of canonicalLinks) {
      const sourceId = canonicalById.get(titleId(source))
      const targetId = canonicalById.get(titleId(target))
      if (sourceId && targetId && sourceId !== targetId) {
        uniqueLinks.set(`${sourceId}\u0000${targetId}`, [sourceId, targetId])
      }
    }
    const links: WikiLink[] = [...uniqueLinks.values()]
      .map(([source, target]) => ({ source, target }))
    const nodeMap = new Map(nodes.map((node) => [titleId(node.id), node]))
    for (const link of links) {
      const source = nodeMap.get(titleId(link.source as string))
      const target = nodeMap.get(titleId(link.target as string))
      if (source) source.outDegree = (source.outDegree ?? 0) + 1
      if (target) target.inDegree = (target.inDegree ?? 0) + 1
    }
    return nodes.length ? { nodes, links, source: 'wikipedia', local: false } : { ...buildFallbackGraph(publicWanted), source: 'fallback', local: false }
  } catch (error) {
    if (signal?.aborted) throw error
    return { ...buildFallbackGraph(Math.min(wanted, PUBLIC_MAX_NODES)), source: 'fallback', local: false }
  }
}

/** Read corpus progress/size when the local D:-drive API is available. */
export async function fetchWikiStats(signal?: AbortSignal): Promise<WikiStats | null> {
  if (!LOCAL_INDEX_URL) return null
  try {
    const url = new URL(LOCAL_INDEX_URL, window.location.origin)
    url.pathname = '/api/stats'
    url.search = ''
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const stats = await response.json() as unknown
    if (!stats || typeof stats !== 'object' || !Number.isFinite((stats as WikiStats).articles)) return null
    return stats as WikiStats
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

export type WikiGraphProgress = {
  loaded: number
  requested: number
  graph: WikiGraph
}

/**
 * Grow a graph in bounded batches so a large map never blocks the UI on one
 * enormous request. Each batch is emitted as soon as it arrives; callers can
 * render the partial graph while the remaining Wikipedia pages are fetched.
 */
export async function fetchWikiGraphProgressive(
  count: number,
  signal?: AbortSignal,
  onProgress?: (progress: WikiGraphProgress) => void,
): Promise<WikiGraph> {
  const requested = Math.max(1, Math.min(Math.floor(count) || 1, LOCAL_INDEX_URL ? LOCAL_MAX_NODES : PUBLIC_MAX_NODES))

  if (LOCAL_INDEX_URL) {
    // Local tiers are nested snapshots, so one requested-size response is
    // enough. Publishing the 1,000-node tier first makes a large graph render
    // twice and briefly replaces the requested map with an unrelated preview.
    const graph = await fetchWikiGraph(requested, signal)
    onProgress?.({ loaded: Math.min(graph.nodes.length, requested), requested, graph })
    return graph
  }

  const merged: WikiGraph = { nodes: [], links: [], source: 'wikipedia' }
  const nodeIds = new Set<string>()
  const linkIds = new Set<string>()
  let completed = 0

  while (completed < requested) {
    if (signal?.aborted) throw new DOMException('The graph request was cancelled.', 'AbortError')
    // The public API remains bounded to independent random batches.
    const nextTarget = Math.min(MAX_BATCH * 2, requested - completed)
    const batch = await fetchWikiGraph(nextTarget, signal)
    if (batch.source === 'fallback') merged.source = 'fallback'
    for (const node of batch.nodes) {
      if (nodeIds.has(node.id)) continue
      nodeIds.add(node.id)
      merged.nodes.push(node)
    }
    const available = new Set(merged.nodes.map((node) => node.id))
    for (const link of batch.links) {
      const source = typeof link.source === 'string' ? link.source : link.source.id
      const target = typeof link.target === 'string' ? link.target : link.target.id
      const key = `${source}\u0000${target}`
      if (source !== target && available.has(source) && available.has(target) && !linkIds.has(key)) {
        linkIds.add(key)
        merged.links.push({ source, target })
      }
    }
    completed += nextTarget
    onProgress?.({ loaded: Math.min(completed, requested), requested, graph: { ...merged, nodes: [...merged.nodes], links: [...merged.links] } })
    // A fallback graph is finite; avoid repeatedly emitting the same demo map.
    if (batch.source === 'fallback' && batch.nodes.length < nextTarget) break
  }
  return merged
}

export { buildFallbackGraph }
