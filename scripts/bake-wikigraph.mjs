#!/usr/bin/env node

/**
 * Bake a dump-backed WikiGraph outside the browser.
 *
 * The force setup below calls the same shared helpers used by GraphCanvas:
 * article importance, hub interactions, unrelated repulsion, link springs,
 * collision, boundary confinement, velocity limiting, and f32 rounding. The
 * output is a static SVG, so opening it never creates a browser force
 * simulation or requires the browser to hold the source JSON graph.
 *
 * Node 22+ is required because the shared physics modules are TypeScript.
 * Node 26 is recommended for the largest local corpus.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, extname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { forceCenter, forceCollide, forceManyBody, forceSimulation } from 'd3-force'
import { articleDegree, selectHubIds } from '../src/graph/hubs.ts'
import { boundaryForce, boundaryRadius } from '../src/graph/boundary.ts'
import { articleRepulsionScale } from '../src/graph/density.ts'
import { roundSimulationNodesF32 } from '../src/graph/f32.ts'
import { layoutSpacing, seedLayout, symmetricAttraction, unrelatedRepulsion, hubInteractions } from '../src/graph/layout.ts'
import { velocityLimitForce } from '../src/graph/velocity.ts'
import {
  DEFAULT_SIMULATION_SETTINGS,
  LARGE_GRAPH_THRESHOLD,
  articleImportance,
  collisionStrength,
  hubRepulsionScore,
  nodeRadius,
  repairNodeOverlaps,
} from '../src/graph/physics.ts'

const DEFAULT_ROOT = process.platform === 'win32' ? 'D:\\WikiGraphData' : '/mnt/d/WikiGraphData'
const DEFAULT_OUTPUT = 'index/baked/wikigraph.svg'
const DEFAULT_POSITIONS = 'index/baked/positions.jsonl'
const DEFAULT_MANIFEST = 'index/baked/manifest.json'
const PROGRESS_REPORT_INTERVAL_MS = 30_000

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 100 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'calculating...'
  if (seconds < 1) return '<1s'
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3_600)
  const minutes = Math.floor((rounded % 3_600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`
  return `${remainingSeconds}s`
}

function formatProgressCount(value, unit) {
  return unit === 'bytes' ? formatBytes(value) : `${value.toLocaleString()} ${unit}`
}

function formatProgressRate(value, unit) {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (unit === 'bytes') return `${formatBytes(value)}/s`
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}/s`
}

function createProgressReporter(label, total, unit) {
  const startedAt = Date.now()
  const reportEvery = Math.max(1, Math.ceil(total / 20))
  let lastReportedValue = 0
  let lastReportedAt = 0

  const update = (value, extra = '', force = false) => {
    const current = Math.max(0, Math.min(total, value))
    const now = Date.now()
    const shouldReport = force
      || current >= total
      || current === 1
      || current - lastReportedValue >= reportEvery
      || now - lastReportedAt >= PROGRESS_REPORT_INTERVAL_MS
    if (!shouldReport) return

    const elapsedSeconds = Math.max(0, (now - startedAt) / 1_000)
    const fraction = total > 0 ? current / total : 1
    const percent = (fraction * 100).toFixed(fraction > 0 && fraction < 0.1 ? 1 : 0)
    const barWidth = 20
    const filled = Math.round(fraction * barWidth)
    const bar = `[${'#'.repeat(filled)}${'.'.repeat(barWidth - filled)}]`
    const rate = current > 0 && elapsedSeconds > 0 ? current / elapsedSeconds : 0
    const eta = current > 0 && current < total
      ? elapsedSeconds * (total - current) / current
      : current >= total ? 0 : Infinity
    const detail = extra ? ` | ${extra}` : ''
    console.log(`${label} ${bar} ${percent}% (${formatProgressCount(current, unit)}/${formatProgressCount(total, unit)}) | ${formatProgressRate(rate, unit)} | elapsed ${formatDuration(elapsedSeconds)} | ETA ${current >= total ? 'done' : formatDuration(eta)}${detail}`)
    lastReportedValue = current
    lastReportedAt = now
  }

  return {
    update,
    finish(value = total, extra = '') {
      const current = Math.max(0, Math.min(total, value))
      if (current === lastReportedValue) return
      update(value, extra, true)
    },
  }
}

function dataRoot() {
  return resolve(process.env.WIKIGRAPH_DATA_DIR || DEFAULT_ROOT)
}

function key(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function refValue(value) {
  return value && typeof value === 'object' ? value.id ?? value.title ?? '' : value
}

function normalizeArticle(article) {
  if (!article || typeof article !== 'object') return null
  if (article.isDisambiguation === true || article.disambiguation === true
    || /\s+\(disambiguation\)$/i.test(String(article.title ?? '').trim())) return null
  const id = typeof article.id === 'string' ? article.id.trim() : ''
  const title = typeof article.title === 'string' ? article.title.trim() : id
  if (!id || !title) return null
  return {
    id,
    title,
    articleSize: Number.isFinite(article.articleSize) ? article.articleSize : undefined,
    byteLength: Number.isFinite(article.byteLength) ? article.byteLength : undefined,
    links: Array.isArray(article.links) ? article.links : [],
  }
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? fallback : fallback
}

function numberOption(args, name, fallback, { integer = false, min = -Infinity } = {}) {
  const value = Number(option(args, name, fallback))
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a ${integer ? 'positive integer' : 'finite number'}`)
  }
  return value
}

function inputPath(root, explicit) {
  if (explicit) return resolve(explicit)
  const candidates = [
    join(root, 'index', 'articles.jsonl'),
    join(root, 'articles.jsonl'),
    join(root, 'index', 'index.json'),
    join(root, 'index.json'),
  ]
  const found = candidates.find((file) => existsSync(file))
  if (!found) throw new Error(`No indexed corpus found under ${root}. Run npm run wiki:parse and npm run wiki:index first.`)
  return found
}

function recordNode(article) {
  return {
    id: article.id,
    title: article.title,
    ...(Number.isFinite(article.articleSize) ? { articleSize: article.articleSize } : {}),
    ...(Number.isFinite(article.byteLength) ? { byteLength: article.byteLength } : {}),
    inDegree: 0,
    outDegree: 0,
  }
}

async function readJsonlNodes(file, limit) {
  const nodes = []
  const byRef = new Map()
  const totalBytes = statSync(file).size
  const progress = createProgressReporter('Load nodes', totalBytes, 'bytes')
  let bytesRead = 0
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of input) {
    bytesRead = Math.min(totalBytes, bytesRead + Buffer.byteLength(line) + 1)
    if (!line.trim()) continue
    try {
      const article = normalizeArticle(JSON.parse(line))
      if (!article) continue
      const node = recordNode(article)
      const index = nodes.length
      nodes.push(node)
      byRef.set(key(node.id), index)
      byRef.set(key(node.title), index)
      if (nodes.length >= limit) break
    } catch {
      // Keep the same tolerant behavior as the index builder.
    }
    progress.update(bytesRead, `articles=${nodes.length.toLocaleString()}`)
  }
  progress.finish(bytesRead, `articles=${nodes.length.toLocaleString()}`)
  return { nodes, byRef }
}

function createLinkCollector(nodes, byRef, edgeLimit) {
  const links = []
  const edgeKeys = new Set()
  const addArticle = (article) => {
    for (const target of article.links) {
      const source = byRef.get(key(article.id))
      const targetIndex = byRef.get(key(refValue(target)))
      if (source == null || targetIndex == null || source === targetIndex) continue
      const edgeKey = source * nodes.length + targetIndex
      if (edgeKeys.has(edgeKey)) continue
      edgeKeys.add(edgeKey)
      nodes[source].outDegree = (nodes[source].outDegree ?? 0) + 1
      nodes[targetIndex].inDegree = (nodes[targetIndex].inDegree ?? 0) + 1
      links.push({ source: nodes[source], target: nodes[targetIndex] })
      if (links.length >= edgeLimit) return true
    }
    return false
  }
  return { links, addArticle }
}

function graphFromRecords(records, rawLinks, edgeLimit) {
  const nodes = records.map(recordNode)
  const byRef = new Map()
  nodes.forEach((node, index) => {
    byRef.set(key(node.id), index)
    byRef.set(key(node.title), index)
  })
  const collector = createLinkCollector(nodes, byRef, edgeLimit)
  for (const item of rawLinks) {
    if (collector.addArticle(item)) break
  }
  return { nodes, links: collector.links }
}

async function loadJsonlGraph(file, limit, edgeLimit) {
  const { nodes, byRef } = await readJsonlNodes(file, limit)
  const collector = createLinkCollector(nodes, byRef, edgeLimit)
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  const totalBytes = statSync(file).size
  const progress = createProgressReporter('Load links', totalBytes, 'bytes')
  let bytesRead = 0
  let scanned = 0
  for await (const line of input) {
    bytesRead = Math.min(totalBytes, bytesRead + Buffer.byteLength(line) + 1)
    if (!line.trim()) continue
    try {
      const article = normalizeArticle(JSON.parse(line))
      if (!article) continue
      scanned += 1
      if (collector.addArticle(article)) break
      if (scanned >= limit) break
    } catch {
      // Keep the same tolerant behavior as the index builder.
    }
    progress.update(bytesRead, `articles=${scanned.toLocaleString()} links=${collector.links.length.toLocaleString()}`)
  }
  progress.finish(bytesRead, `articles=${scanned.toLocaleString()} links=${collector.links.length.toLocaleString()}`)
  const graph = { nodes, links: collector.links }
  console.log(`Loaded ${graph.nodes.length.toLocaleString()} articles and ${graph.links.length.toLocaleString()} links from ${file}`)
  return graph
}

function loadJsonGraph(file, limit, edgeLimit) {
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(value?.nodes) || !Array.isArray(value?.links)) throw new Error(`Expected {nodes, links} JSON at ${file}`)
  const records = value.nodes.slice(0, limit === Infinity ? undefined : limit).map(normalizeArticle).filter(Boolean)
  const graph = graphFromRecords(records, value.links.map((link) => ({ id: refValue(link.source), links: [refValue(link.target)] })), edgeLimit)
  console.log(`Loaded ${graph.nodes.length.toLocaleString()} articles and ${graph.links.length.toLocaleString()} links from ${file}`)
  return graph
}

async function loadGraph(file, limit, edgeLimit) {
  if (extname(file).toLocaleLowerCase() === '.jsonl') return loadJsonlGraph(file, limit, edgeLimit)
  return loadJsonGraph(file, limit, edgeLimit)
}

function seededRandom(seed) {
  let state = (seed >>> 0) || 1
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state)
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state)
    return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296
  }
}

function bake(graph, iterations, seed, settingsOverride = {}) {
  const { nodes, links } = graph
  const settings = { ...DEFAULT_SIMULATION_SETTINGS, ...settingsOverride }
  const dimensions = 2
  const hubIds = selectHubIds(nodes, links)
  const spacing = layoutSpacing(nodes.length)
  const repulsionScale = articleRepulsionScale(nodes, links)
  const largeGraph = nodes.length > LARGE_GRAPH_THRESHOLD
  seedLayout(nodes, dimensions)
  roundSimulationNodesF32(nodes, dimensions)
  repairNodeOverlaps(nodes, dimensions, settings)
  roundSimulationNodesF32(nodes, dimensions)
  const attractionLinks = largeGraph && links.length > 50_000
    ? links.filter((_, index) => index % Math.ceil(links.length / 50_000) === 0)
    : links
  const simulation = forceSimulation(nodes).stop()
    .force('charge', forceManyBody()
      .strength((node) => -repulsionScale * (settings.baseCharge + articleImportance(node, settings) * settings.articleImportanceCharge))
      .distanceMax(settings.chargeDistance * spacing))
    .force('unrelated-repulsion', unrelatedRepulsion(links, nodes, largeGraph, settings, hubIds, (node) => hubRepulsionScore(node, hubIds, settings), repulsionScale))
    .force('center', forceCenter(0, 0).strength(settings.centerStrength))
    .force('link-attraction', symmetricAttraction(attractionLinks, nodes, settings, dimensions, hubIds, () => settings))
    .force('hub-interactions', hubInteractions(links, settings, hubIds, (node) => hubRepulsionScore(node, hubIds, settings), dimensions, () => settings))
    .force('collision', forceCollide()
      .radius((node) => nodeRadius(node, settings) + settings.collisionPadding)
      .strength(collisionStrength(settings))
      .iterations(Math.max(1, Math.round(settings.collisionIterations))))
    .force('boundary', boundaryForce(boundaryRadius(nodes.length, dimensions), dimensions))
    .force('velocity-limit', velocityLimitForce(dimensions, (node) => Math.max(1, nodeRadius(node, settings) + settings.collisionPadding)))
    .velocityDecay(settings.velocityDecay)
    .alphaDecay(settings.alphaDecay)
    .alphaMin(settings.alphaMin)
    .alphaTarget(settings.alphaTarget)
    .alpha(settings.initialTemperature)
  if (typeof simulation.randomSource === 'function') simulation.randomSource(seededRandom(seed))

  const progress = createProgressReporter('Physics', iterations, 'ticks')
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    simulation.tick()
    roundSimulationNodesF32(nodes, dimensions)
    repairNodeOverlaps(nodes, dimensions, settings)
    roundSimulationNodesF32(nodes, dimensions)
    progress.update(iteration, `alpha=${simulation.alpha().toFixed(5)}`)
  }
  return { graph, hubIds, settings }
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character] ?? character))
}

function number(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : '0'
}

function projectedBounds(nodes, padding) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x ?? 0); maxX = Math.max(maxX, node.x ?? 0)
    minY = Math.min(minY, node.y ?? 0); maxY = Math.max(maxY, node.y ?? 0)
  }
  if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minY: -1, maxY: 1 }
  return { minX: minX - padding, maxX: maxX + padding, minY: minY - padding, maxY: maxY + padding }
}

function project(node, bounds, width, height, scale = Math.min(width / Math.max(1, bounds.maxX - bounds.minX), height / Math.max(1, bounds.maxY - bounds.minY))) {
  return {
    x: (node.x - bounds.minX) * scale + (width - (bounds.maxX - bounds.minX) * scale) / 2,
    y: (bounds.maxY - node.y) * scale + (height - (bounds.maxY - bounds.minY) * scale) / 2,
    scale,
  }
}

async function writeChunk(stream, value) {
  if (stream.write(value)) return
  await once(stream, 'drain')
}

async function writePositions(file, nodes) {
  mkdirSync(dirname(file), { recursive: true })
  const partial = `${file}.part-${process.pid}`
  const stream = createWriteStream(partial, { flags: 'wx' })
  const progress = createProgressReporter('Positions', nodes.length, 'nodes')
  try {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      await writeChunk(stream, `${JSON.stringify({ id: node.id, title: node.title, x: node.x, y: node.y, inDegree: node.inDegree, outDegree: node.outDegree })}\n`)
      progress.update(index + 1)
    }
    await new Promise((resolveWrite, rejectWrite) => stream.end((error) => error ? rejectWrite(error) : resolveWrite()))
    renameSync(partial, file)
    progress.finish(nodes.length)
  } catch (error) {
    stream.destroy()
    throw error
  }
}

function writeManifest(file, manifest) {
  mkdirSync(dirname(file), { recursive: true })
  const partial = `${file}.part-${process.pid}`
  writeFileSync(partial, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(partial, file)
}

async function writeSvg(file, graph, hubIds, settings, options) {
  const { nodes, links } = graph
  mkdirSync(dirname(file), { recursive: true })
  const partial = `${file}.part-${process.pid}`
  const stream = createWriteStream(partial, { flags: 'wx' })
  const padding = Math.max(40, Math.max(...nodes.slice(0, Math.min(nodes.length, 1000)).map((node) => nodeRadius(node, settings) + settings.collisionPadding), 40))
  const bounds = projectedBounds(nodes, padding)
  const width = options.width
  const height = options.height
  const svgScale = Math.min(width / Math.max(1, bounds.maxX - bounds.minX), height / Math.max(1, bounds.maxY - bounds.minY))
  const pointFor = (node) => project(node, bounds, width, height, svgScale)
  const startedAt = Date.now()
  const progress = createProgressReporter('SVG', (options.noLinks ? 0 : links.length) + nodes.length, 'elements')
  let elementsWritten = 0
  try {
    await writeChunk(stream, `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Baked WikiGraph with ${nodes.length.toLocaleString()} articles">\n`)
    await writeChunk(stream, `<title>WikiGraph baked layout (${nodes.length.toLocaleString()} articles)</title>\n<defs><marker id="wikigraph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 z" fill="#73777f" fill-opacity=".34"/></marker></defs>\n<rect width="100%" height="100%" fill="#ffffff"/>\n`)
    if (!options.noLinks) {
      await writeChunk(stream, '<g fill="none" stroke="#73777f" stroke-opacity=".16" stroke-width=".45" marker-end="url(#wikigraph-arrow)">\n')
      for (const link of links) {
        const source = pointFor(link.source); const target = pointFor(link.target)
        await writeChunk(stream, `<line x1="${number(source.x)}" y1="${number(source.y)}" x2="${number(target.x)}" y2="${number(target.y)}"/>\n`)
        elementsWritten += 1
        progress.update(elementsWritten)
      }
      await writeChunk(stream, '</g>\n')
    }
    await writeChunk(stream, '<g stroke="#ffffff" stroke-width=".35">\n')
    for (const node of nodes) {
      const point = pointFor(node)
      const degree = articleDegree(node)
      const fill = hubIds.has(node.id) ? '#254fef' : degree >= 4 ? '#6e86f2' : '#b6c4ff'
      const radius = Math.max(0.6, Math.min(7, nodeRadius(node, settings) * options.nodeScale * point.scale))
      await writeChunk(stream, `<circle cx="${number(point.x)}" cy="${number(point.y)}" r="${number(radius)}" fill="${fill}">${options.labels ? `<title>${xml(node.title)}</title>` : ''}</circle>\n`)
      elementsWritten += 1
      progress.update(elementsWritten)
    }
    await writeChunk(stream, '</g>\n</svg>\n')
    await new Promise((resolveWrite, rejectWrite) => stream.end((error) => error ? rejectWrite(error) : resolveWrite()))
    renameSync(partial, file)
    progress.finish(elementsWritten)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`Wrote SVG ${file} (${statSync(file).size.toLocaleString()} bytes) in ${seconds}s`)
  } catch (error) {
    stream.destroy()
    throw error
  }
}

function help() {
  console.log(`Usage: npm run wiki:bake -- [options]

Bake the indexed corpus with the browser's 2D physics and write a static SVG.

Options:
  --input <file>          articles.jsonl or a graph JSON file
  --output <file>         SVG output (default: <data>/index/baked/wikigraph.svg)
  --positions <file>      baked positions JSONL (default: <data>/index/baked/positions.jsonl)
  --manifest <file>       bake metadata (default: <data>/index/baked/manifest.json)
  --count <n>             bake only the first n records (default: all)
  --iterations <n>        physics ticks (default: 1800)
  --seed <n>              deterministic physics seed (default: 1)
  --settings <file>       JSON settings override (default: browser defaults)
  --edge-limit <n>        optional link cap for a smaller SVG (default: all)
  --width <n>             SVG width (default: 16000)
  --height <n>            SVG height (default: 10000)
  --node-scale <n>        SVG node-size multiplier (default: 1)
  --no-links              omit SVG lines while retaining all baked nodes
  --labels                add a title tooltip to every SVG node
  --help                  show this help

The full corpus can take hours and requires substantial RAM. Use --no-links
for the most practical 7-million-node overview.`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { help(); return }
  const root = dataRoot()
  const input = inputPath(root, option(args, '--input'))
  const output = resolve(option(args, '--output', join(root, DEFAULT_OUTPUT)))
  const positions = resolve(option(args, '--positions', join(root, DEFAULT_POSITIONS)))
  const manifest = resolve(option(args, '--manifest', join(root, DEFAULT_MANIFEST)))
  const countValue = option(args, '--count')
  const count = countValue == null ? Infinity : numberOption(args, '--count', countValue, { integer: true, min: 1 })
  const iterations = numberOption(args, '--iterations', 1_800, { integer: true, min: 1 })
  const seed = numberOption(args, '--seed', 1, { integer: true, min: 0 })
  const edgeLimit = option(args, '--edge-limit') == null ? Infinity : numberOption(args, '--edge-limit', 1, { integer: true, min: 1 })
  const settingsFile = option(args, '--settings')
  const options = {
    width: numberOption(args, '--width', 16_000, { integer: true, min: 1 }),
    height: numberOption(args, '--height', 10_000, { integer: true, min: 1 }),
    nodeScale: numberOption(args, '--node-scale', 1, { min: 0.01 }),
    noLinks: args.includes('--no-links'),
    labels: args.includes('--labels'),
  }
  const graph = await loadGraph(input, count, edgeLimit)
  if (!graph.nodes.length) throw new Error('The input contained no usable articles')
  let settingsOverride = {}
  if (settingsFile) {
    const parsed = JSON.parse(readFileSync(resolve(settingsFile), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--settings must contain a JSON object')
    settingsOverride = parsed
  }
  const baked = bake(graph, iterations, seed, settingsOverride)
  await writePositions(positions, baked.graph.nodes)
  console.log(`Wrote positions ${positions}`)
  await writeSvg(output, baked.graph, baked.hubIds, baked.settings, options)
  writeManifest(manifest, {
    type: 'wikigraph-baked-layout',
    input,
    svg: output,
    positions,
    articles: baked.graph.nodes.length,
    links: baked.graph.links.length,
    iterations,
    seed,
    settings: baked.settings,
    completedAt: new Date().toISOString(),
  })
  console.log(`Wrote manifest ${manifest}`)
  console.log(`Open http://127.0.0.1:8787/baked.svg after starting npm run wiki:serve.`)
}

main().catch((error) => {
  console.error(`wiki-bake: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
