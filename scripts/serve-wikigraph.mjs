#!/usr/bin/env node
// Dependency-free API for the compact index produced by wiki-data.mjs.
// It never downloads or parses raw Wikimedia XML.
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const dataRoot = resolve(process.env.WIKIGRAPH_DATA_DIR || (process.platform === 'win32' ? 'D:\\WikiGraphData' : '/mnt/d/WikiGraphData'))
const indexFile = resolve(dataRoot, 'index.json')
const jsonlFile = resolve(dataRoot, 'index', 'articles.jsonl')
const port = Number(process.env.WIKIGRAPH_PORT || 8787)
const fallback = { nodes: [{ id: 'Physics', title: 'Physics', url: 'https://en.wikipedia.org/wiki/Physics' }, { id: 'Mathematics', title: 'Mathematics', url: 'https://en.wikipedia.org/wiki/Mathematics' }], links: [{ source: 'Physics', target: 'Mathematics' }] }
let jsonlCache = null
const key = (value) => String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
const hash = (value) => { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)) }
function sample(value, count) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return null
  const nodes = value.nodes.filter((n) => n && typeof n.title === 'string').sort((a, b) => hash(a.id || a.title) - hash(b.id || b.title)).slice(0, count)
  const ids = new Set(nodes.map((n) => key(n.id || n.title)))
  return withDegrees({ nodes: nodes.map((n) => ({ ...n, id: n.id || n.title, url: n.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(n.title).replaceAll('%20', '_')}` })), links: value.links.filter((e) => ids.has(key(e.source)) && ids.has(key(e.target))) })
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
      if (selected.length > count) selected.pop()
    } catch { /* skip malformed rows */ }
  }
  const ids = new Set(selected.map((article) => key(article.id)))
  const links = selected.flatMap((article) => (Array.isArray(article.links) ? article.links : [])
    .filter((target) => ids.has(key(target)))
    .map((target) => ({ source: article.id, target: selected.find((item) => key(item.id) === key(target)).id })))
  const graph = { nodes: selected.map(({ links: _links, ...article }) => article), links }
  jsonlCache = { mtimeMs: stat.mtimeMs, size: stat.size, graph }
  return sample(graph, count)
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
  if (request.pathname === '/health') return send(res, 200, { ok: true, indexed: existsSync(indexFile) || existsSync(jsonlFile), dataRoot })
  if (request.pathname !== '/api/graph') return send(res, 404, { error: 'Use GET /api/graph?count=50' })
  const count = Math.max(1, Math.min(500, Number(request.searchParams.get('count') || 50) || 50))
  try {
    let graph = null
    if (existsSync(indexFile)) { try { graph = sample(JSON.parse(readFileSync(indexFile, 'utf8')), count) } catch { graph = null } }
    if (!graph) graph = await sampleJsonl(count)
    send(res, 200, graph || { ...withDegrees(fallback), source: 'fallback', indexed: false })
  } catch (error) {
    send(res, 503, { error: 'Local Wikipedia index is unavailable', detail: error instanceof Error ? error.message : String(error) })
  }
}).listen(port, '127.0.0.1', () => console.log(`WikiGraph local API listening at http://127.0.0.1:${port}; data root: ${dataRoot}`))
