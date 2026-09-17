import type { WikiGraph, WikiLink, WikiNode } from '../types'
import { buildFallbackGraph } from './fallback'

const API = 'https://en.wikipedia.org/w/api.php'
const REQUEST_TIMEOUT = 12_000
const MAX_BATCH = 25
const MAX_LINKS_PER_PAGE = 45
const MAX_LINK_CONTINUATIONS = 4

interface ApiPage {
  pageid?: number
  ns?: number
  title?: string
  extract?: string
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
      action: 'query', titles: titles.join('|'), prop: 'extracts|links', exintro: '1', explaintext: '1', exchars: '280',
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
  const wanted = Math.max(1, Math.min(Math.floor(count) || 1, 500))
  try {
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
    const nodes: WikiNode[] = [...pages.entries()].slice(0, wanted).map(([title, page]) => ({ id: title, title, url: articleUrl(title), extract: page.extract }))
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

export { buildFallbackGraph }
