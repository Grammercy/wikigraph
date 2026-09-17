import { useCallback, useEffect, useMemo, useState } from 'react'
import GraphCanvas from './components/GraphCanvas'
import { fetchWikiGraph } from './data/wiki'
import type { WikiGraph } from './types'

export default function App() {
  const [count, setCount] = useState(50)
  const [graph, setGraph] = useState<WikiGraph>({ nodes: [], links: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [showLabels, setShowLabels] = useState(true)

  const load = useCallback(async (amount: number) => {
    setLoading(true); setError(null)
    try {
      setGraph(await fetchWikiGraph(amount))
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError('Unable to load Wikipedia articles. Try generating the map again.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(count) }, [load])
  const selected = useMemo(() => graph.nodes.find((node) => node.id === selectedId), [graph.nodes, selectedId])
  const selectedLinks = selected ? graph.links.filter((edge) => {
    const source = typeof edge.source === 'string' ? edge.source : edge.source.id
    const target = typeof edge.target === 'string' ? edge.target : edge.target.id
    return source === selected.id || target === selected.id
  }).length : 0

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      <div><div className="eyebrow">EXPLORATORY GRAPH</div><h1>Wiki<span>Graph</span></h1></div>
      <div className="topbar-meta"><span className="live-dot" /> LIVE SIMULATION <span className="divider" /> <span className="muted">Wikipedia knowledge map</span></div>
    </header>
    <section className="workspace">
      <aside className="control-panel">
        <div className="panel-heading"><div><div className="eyebrow">CONTROL DECK</div><h2>Shape your map</h2></div><span className="status-pill">● READY</span></div>
        <label className="field-label" htmlFor="article-count">ARTICLES <output>{count}</output></label>
        <input id="article-count" className="range" type="range" min="10" max="500" step="10" value={count} onChange={(event) => setCount(Number(event.target.value))} />
        <div className="range-labels"><span>10</span><span>500</span></div>
        <button className="primary-button" onClick={() => void load(count)} disabled={loading}><span>{loading ? '◌' : '↻'}</span>{loading ? 'Loading graph…' : 'Generate new map'}</button>
        <div className="rule" />
        <div className="field-label">SIMULATION</div>
        <button className="toggle-row" onClick={() => setPaused(!paused)} aria-pressed={paused}><span>Physics engine</span><span className={`toggle ${!paused ? 'on' : ''}`}><i /></span></button>
        <button className="toggle-row" onClick={() => setShowLabels(!showLabels)} aria-pressed={showLabels}><span>Article labels</span><span className={`toggle ${showLabels ? 'on' : ''}`}><i /></span></button>
        <div className="legend"><div className="field-label">HOW IT WORKS</div><p><b>Repulsion</b> keeps every article apart.</p><p><b>Links</b> pull connected articles together.</p></div>
        <div className="panel-footer">Drag to explore <span>·</span> Scroll to zoom</div>
      </aside>
      <section className="canvas-panel" aria-label="Wikipedia article graph">
        <div className="canvas-toolbar"><span><b>{graph.nodes.length}</b> articles <i /> <b>{graph.links.length}</b> connections</span><span className="zoom-hint">SCROLL TO ZOOM</span></div>
        {error && <div className="notice" role="status">{error}</div>}
        <GraphCanvas graph={{ nodes: graph.nodes.map((node) => ({ ...node, label: showLabels ? node.title : '' })), links: graph.links }} selectedId={selectedId} onSelect={(node) => setSelectedId(node.id)} paused={paused} getNodeColor={() => '#c7f36b'} />
        {loading && <div className="loading-overlay"><span className="spinner" />Mapping Wikipedia…</div>}
        {selected && <article className="inspector"><button className="close-button" onClick={() => setSelectedId(null)} aria-label="Close inspector">×</button><div className="eyebrow">ARTICLE INSPECTOR</div><h3>{selected.title}</h3><span className="category">WIKIPEDIA ARTICLE</span><p>{selected.extract ?? 'Explore this article and its connections in the knowledge graph.'}</p><div className="inspector-stat"><span>CONNECTIONS</span><b>{selectedLinks}</b></div><a className="text-button" href={selected.url} target="_blank" rel="noreferrer">Open on Wikipedia ↗</a></article>}
        <div className="canvas-footer"><span className="legend-key"><i className="node-key" /> Article</span><span className="legend-key"><i className="edge-key" /> Link direction</span><span className="canvas-credit">Wikipedia · public knowledge</span></div>
      </section>
    </section>
  </main>
}
