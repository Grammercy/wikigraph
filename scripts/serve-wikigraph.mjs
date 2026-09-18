#!/usr/bin/env node
// Dependency-free API for the compact index produced by wiki-data.mjs.
// It never downloads or parses raw Wikimedia XML.
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

const dataRoot = resolve(process.env.WIKIGRAPH_DATA_DIR || (process.platform === 'win32' ? 'D:\\WikiGraphData' : '/mnt/d/WikiGraphData'))
const indexFile = resolve(dataRoot, 'index.json')
const jsonlFile = resolve(dataRoot, 'index', 'articles.jsonl')
const sampleFile = resolve(dataRoot, 'index', 'sample.json')
const tiersDir = resolve(dataRoot, 'index', 'tiers')
const parserCheckpoint = resolve(dataRoot, 'articles.checkpoint.json')
const port = Number(process.env.WIKIGRAPH_PORT || 8787)
const webRoot = resolve(process.env.WIKIGRAPH_WEB_ROOT || 'dist')
const fallback = { nodes: [{ id: 'Physics', title: 'Physics', url: 'https://en.wikipedia.org/wiki/Physics' }, { id: 'Mathematics', title: 'Mathematics', url: 'https://en.wikipedia.org/wiki/Mathematics' }], links: [{ source: 'Physics', target: 'Mathematics' }] }
let jsonlCache = null
let corpusStatsCache = null
let tierManifestCache = null
const tierGraphCache = new Map()
// Keep the existing 500-node default, while allowing bounded larger tiers
// for GPU-backed clients without ever attempting a full-corpus response.
const CACHE_LIMIT = Math.max(500, Math.min(25000, Number(process.env.WIKIGRAPH_MAX_GRAPH_NODES || 10000) || 10000))
const key = (value) => String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
const refValue = (value) => value && typeof value === 'object' ? value.id ?? value.title ?? '' : value
const hash = (value) => { let h = 2166136261; for (const c of String(value)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)) }
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }
function serveFile(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false
  const stat = statSync(filePath)
  res.writeHead(200, { 'content-type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream', 'content-length': stat.size, 'access-control-allow-origin': '*' })
  if (res.req?.method === 'HEAD') return res.end(), true
  createReadStream(filePath).pipe(res)
  return true
}
function serveWeb(res, pathname) {
  if (!existsSync(webRoot)) return false
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return false }
  const requested = resolve(webRoot, `.${decoded === '/' ? '/index.html' : decoded}`)
  const rootPrefix = webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`
  if (requested !== webRoot && !requested.startsWith(rootPrefix)) return false
  return serveFile(res, requested) || serveFile(res, resolve(webRoot, 'index.html'))
}
function sample(value, count) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return null
  const nodes = value.nodes.filter((n) => n && typeof n.title === 'string').sort((a, b) => hash(a.id || a.title) - hash(b.id || b.title)).slice(0, count)
  const byRef = new Map(nodes.flatMap((n) => {
    const id = String(n.id || n.title)
    return [[key(id), id], [key(n.title), id]]
  }))
  const edgeKeys = new Set()
  const links = value.links.flatMap((edge) => {
    const source = byRef.get(key(refValue(edge?.source)))
    const target = byRef.get(key(refValue(edge?.target)))
    if (!source || !target || source === target) return []
    const edgeKey = `${source}\u0000${target}`
    if (edgeKeys.has(edgeKey)) return []
    edgeKeys.add(edgeKey)
    return [{ source, target }]
  })
  return withDegrees({ nodes: nodes.map((n) => ({ ...n, id: String(n.id || n.title), url: n.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(n.title).replaceAll('%20', '_')}` })), links })
}
function readTierManifest() {
  const file = resolve(tiersDir, 'manifest.json')
  if (!existsSync(file)) return null
  const stat = statSync(file)
  if (tierManifestCache && tierManifestCache.mtimeMs === stat.mtimeMs && tierManifestCache.size === stat.size) return tierManifestCache.value
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const tiers = Array.isArray(parsed.tiers)
      ? parsed.tiers.filter((tier) => Number.isInteger(tier?.count) && tier.count > 0).sort((a, b) => a.count - b.count)
      : []
    const value = { ...parsed, tiers }
    tierManifestCache = { mtimeMs: stat.mtimeMs, size: stat.size, value }
    return value
  } catch { return null }
}
function readTier(count) {
  const manifest = readTierManifest()
  if (!manifest?.tiers?.length) return null
  const tier = manifest.tiers.find((candidate) => candidate.count >= count) || manifest.tiers.at(-1)
  const fileName = typeof tier.file === 'string' ? tier.file : `${tier.count}.json`
  const file = resolve(tiersDir, fileName)
  const prefix = tiersDir.endsWith(sep) ? tiersDir : `${tiersDir}${sep}`
  if (file !== tiersDir && !file.startsWith(prefix)) return null
  if (!existsSync(file)) return null
  const stat = statSync(file)
  const cached = tierGraphCache.get(file)
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { graph: cached.graph, count: tier.count }
  try {
    const graph = JSON.parse(readFileSync(file, 'utf8'))
    tierGraphCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, graph })
    return { graph, count: tier.count }
  } catch { return null }
}
async function sampleJsonl(count) {
  if (!existsSync(jsonlFile)) return null
  const stat = statSync(jsonlFile)
  if (jsonlCache && jsonlCache.mtimeMs === stat.mtimeMs && jsonlCache.size === stat.size) return sample(jsonlCache.graph, count)
  const selected = []
  const input = createInterface({ input: createReadStream(jsonlFile), crlfDelay: Infinity })
  for await (const line of input) {
    try {
      const article = JSON.parse(line)
      if (typeof article.title !== 'string') continue
      selected.push({ ...article, id: article.id || article.title, url: article.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title).replaceAll('%20', '_')}` })
      selected.sort((a, b) => hash(a.id) - hash(b.id))
      // Keep a stable cache large enough for every slider value. The previous
      // request must not determine how many articles are available later.
      if (selected.length > CACHE_LIMIT) selected.pop()
    } catch { /* skip malformed rows */ }
  }
  const byRef = new Map(selected.flatMap((article) => [[key(article.id), String(article.id)], [key(article.title), String(article.id)]]))
  const edgeKeys = new Set()
  const links = selected.flatMap((article) => (Array.isArray(article.links) ? article.links : []).flatMap((target) => {
    const source = byRef.get(key(article.id))
    const targetId = byRef.get(key(refValue(target)))
    if (!source || !targetId || source === targetId) return []
    const edgeKey = `${source}\u0000${targetId}`
    if (edgeKeys.has(edgeKey)) return []
    edgeKeys.add(edgeKey)
    return [{ source, target: targetId }]
  }))
  const graph = { nodes: selected.map(({ links: _links, ...article }) => article), links }
  jsonlCache = { mtimeMs: stat.mtimeMs, size: stat.size, graph }
  return sample(graph, count)
}

async function scanCorpus() {
  const tierManifest = readTierManifest()
  if (tierManifest?.scanned) {
    return { articles: tierManifest.scanned, links: null, totalArticleBytes: null, indexed: true, source: 'tiers', tiers: tierManifest.tiers, updatedAt: tierManifest.completedAt ?? null }
  }
  if (!existsSync(jsonlFile) && existsSync(parserCheckpoint)) {
    try {
      const progress = JSON.parse(readFileSync(parserCheckpoint, 'utf8'))
      return { articles: progress.recordsWritten ?? 0, pagesRead: progress.pagesRead ?? 0, indexed: false, building: true, source: 'parser', updatedAt: progress.updatedAt ?? null }
    } catch { /* continue to the fallback response */ }
  }
  if (!existsSync(jsonlFile)) {
    return null
  }
  const stat = statSync(jsonlFile)
  if (corpusStatsCache && corpusStatsCache.mtimeMs === stat.mtimeMs && corpusStatsCache.size === stat.size) return corpusStatsCache.value
  let articles = 0; let links = 0; let totalArticleBytes = 0
  const input = createInterface({ input: createReadStream(jsonlFile), crlfDelay: Infinity })
  for await (const line of input) {
    if (!line.trim()) continue
    try {
      const article = JSON.parse(line)
      if (typeof article.title !== 'string') continue
      articles += 1
      totalArticleBytes += Number.isFinite(article.byteLength) ? article.byteLength : 0
      links += Array.isArray(article.links) ? article.links.length : 0
    } catch { /* skip malformed rows */ }
  }
  const value = { articles, links, totalArticleBytes, indexed: true, source: 'jsonl', tiers: readTierManifest()?.tiers ?? [], updatedAt: new Date(stat.mtimeMs).toISOString() }
  corpusStatsCache = { mtimeMs: stat.mtimeMs, size: stat.size, value }
  return value
}

async function searchCorpus(query, limit) {
  if (!existsSync(jsonlFile)) return []
  const needle = key(query)
  if (!needle) return []
  const matches = []
  const input = createInterface({ input: createReadStream(jsonlFile), crlfDelay: Infinity })
  for await (const line of input) {
    try {
      const article = JSON.parse(line)
      if (typeof article.title !== 'string' || !key(article.title).includes(needle)) continue
      matches.push({ id: String(article.id || article.title), title: article.title, url: article.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title).replaceAll('%20', '_')}`, articleSize: article.byteLength ?? null })
      matches.sort((a, b) => (a.title.length - b.title.length) || a.title.localeCompare(b.title))
      if (matches.length > limit) matches.pop()
    } catch { /* skip malformed rows */ }
  }
  return matches
}

