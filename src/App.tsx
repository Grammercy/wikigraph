import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GraphCanvas, { DEFAULT_SIMULATION_SETTINGS, type GraphCanvasHandle, type GraphCanvasMode, type GraphSimulationSettings } from './components/GraphCanvas'
import { fetchWikiGraphProgressive, usesLocalCorpus } from './data/wiki'
import { selectHubIds } from './graph/hubs'
import type { WikiGraph } from './types'

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

type PhysicsSliderProps = {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
}

function PhysicsSlider({ id, label, value, min, max, step, onChange, format }: PhysicsSliderProps) {
  const progress = `${Math.max(0, Math.min(100, ((value - min) / Math.max(1e-9, max - min)) * 100))}%`
  const display = format?.(value) ?? (step < 0.01 ? value.toFixed(4) : step < 1 ? value.toFixed(3) : Math.round(value).toLocaleString())
  return <label className="simulation-control" htmlFor={id}>
    <span className="simulation-control-label"><span>{label}</span><output>{display}</output></span>
    <input id={id} className="range simulation-range" type="range" min={min} max={max} step={step} value={value} style={{ background: `linear-gradient(90deg, #254fef 0%, #254fef ${progress}, #d9dde5 ${progress})` }} onChange={(event) => onChange(Number(event.target.value))} />
  </label>
}

type LogSliderProps = PhysicsSliderProps & { center: number }

function logSliderPosition(value: number, min: number, max: number, center: number) {
  const safeMin = Math.max(Number.MIN_VALUE, min)
  const safeMax = Math.max(safeMin, max)
  const safeCenter = Math.max(safeMin, Math.min(safeMax, center))
  if (safeMax === safeMin) return 0
  if (value <= safeCenter) {
    const lowerSpan = Math.max(Number.EPSILON, Math.log(safeCenter / safeMin))
    return Math.max(0, Math.min(0.5, 0.5 * Math.log(Math.max(safeMin, value) / safeMin) / lowerSpan))
  }
  const upperSpan = Math.max(Number.EPSILON, Math.log(safeMax / safeCenter))
  return Math.max(0.5, Math.min(1, 0.5 + 0.5 * Math.log(Math.min(safeMax, value) / safeCenter) / upperSpan))
}

function logSliderValue(position: number, min: number, max: number, center: number, step: number) {
  const safeMin = Math.max(Number.MIN_VALUE, min)
  const safeMax = Math.max(safeMin, max)
  const safeCenter = Math.max(safeMin, Math.min(safeMax, center))
  const boundedPosition = Math.max(0, Math.min(1, position))
  const raw = boundedPosition <= 0.5
    ? safeMin * Math.exp((boundedPosition / 0.5) * Math.log(Math.max(Number.EPSILON, safeCenter / safeMin)))
    : safeCenter * Math.exp(((boundedPosition - 0.5) / 0.5) * Math.log(Math.max(Number.EPSILON, safeMax / safeCenter)))
  const snapped = Math.round(raw / step) * step
  return Math.max(min, Math.min(max, snapped))
}

function LogSlider({ id, label, value, min, max, step, center, onChange, format }: LogSliderProps) {
  const sliderPosition = logSliderPosition(value, min, max, center)
  const sliderUnits = Math.round(sliderPosition * 1_000)
  const display = format?.(value) ?? (step < 1 ? value.toFixed(3) : Math.round(value).toLocaleString())
  const input = <input id={id} className={`range${label ? ' simulation-range' : ''}`} type="range" min="0" max="1000" step="1" value={sliderUnits} aria-valuetext={display} style={{ background: `linear-gradient(90deg, #254fef 0%, #254fef ${sliderUnits / 10}%, #d9dde5 ${sliderUnits / 10}%)` }} onChange={(event) => onChange(logSliderValue(Number(event.target.value) / 1_000, min, max, center, step))} />
  if (!label) return input
  return <label className="simulation-control" htmlFor={id}>
    <span className="simulation-control-label"><span>{label}</span><output>{display}</output></span>
    {input}
  </label>
}

