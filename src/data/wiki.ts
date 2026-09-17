import type { WikiGraph, WikiLink, WikiNode } from '../types'
import { buildFallbackGraph } from './fallback'

const API = 'https://en.wikipedia.org/w/api.php'
const REQUEST_TIMEOUT = 12_000
const MAX_BATCH = 25
const MAX_LINKS_PER_PAGE = 45

interface ApiPage {
  pageid?: number
  ns?: number
  title?: string
  extract?: string
  links?: Array<{ ns?: number; title?: string }>
}

interface ApiResponse {
  query?: { random?: Array<{ title?: string }>; pages?: ApiPage[] | Record<string, ApiPage> }
}

function titleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ')
}

function titleId(title: string): string {
  return titleKey(title).toLocaleLowerCase()
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

async function pageBatch(titles: string[], signal?: AbortSignal): Promise<ApiPage[]> {
  if (!titles.length) return []
  const data = await request({
    action: 'query', titles: titles.join('|'), prop: 'extracts|links', exintro: '1', explaintext: '1', exchars: '280',
    plnamespace: '0', pllimit: String(MAX_LINKS_PER_PAGE), redirects: '1',
  }, signal)
  const pages = Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages ?? {})
  return pages.filter((page) => page.title && (page.ns == null || page.ns === 0))
}

/** Fetch a bounded graph grown from random article seeds; falls back gracefully offline. */
export async function fetchWikiGraph(count: number, signal?: AbortSignal): Promise<WikiGraph> {
  const wanted = Math.max(1, Math.min(Math.floor(count) || 1, 500))
  try {
    const seeds = await randomTitles(Math.min(Math.max(5, Math.ceil(wanted / 8)), 50), signal)
    const queue = [...new Map(seeds.map((title) => [titleId(title), title])).values()]
    const seen = new Set<string>()
    const pages = new Map<string, ApiPage>()
    const rawLinks: Array<[string, string]> = []
    while (queue.length && seen.size < wanted) {
      const batch = queue.splice(0, MAX_BATCH).filter((title) => !seen.has(titleId(title)))
      if (!batch.length) continue
      const fetched = await pageBatch(batch, signal)
      for (const page of fetched) {
        const source = titleKey(page.title!)
        const sourceId = titleId(source)
        if (seen.has(sourceId)) continue
        seen.add(sourceId)
        pages.set(source, page)
        for (const link of (page.links ?? [])) {
          if (!link.title) continue
          const target = titleKey(link.title)
          const targetId = titleId(target)
          rawLinks.push([source, target])
          if (!seen.has(targetId) && !queue.some((queued) => titleId(queued) === targetId) && queue.length + seen.size < wanted * 2) queue.push(target)
        }
      }
    }
    const nodes: WikiNode[] = [...pages.entries()].slice(0, wanted).map(([title, page]) => ({ id: title, title, url: articleUrl(title), extract: page.extract }))
    const ids = new Set(nodes.map((node) => titleId(node.id)))
    const uniqueLinks = new Map<string, [string, string]>()
    for (const [source, target] of rawLinks) {
      const key = `${titleId(source)}\u0000${titleId(target)}`
      if (titleId(source) !== titleId(target) && ids.has(titleId(source)) && ids.has(titleId(target))) uniqueLinks.set(key, [source, target])
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
    return nodes.length ? { nodes, links } : buildFallbackGraph(wanted)
  } catch (error) {
    if (signal?.aborted) throw error
    return buildFallbackGraph(wanted)
  }
}

export { buildFallbackGraph }
