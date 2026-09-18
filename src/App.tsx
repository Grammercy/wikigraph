import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GraphCanvas, { type GraphCanvasHandle } from './components/GraphCanvas'
import { fetchWikiGraphProgressive, fetchWikiStats, usesLocalCorpus } from './data/wiki'
import type { WikiGraph, WikiStats } from './types'

function formatArticleSize(bytes?: number) {
  if (!Number.isFinite(bytes) || (bytes ?? 0) <= 0) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes as number
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function formatCount(value?: number | null) {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value as number)
}

export default function App() {
  const SAFE_NODE_THRESHOLD = 1000
  const MAX_LOCAL_ARTICLES = 25_000
  const [count, setCount] = useState(50)
  const [graph, setGraph] = useState<WikiGraph>({ nodes: [], links: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [corpusStats, setCorpusStats] = useState<WikiStats | null>(null)
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, requested: 0 })
  const [largeMapAcknowledged, setLargeMapAcknowledged] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const requestVersionRef = useRef(0)
  const canvasRef = useRef<GraphCanvasHandle>(null)

  const load = useCallback(async (amount: number) => {
    const version = ++requestVersionRef.current
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setLoadProgress({ loaded: 0, requested: amount })
    setError(null)
    try {
      const next = await fetchWikiGraphProgressive(amount, controller.signal, ({ loaded, requested, graph: partial }) => {
        if (version !== requestVersionRef.current) return
        setLoadProgress({ loaded, requested })
        setGraph(partial)
      })
      if (version !== requestVersionRef.current) return
      setGraph(next)
      setSelectedId(null)
      setHoveredId(null)
      if (next.source === 'fallback') setError('Wikipedia is unavailable — showing a local demo graph (up to 51 articles).')
      else if (amount > 500 && !usesLocalCorpus) setError('The hosted public API is limited to 500 articles. Run the local D: host for the full indexed corpus.')
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return
      if (version === requestVersionRef.current) setError('Unable to load Wikipedia articles. Try generating the map again.')
    } finally {
      if (version === requestVersionRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(count)
    return () => {
      requestVersionRef.current += 1
      requestRef.current?.abort()
    }
  }, [load])

  useEffect(() => {
    const controller = new AbortController()
    void fetchWikiStats(controller.signal).then((stats) => {
      if (!controller.signal.aborted) setCorpusStats(stats)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [])

  const selected = useMemo(() => graph.nodes.find((node) => node.id === selectedId), [graph.nodes, selectedId])
  const selectedLinks = selected ? graph.links.filter((edge) => {
    const source = typeof edge.source === 'string' ? edge.source : edge.source.id
    const target = typeof edge.target === 'string' ? edge.target : edge.target.id
    return source === selected.id || target === selected.id
  }).length : 0
  const relatedArticles = useMemo(() => {
    if (!selected) return []
    const relatedIds = new Set<string>()
    for (const edge of graph.links) {
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id
      if (source === selected.id) relatedIds.add(target)
      if (target === selected.id) relatedIds.add(source)
    }
    return [...relatedIds].map((id) => graph.nodes.find((node) => node.id === id)).filter((node): node is WikiGraph['nodes'][number] => Boolean(node)).slice(0, 5)
  }, [graph.links, graph.nodes, selected])
  const graphForCanvas = useMemo(() => ({
    nodes: graph.nodes.map((node) => {
      const degree = (node.inDegree ?? 0) + (node.outDegree ?? 0)
      return {
        ...node,
        label: showLabels ? node.title : '',
        color: degree >= 10 ? '#254fef' : degree >= 4 ? '#6e86f2' : '#b6c4ff',
      }
    }),
    links: graph.links,
  }), [graph, showLabels])
  const statusLabel = loading ? 'FETCHING' : graph.source === 'fallback' ? 'DEMO DATA' : graph.nodes.length ? 'WIKIPEDIA' : 'READY'
  const rangeProgress = `${Math.round(((count - 10) / (MAX_LOCAL_ARTICLES - 10)) * 100)}%`
  const largeMap = count > SAFE_NODE_THRESHOLD
  const progressLabel = loading && loadProgress.requested > 500
    ? `Loading ${loadProgress.loaded.toLocaleString()} / ${loadProgress.requested.toLocaleString()}…`
    : 'Loading graph…'

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      <div><div className="eyebrow">EXPLORATORY GRAPH</div><h1>Wiki<span>/Graph</span></h1></div>
      <div className="topbar-meta"><span className="live-dot" /> {graph.source === 'fallback' ? 'LOCAL DEMO DATA' : 'LIVE SIMULATION'} <span className="divider" /> <span className="muted">{corpusStats?.building ? `INDEXING ${formatCount(corpusStats.articles)} ARTICLES` : corpusStats?.articles ? `${formatCount(corpusStats.articles)} ARTICLE CORPUS` : 'Wikipedia knowledge map'}</span></div>
    </header>
    <section className="workspace">
      <aside className="control-panel">
        <div className="panel-heading"><div><div className="eyebrow">CONTROL DECK</div><h2>Shape your map</h2></div><span className={`status-pill ${graph.source === 'fallback' ? 'offline' : ''}`}>● {statusLabel}</span></div>
        <label className="field-label" htmlFor="article-count">ARTICLES <output>{count}</output></label>
        <input id="article-count" className="range" type="range" min="10" max={MAX_LOCAL_ARTICLES} step="10" value={count} style={{ background: `linear-gradient(90deg, #254fef 0%, #254fef ${rangeProgress}, #d9dde5 ${rangeProgress})` }} onChange={(event) => { setCount(Number(event.target.value)); setLargeMapAcknowledged(false) }} />
        <div className="range-labels"><span>10</span><span>{MAX_LOCAL_ARTICLES.toLocaleString()}</span></div>
        {largeMap && <label className="large-map-warning"><input type="checkbox" checked={largeMapAcknowledged} onChange={(event) => setLargeMapAcknowledged(event.target.checked)} /> Large maps may use significant memory and GPU time. Continue past {SAFE_NODE_THRESHOLD.toLocaleString()} articles.</label>}
        <button className="primary-button" onClick={() => void load(count)} disabled={loading || (largeMap && !largeMapAcknowledged)}><span>{loading ? '◌' : '↻'}</span>{loading ? progressLabel : 'Generate new map'}</button>
        <div className="rule" />
        <div className="field-label">SIMULATION</div>
        <button className="toggle-row" onClick={() => setPaused(!paused)} aria-pressed={!paused}><span>Physics engine</span><span className={`toggle ${!paused ? 'on' : ''}`}><i /></span></button>
        <button className="toggle-row" onClick={() => setShowLabels(!showLabels)} aria-pressed={showLabels}><span>Article labels</span><span className={`toggle ${showLabels ? 'on' : ''}`}><i /></span></button>
        <label className="field-label article-select-label" htmlFor="article-select">SELECT ARTICLE</label>
        <select id="article-select" className="article-select" value={selectedId ?? ''} onChange={(event) => setSelectedId(event.target.value || null)} disabled={!graph.nodes.length}>
          <option value="">Choose an article…</option>
          {graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select>
        <div className="legend"><div className="field-label">HOW IT WORKS</div><p><b>Repulsion</b> keeps every article apart.</p><p><b>Links</b> pull connected articles together.</p></div>
        <div className="panel-footer">Drag to explore <span>·</span> Scroll to zoom</div>
      </aside>
      <section className="canvas-panel" aria-label="Wikipedia article graph">
        <div className="canvas-toolbar"><span><b>{graph.nodes.length}</b> articles <i /> <b>{graph.links.length}</b> connections{corpusStats?.articles && <><i /> <span className="muted">{formatCount(corpusStats.articles)} indexed</span></>}{hoveredId && <><i /> <span className="hover-readout">{graph.nodes.find((node) => node.id === hoveredId)?.title}</span></>}</span><span className="toolbar-actions"><button type="button" onClick={() => canvasRef.current?.fit()} disabled={!graph.nodes.length}>Fit</button><button type="button" onClick={() => canvasRef.current?.resetView()} disabled={!graph.nodes.length}>Reset</button><span className="zoom-hint">SCROLL TO ZOOM</span></span></div>
        {error && <div className="notice" role="status">{error}</div>}
        <GraphCanvas ref={canvasRef} graph={graphForCanvas} selectedId={selectedId} onSelect={(node) => setSelectedId(node.id)} onHover={(node) => setHoveredId(node?.id ?? null)} paused={paused} />
        {loading && <div className="loading-overlay"><span className="spinner" />{progressLabel}</div>}
        {selected && <article className="inspector"><button className="close-button" onClick={() => setSelectedId(null)} aria-label="Close inspector">×</button><div className="eyebrow">ARTICLE INSPECTOR</div><h3>{selected.title}</h3><span className="category">WIKIPEDIA ARTICLE</span><p>{selected.extract ?? 'Explore this article and its connections in the knowledge graph.'}</p><div className="inspector-stat"><span>CONNECTIONS</span><b>{selectedLinks}</b></div><div className="inspector-degree"><span><b>{selected.outDegree ?? 0}</b> outbound</span><span><b>{selected.inDegree ?? 0}</b> inbound</span></div><div className="inspector-size"><span>ARTICLE SIZE</span><b>{formatArticleSize(selected.byteLength ?? selected.articleSize)}</b></div>{relatedArticles.length > 0 && <div className="related"><div className="field-label">CONNECTED ARTICLES</div><ul>{relatedArticles.map((node) => <li key={node.id}>{node.title}</li>)}</ul></div>}<a className="text-button" href={selected.url} target="_blank" rel="noreferrer">Open on Wikipedia ↗</a></article>}
        <div className="canvas-footer"><span className="legend-key"><i className="node-key" /> Article</span><span className="legend-key"><i className="edge-key" /> Link direction</span><span className="canvas-credit">Wikipedia · public knowledge</span></div>
      </section>
    </section>
  </main>
}