export default function App() {
  const SAFE_NODE_THRESHOLD = 1000
  const MAX_LOCAL_ARTICLES = 100_000
  const [count, setCount] = useState(50)
  const [graph, setGraph] = useState<WikiGraph>({ nodes: [], links: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [graphMode, setGraphMode] = useState<GraphCanvasMode>('2d')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, requested: 0 })
  const [largeMapAcknowledged, setLargeMapAcknowledged] = useState(false)
  const [simulationSettings, setSimulationSettings] = useState<GraphSimulationSettings>(() => ({ ...DEFAULT_SIMULATION_SETTINGS }))
  const requestRef = useRef<AbortController | null>(null)
  const requestVersionRef = useRef(0)
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const updateSimulationSetting = useCallback(<K extends keyof GraphSimulationSettings>(key: K, value: GraphSimulationSettings[K]) => {
    setSimulationSettings((previous) => ({ ...previous, [key]: value }))
  }, [])

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
      else if (amount > 500 && usesLocalCorpus && next.local !== true) setError('The local Wikipedia index is still building — showing a 1,000-article public-API preview until its tiers are ready.')
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

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const selected = selectedId ? nodeById.get(selectedId) : undefined
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
    return [...relatedIds].slice(0, 5).map((id) => nodeById.get(id)).filter((node): node is WikiGraph['nodes'][number] => Boolean(node))
  }, [graph.links, nodeById, selected])
  const graphForCanvas = useMemo(() => {
    const hubIds = selectHubIds(graph.nodes, graph.links)
    return {
      nodes: graph.nodes.map((node) => {
        const degree = (node.inDegree ?? 0) + (node.outDegree ?? 0)
        return {
          ...node,
          label: showLabels ? node.title : '',
          color: hubIds.has(node.id) ? '#254fef' : degree >= 4 ? '#6e86f2' : '#b6c4ff',
        }
      }),
      links: graph.links,
    }
  }, [graph, showLabels])
  const averageLinks = graph.nodes.length ? graph.links.length / graph.nodes.length : 0
  const largeMap = count > SAFE_NODE_THRESHOLD
  const progressLabel = loading && loadProgress.requested > 500
    ? `Loading ${loadProgress.loaded.toLocaleString()} / ${loadProgress.requested.toLocaleString()}…`
    : 'Loading graph…'

  return <main className="app-shell">
    <header className="topbar">
      <svg className="brand-mark" viewBox="0 0 27 27" role="img" aria-label="WikiGraph logo">
        <path className="brand-mark-link" d="M5 14L22 5M5 14L22 22" />
        <circle className="brand-mark-node brand-mark-node-primary" cx="5" cy="14" r="4" />
        <circle className="brand-mark-node brand-mark-node-secondary" cx="22" cy="5" r="4" />
        <circle className="brand-mark-node brand-mark-node-secondary" cx="22" cy="22" r="4" />
      </svg>
      <div><div className="eyebrow">EXPLORATORY GRAPH</div><h1>Wiki<span>/Graph</span></h1></div>
    </header>
    <section className="workspace">
      <aside className="control-panel">
        <label className="field-label" htmlFor="article-count">ARTICLES <output>{count}</output></label>
        <LogSlider id="article-count" label="" value={count} min={10} max={MAX_LOCAL_ARTICLES} step={10} center={1_000} onChange={(value) => { setCount(value); setLargeMapAcknowledged(false) }} format={(value) => Math.round(value).toLocaleString()} />
        <div className="range-labels"><span>10</span><span>1,000</span><span>{MAX_LOCAL_ARTICLES.toLocaleString()}</span></div>
        {largeMap && <label className="large-map-warning"><input type="checkbox" checked={largeMapAcknowledged} onChange={(event) => setLargeMapAcknowledged(event.target.checked)} /> Large maps may use significant memory and GPU time. Continue past {SAFE_NODE_THRESHOLD.toLocaleString()} articles.</label>}
        <button className="primary-button" onClick={() => void load(count)} disabled={loading || (largeMap && !largeMapAcknowledged)}><span>{loading ? '◌' : '↻'}</span>{loading ? progressLabel : 'Generate new map'}</button>
        <div className="rule" />
        <div className="field-label">SIMULATION</div>
        <button className="toggle-row" onClick={() => setPaused(!paused)} aria-pressed={!paused}><span>Physics engine</span><span className={`toggle ${!paused ? 'on' : ''}`}><i /></span></button>
        <button className="toggle-row" onClick={() => setShowLabels(!showLabels)} aria-pressed={showLabels}><span>Article labels</span><span className={`toggle ${showLabels ? 'on' : ''}`}><i /></span></button>
        <div className="view-mode-control" role="group" aria-label="Graph view">
          <span className="view-mode-label">Graph view</span>
          <div className="view-mode-options">
            <button type="button" className={graphMode === '2d' ? 'active' : ''} aria-pressed={graphMode === '2d'} onClick={() => setGraphMode('2d')}>2D</button>
            <button type="button" className={graphMode === '3d' ? 'active' : ''} aria-pressed={graphMode === '3d'} onClick={() => setGraphMode('3d')}>3D</button>
          </div>
        </div>
        <details className="simulation-settings">
          <summary><span>Advanced physics</span><span className="settings-live">LIVE</span></summary>
          <p className="simulation-settings-note">Adjust every major force and cooling value. Changes restart the layout without fetching new articles.</p>
          <div className="settings-group-title">REPULSION &amp; LINKS</div>
          <PhysicsSlider id="setting-base-charge" label="Base repulsion" value={simulationSettings.baseCharge} min={0} max={400} step={5} onChange={(value) => updateSimulationSetting('baseCharge', value)} />
          <PhysicsSlider id="setting-importance-charge" label="Article importance" value={simulationSettings.articleImportanceCharge} min={0} max={500} step={5} onChange={(value) => updateSimulationSetting('articleImportanceCharge', value)} />
          <PhysicsSlider id="setting-hub-charge" label="Hub repulsion" value={simulationSettings.hubCharge} min={0} max={3000} step={10} onChange={(value) => updateSimulationSetting('hubCharge', value)} />
          <PhysicsSlider id="setting-charge-distance" label="Charge radius" value={simulationSettings.chargeDistance} min={100} max={2000} step={10} onChange={(value) => updateSimulationSetting('chargeDistance', value)} />
          <LogSlider id="setting-link-scale" label={`Link distance${simulationSettings.linkDistanceExponent === 3 ? '³' : '²'} scale`} value={simulationSettings.linkDistanceScale} min={1} max={300000} step={1} center={1_000} onChange={(value) => updateSimulationSetting('linkDistanceScale', value)} format={(value) => value.toLocaleString()} />
          <button
            type="button"
            className="toggle-row distance-mode-toggle"
            onClick={() => updateSimulationSetting('linkDistanceExponent', simulationSettings.linkDistanceExponent === 3 ? 2 : 3)}
            aria-pressed={simulationSettings.linkDistanceExponent === 3}
            aria-label={`Use distance cubed spring; currently distance ${simulationSettings.linkDistanceExponent === 3 ? 'cubed' : 'squared'}`}
          >
            <span>Distance cubed</span>
            <span className={`toggle ${simulationSettings.linkDistanceExponent === 3 ? 'on' : ''}`}><i /></span>
          </button>
          <PhysicsSlider id="setting-link-floor" label="Link weight floor" value={simulationSettings.linkWeightFloor} min={0} max={0.25} step={0.005} onChange={(value) => updateSimulationSetting('linkWeightFloor', value)} />
          <PhysicsSlider id="setting-unrelated-base" label="Unrelated push" value={simulationSettings.unrelatedBaseStrength} min={0} max={500} step={5} onChange={(value) => updateSimulationSetting('unrelatedBaseStrength', value)} />
          <PhysicsSlider id="setting-unrelated-hub" label="Unrelated hub push" value={simulationSettings.unrelatedHubStrength} min={0} max={2000} step={10} onChange={(value) => updateSimulationSetting('unrelatedHubStrength', value)} />
          <PhysicsSlider id="setting-unrelated-distance" label="Unrelated radius" value={simulationSettings.unrelatedDistance} min={100} max={1200} step={10} onChange={(value) => updateSimulationSetting('unrelatedDistance', value)} />
          <PhysicsSlider id="setting-unrelated-budget" label="Unrelated work budget" value={simulationSettings.unrelatedInteractionBudget} min={20000} max={500000} step={10000} onChange={(value) => updateSimulationSetting('unrelatedInteractionBudget', value)} format={(value) => value.toLocaleString()} />
          <div className="settings-group-title">HUB TERRITORIES</div>
          <PhysicsSlider id="setting-hub-reference" label="Hub score reference" value={simulationSettings.hubDegreeReference} min={10} max={500} step={5} onChange={(value) => updateSimulationSetting('hubDegreeReference', value)} />
          <PhysicsSlider id="setting-territory-base" label="Territory base" value={simulationSettings.hubTerritoryBase} min={50} max={1200} step={10} onChange={(value) => updateSimulationSetting('hubTerritoryBase', value)} />
          <PhysicsSlider id="setting-territory-scale" label="Territory degree scale" value={simulationSettings.hubTerritoryScale} min={0} max={1500} step={10} onChange={(value) => updateSimulationSetting('hubTerritoryScale', value)} />
          <PhysicsSlider id="setting-hub-force-base" label="Hub force base" value={simulationSettings.hubForceBase} min={0} max={200} step={1} onChange={(value) => updateSimulationSetting('hubForceBase', value)} />
          <PhysicsSlider id="setting-hub-force-scale" label="Hub force scale" value={simulationSettings.hubForceScale} min={0} max={2000} step={10} onChange={(value) => updateSimulationSetting('hubForceScale', value)} />
          <PhysicsSlider id="setting-hub-force-max" label="Hub force maximum" value={simulationSettings.hubForceMax} min={1} max={300} step={1} onChange={(value) => updateSimulationSetting('hubForceMax', value)} />
          <div className="settings-group-title">IMPORTANCE &amp; MOTION</div>
          <PhysicsSlider id="setting-size-weight" label="Article-size weight" value={simulationSettings.articleSizeWeight} min={0} max={1} step={0.05} onChange={(value) => updateSimulationSetting('articleSizeWeight', value)} />
          <PhysicsSlider id="setting-max-bytes" label="Article-size ceiling" value={simulationSettings.articleMaxBytes} min={100000} max={10000000} step={100000} onChange={(value) => updateSimulationSetting('articleMaxBytes', value)} format={(value) => `${(value / 1000000).toFixed(1)} MB`} />
          <PhysicsSlider id="setting-degree-cap" label="Degree importance ceiling" value={simulationSettings.articleDegreeCap} min={1} max={500} step={1} onChange={(value) => updateSimulationSetting('articleDegreeCap', value)} />
          <PhysicsSlider id="setting-collision-padding" label="Collision padding" value={simulationSettings.collisionPadding} min={0} max={40} step={1} onChange={(value) => updateSimulationSetting('collisionPadding', value)} />
          <PhysicsSlider id="setting-collision-iterations" label="Collision passes" value={simulationSettings.collisionIterations} min={1} max={6} step={1} onChange={(value) => updateSimulationSetting('collisionIterations', value)} />
          <PhysicsSlider id="setting-center" label="Centering strength" value={simulationSettings.centerStrength} min={0} max={0.2} step={0.005} onChange={(value) => updateSimulationSetting('centerStrength', value)} />
          <PhysicsSlider id="setting-velocity-decay" label="Velocity damping" value={simulationSettings.velocityDecay} min={0} max={0.9} step={0.01} onChange={(value) => updateSimulationSetting('velocityDecay', value)} />
          <PhysicsSlider id="setting-initial-temperature" label="Initial temperature" value={simulationSettings.initialTemperature} min={0.02} max={1} step={0.01} onChange={(value) => updateSimulationSetting('initialTemperature', value)} format={(value) => value.toFixed(2)} />
          <PhysicsSlider id="setting-alpha-decay" label="Alpha decay" value={simulationSettings.alphaDecay} min={0.001} max={0.1} step={0.001} onChange={(value) => updateSimulationSetting('alphaDecay', value)} />
          <PhysicsSlider id="setting-alpha-min" label="Alpha minimum" value={simulationSettings.alphaMin} min={0.0001} max={0.02} step={0.0001} onChange={(value) => updateSimulationSetting('alphaMin', value)} />
          <PhysicsSlider id="setting-alpha-target" label="Running alpha target" value={simulationSettings.alphaTarget} min={0} max={0.2} step={0.005} onChange={(value) => updateSimulationSetting('alphaTarget', value)} />
          <button type="button" className="settings-reset" onClick={() => setSimulationSettings({ ...DEFAULT_SIMULATION_SETTINGS })}>Reset physics values</button>
        </details>
      </aside>
      <section className="canvas-panel" aria-label="Wikipedia article graph">
        <div className="canvas-toolbar"><span><b>{graph.nodes.length}</b> articles <i /> <b>{graph.links.length}</b> connections <i /> <span className="muted">{averageLinks.toFixed(1)} avg links/article</span>{hoveredId && <><i /> <span className="hover-readout">{nodeById.get(hoveredId)?.title}</span></>}</span><span className="toolbar-actions"><span className="view-badge">{graphMode.toUpperCase()} VIEW</span><button type="button" onClick={() => canvasRef.current?.fit()} disabled={!graph.nodes.length}>Fit</button><button type="button" onClick={() => canvasRef.current?.resetView()} disabled={!graph.nodes.length}>Reset</button><span className="zoom-hint">{graphMode === '3d' ? 'DRAG OR ARROWS TO ORBIT · SCROLL TO ZOOM' : 'SCROLL TO ZOOM'}</span></span></div>
        {error && <div className="notice" role="status">{error}</div>}
        <GraphCanvas className="graph-canvas-host" ref={canvasRef} graph={graphForCanvas} mode={graphMode} selectedId={selectedId} onSelect={(node) => setSelectedId(node.id)} onHover={(node) => setHoveredId(node?.id ?? null)} onSimulationGuard={() => setError('Layout paused after a runaway link impulse. Reduce the link distance scale or generate a fresh map.')} paused={paused} settings={simulationSettings} />
        {loading && <div className="loading-overlay"><span className="spinner" />{progressLabel}</div>}
        {selected && <article className="inspector"><button className="close-button" onClick={() => setSelectedId(null)} aria-label="Close inspector">×</button><div className="eyebrow">ARTICLE INSPECTOR</div><h3>{selected.title}</h3><span className="category">WIKIPEDIA ARTICLE</span><p>{selected.extract ?? 'Explore this article and its connections in the knowledge graph.'}</p><div className="inspector-stat"><span>CONNECTIONS</span><b>{selectedLinks}</b></div><div className="inspector-degree"><span><b>{selected.outDegree ?? 0}</b> outbound</span><span><b>{selected.inDegree ?? 0}</b> inbound</span></div><div className="inspector-size"><span>ARTICLE SIZE</span><b>{formatArticleSize(selected.byteLength ?? selected.articleSize)}</b></div>{relatedArticles.length > 0 && <div className="related"><div className="field-label">CONNECTED ARTICLES</div><ul>{relatedArticles.map((node) => <li key={node.id}>{node.title}</li>)}</ul></div>}<a className="text-button" href={selected.url} target="_blank" rel="noreferrer">Open on Wikipedia ↗</a></article>}
      </section>
    </section>
  </main>
}
