import type { WikiGraph, WikiLink, WikiNode, WikiStats } from '../types'
import { buildFallbackGraph } from './fallback'

const API = 'https://en.wikipedia.org/w/api.php'
const REQUEST_TIMEOUT = 12_000
const MAX_BATCH = 50
const MAX_LINKS_PER_PAGE = 45
// Keep the browser crawl deliberately small. Each page already contributes a
// useful sample of outgoing links; following every continuation quickly trips
// Wikimedia's anonymous request throttles when a slider is moved repeatedly.
const MAX_LINK_CONTINUATIONS = 0

interface ApiPage {
  pageid?: number
  ns?: number
  title?: string
  extract?: string
  length?: number
  links?: Array<{ ns?: number; title?: string }>
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
// Local development and the D:-drive production host share the same API
// contract. GitHub Pages and other public hosts stay on Wikipedia's API.
const LOCAL_INDEX_URL = configuredLocalIndex || (localHost ? '/api/graph' : undefined)
const LOCAL_MAX_NODES = 25_000

function isWikiGraph(value: unknown): value is WikiGraph {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WikiGraph>
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.links)
    && candidate.nodes.every((node) => node && typeof node.id === 'string' && typeof node.title === 'string')
    && candidate.links.every((link) => link && link.source != null && link.target != null)
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
  return { ...graph, source: 'wikipedia' }
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
  const data = await request({ action: 'query', list: 'random', rnnamespace: '0', rnlimit: String(Math.min(count, 50)) }, signal)
  return (data.query?.random ?? []).map((item) => item.title ? titleKey(item.title) : '').filter(Boolean)
}

interface PageBatchResult {
  pages: ApiPage[]
  aliases: Map<string, string>
}

async function pageBatch(titles: string[], signal?: AbortSignal): Promise<PageBatchResult> {
  if (!titles.length) return { pages: [], aliases: new Map() }
  const pages: ApiPage[] = []
  const aliases = new Map<string, string>()
  let continuation: { plcontinue?: string; continue?: string } | undefined
  for (let attempt = 0; attempt <= MAX_LINK_CONTINUATIONS; attempt += 1) {
    const data = await request({
      action: 'query', titles: titles.join('|'), prop: 'extracts|links|info', inprop: 'url', exintro: '1', explaintext: '1', exchars: '280',
      plnamespace: '0', pllimit: String(MAX_LINKS_PER_PAGE), redirects: '1', ...(continuation ?? {}),
    }, signal)
    for (const mapping of [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])]) {
      if (mapping.from && mapping.to) aliases.set(titleId(mapping.from), titleKey(mapping.to))
    }
    const batch = Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages ?? {})
    pages.push(...batch.filter((page) => page.title && (page.ns == null || page.ns === 0)))
    continuation = data.continue?.plcontinue ? data.continue : undefined
    if (!continuation) break
  }
  return { pages, aliases }
}

/** Fetch a bounded graph grown from random article seeds; falls back gracefully offline. */
export async function fetchWikiGraph(count: number, signal?: AbortSignal): Promise<WikiGraph> {
  const wanted = Math.max(1, Math.min(Math.floor(count) || 1, LOCAL_INDEX_URL ? LOCAL_MAX_NODES : 500))
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
      if (signal?.aborted) throw localError
    }
    const seeds = await randomTitles(Math.min(Math.max(5, Math.ceil(wanted / 8)), 50), signal)
    const queue = [...new Map(seeds.map((title) => [titleId(title), title])).values()]
    const queued = new Set(queue.map(titleId))
    const aliases = new Map<string, string>()
    const seen = new Set<string>()
    const pages = new Map<string, ApiPage>()
    const rawLinks: Array<[string, string]> = []
    while (queue.length && seen.size < wanted) {
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
          if (!seen.has(targetId) && !queued.has(targetId) && queue.length + seen.size < wanted * 2) {
            queue.push(targetCanonical)
            queued.add(targetId)
          }
        }
      }
    }
    const nodes: WikiNode[] = [...pages.entries()].slice(0, wanted).map(([title, page]) => ({ id: title, title, url: articleUrl(title), extract: page.extract, byteLength: page.length }))
    const canonicalById = new Map(nodes.map((node) => [titleId(node.id), node.id]))
    const uniqueLinks = new Map<string, [string, string]>()
    for (const [source, target] of rawLinks) {
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
    return nodes.length ? { nodes, links, source: 'wikipedia' } : { ...buildFallbackGraph(wanted), source: 'fallback' }
  } catch (error) {
    if (signal?.aborted) throw error
    return { ...buildFallbackGraph(wanted), source: 'fallback' }
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
  const requested = Math.max(1, Math.min(Math.floor(count) || 1, LOCAL_INDEX_URL ? LOCAL_MAX_NODES : 5_000))
  const merged: WikiGraph = { nodes: [], links: [], source: 'wikipedia' }
  const nodeIds = new Set<string>()
  const linkIds = new Set<string>()
  let completed = 0

  while (completed < requested) {
    if (signal?.aborted) throw new DOMException('The graph request was cancelled.', 'AbortError')
    // Local tiers are deterministic and nested. Ask for cumulative sizes so
    // each response can add nodes without re-downloading the same small batch.
    // The public API remains bounded to independent random batches.
    const nextTarget = LOCAL_INDEX_URL
      ? Math.min(requested, Math.max(500, completed ? completed * 2 : 500))
      : Math.min(MAX_BATCH * 2, requested - completed)
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
    const previousCompleted = completed
    completed = LOCAL_INDEX_URL ? Math.max(completed, batch.nodes.length) : completed + nextTarget
    onProgress?.({ loaded: Math.min(completed, requested), requested, graph: { ...merged, nodes: [...merged.nodes], links: [...merged.links] } })
    // A fallback graph is finite; avoid repeatedly emitting the same demo map.
    if (batch.source === 'fallback' && batch.nodes.length < nextTarget) break
    if (LOCAL_INDEX_URL && completed <= previousCompleted) break
  }
  return merged
}

export { buildFallbackGraph }