async function findArticle(value) {
  if (!existsSync(jsonlFile)) return null
  const needle = key(value)
  const input = createInterface({ input: createReadStream(jsonlFile), crlfDelay: Infinity })
  for await (const line of input) {
    try {
      const article = JSON.parse(line)
      if (key(article.id) !== needle && key(article.title) !== needle) continue
      const { links, ...node } = article
      return { ...node, id: String(node.id || node.title), url: node.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(node.title).replaceAll('%20', '_')}`, links: Array.isArray(links) ? links : [] }
    } catch { /* skip malformed rows */ }
  }
  return null
}
function withDegrees(graph) {
  const nodes = graph.nodes.map((node) => ({ ...node, inDegree: 0, outDegree: 0 }))
  const byId = new Map(nodes.map((node) => [key(node.id), node]))
  const links = graph.links.flatMap((edge) => {
    const source = byId.get(key(edge.source)); const target = byId.get(key(edge.target))
    if (!source || !target || source.id === target.id) return []
    source.outDegree += 1; target.inDegree += 1
    return [{ source: source.id, target: target.id }]
  })
  return { nodes, links }
}
createServer(async (req, res) => {
  const request = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' }); return res.end() }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD, OPTIONS' }); return res.end() }
  if (request.pathname === '/health') return send(res, 200, { ok: true, indexed: existsSync(indexFile) || existsSync(jsonlFile) || existsSync(sampleFile) || existsSync(tiersDir), dataRoot, tiers: readTierManifest()?.tiers ?? [] })
  try {
    if (request.pathname === '/api/stats') {
      const stats = await scanCorpus()
      return send(res, 200, stats || { articles: 0, links: 0, totalArticleBytes: 0, indexed: false, source: 'fallback' })
    }
    if (request.pathname === '/api/search') {
      const limit = Math.max(1, Math.min(100, Number(request.searchParams.get('limit') || 20) || 20))
      return send(res, 200, { query: request.searchParams.get('q') || '', results: await searchCorpus(request.searchParams.get('q') || '', limit) })
    }
    if (request.pathname === '/api/article') {
      const article = await findArticle(request.searchParams.get('id') || request.searchParams.get('title') || '')
      return send(res, article ? 200 : 404, article || { error: 'Article not found' })
    }
    if (request.pathname !== '/api/graph') {
      if (serveWeb(res, request.pathname)) return
      return send(res, 404, { error: existsSync(webRoot) ? 'Not found' : 'Build the app first with `npm run build` (or use an /api endpoint)' })
    }
    const count = Math.max(1, Math.min(CACHE_LIMIT, Number(request.searchParams.get('count') || 50) || 50))
    let graph = null
    // The compact sample is intentionally only used for the backwards-
    // compatible 500-node path; larger tiers come from the complete JSONL.
    let tier = null
    if (count > 500) {
      tier = readTier(count)
      if (tier) graph = sample(tier.graph, count)
    }
    if (count <= 500 && existsSync(sampleFile)) { try { graph = sample(JSON.parse(readFileSync(sampleFile, 'utf8')), count) } catch { graph = null } }
    if (!graph && existsSync(indexFile)) { try { graph = sample(JSON.parse(readFileSync(indexFile, 'utf8')), count) } catch { graph = null } }
    if (!graph) graph = await sampleJsonl(count)
    send(res, 200, graph ? { ...graph, source: 'wikipedia', indexed: true, tier: tier?.count ?? null } : { ...withDegrees(fallback), source: 'fallback', indexed: false })
  } catch (error) {
    send(res, 503, { error: 'Local Wikipedia index is unavailable', detail: error instanceof Error ? error.message : String(error) })
  }
}).listen(port, '127.0.0.1', () => console.log(`WikiGraph host listening at http://127.0.0.1:${port}; web root: ${webRoot}; data root: ${dataRoot}`))
