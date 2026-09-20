import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GraphCanvas, { DEFAULT_SIMULATION_SETTINGS, type GraphCanvasHandle, type GraphCanvasMode, type GraphData, type GraphSimulationSettings } from './components/GraphCanvas'
import { fetchWikiGraphProgressive, fetchWikiStats, usesLocalCorpus } from './data/wiki'
import { selectHubIds } from './graph/hubs'
import { decayedLinkDistanceScale, LINK_DISTANCE_SCALE_DECAY_MS, LINK_DISTANCE_SCALE_PHYSICS_STEP_MS, LINK_DISTANCE_SCALE_START } from './graph/linkDistanceDecay'
import { isDisambiguationTitle, isYearOrDayArticle } from './graph/articleFilters'
import { formatKineticEnergy } from './graph/energy'
import { rankVisibleArticleNodes, selectVisibleArticleIds } from './graph/visibility'
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

type PhysicsSliderProps = {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
  disabled?: boolean
}

function PhysicsSlider({ id, label, value, min, max, step, onChange, format, disabled = false }: PhysicsSliderProps) {
  const progress = `${Math.max(0, Math.min(100, ((value - min) / Math.max(1e-9, max - min)) * 100))}%`
  const display = format?.(value) ?? (step < 0.01 ? value.toFixed(4) : step < 1 ? value.toFixed(3) : Math.round(value).toLocaleString())
  return <label className={`simulation-control${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
    <span className="simulation-control-label"><span>{label}</span><output>{display}</output></span>
    <input id={id} className="range simulation-range" type="range" min={min} max={max} step={step} value={value} disabled={disabled} style={{ background: `linear-gradient(90deg, #254fef 0%, #254fef ${progress}, #d9dde5 ${progress})` }} onChange={(event) => onChange(Number(event.target.value))} />
  </label>
}

type LogSliderProps = PhysicsSliderProps & {
  center: number
  ticks?: Array<{ value: number; label: string }>
}

function logSliderPosition(value: number, min: number, max: number, center: number) {
  const safeMin = Math.max(Number.MIN_VALUE, min)
  const safeMax = Math.max(safeMin, max)
  const safeCenter = Math.max(safeMin, Math.min(safeMax, center))
  if (safeMax === safeMin) return 0
  if (safeCenter >= safeMax) {
    return Math.max(0, Math.min(1, Math.log(Math.max(safeMin, value) / safeMin) / Math.max(Number.EPSILON, Math.log(safeMax / safeMin))))
  }
  if (safeCenter <= safeMin) {
    return Math.max(0, Math.min(1, Math.log(Math.min(safeMax, value) / safeMin) / Math.max(Number.EPSILON, Math.log(safeMax / safeMin))))
  }
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
  const raw = safeMax === safeMin
    ? safeMin
    : safeCenter >= safeMax || safeCenter <= safeMin
      ? safeMin * Math.exp(boundedPosition * Math.log(Math.max(Number.EPSILON, safeMax / safeMin)))
      : boundedPosition <= 0.5
    ? safeMin * Math.exp((boundedPosition / 0.5) * Math.log(Math.max(Number.EPSILON, safeCenter / safeMin)))
    : safeCenter * Math.exp(((boundedPosition - 0.5) / 0.5) * Math.log(Math.max(Number.EPSILON, safeMax / safeCenter)))
  const snapped = Math.round(raw / step) * step
  return Math.max(min, Math.min(max, snapped))
}

function LogSlider({ id, label, value, min, max, step, center, onChange, format, disabled = false, ticks = [] }: LogSliderProps) {
  const sliderPosition = logSliderPosition(value, min, max, center)
  const sliderUnits = Math.round(sliderPosition * 1_000)
  const display = format?.(value) ?? (step < 1 ? value.toFixed(3) : Math.round(value).toLocaleString())
  const slider = <input id={id} className={`range${label ? ' simulation-range' : ''}`} type="range" min="0" max="1000" step="1" value={sliderUnits} disabled={disabled} aria-valuetext={display} style={{ background: `linear-gradient(90deg, #254fef 0%, #254fef ${sliderUnits / 10}%, #d9dde5 ${sliderUnits / 10}%)` }} onChange={(event) => onChange(logSliderValue(Number(event.target.value) / 1_000, min, max, center, step))} />
  const input = ticks.length > 0 ? <div className="range-scale has-ticks">
    {slider}
    <div className="range-ticks" aria-hidden="true">
      {ticks.map((tick) => <span key={tick.value} className="range-tick" style={{ left: `${logSliderPosition(tick.value, min, max, center) * 100}%` }} />)}
    </div>
    <div className="range-tick-labels">
      {ticks.map((tick, index) => <span key={tick.value} className={`range-tick-label range-tick-label-${index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'center'}`} style={{ left: `${logSliderPosition(tick.value, min, max, center) * 100}%` }}>{tick.label}</span>)}
    </div>
  </div> : slider
  if (!label) return input
  return <label className={`simulation-control${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
    <span className="simulation-control-label"><span>{label}</span><output>{display}</output></span>
    {input}
  </label>
}

export default function App() {
  const SAFE_NODE_THRESHOLD = 1000
  // Stats normally replace this immediately. Keep the pre-fetch transport
  // bound open so an unavailable/stale stats response cannot reintroduce the
  // old 100k ceiling before the full local corpus is discovered.
  const DEFAULT_LOCAL_ARTICLES = Number.MAX_SAFE_INTEGER
  const PUBLIC_MAX_ARTICLES = 500
  const [count, setCount] = useState(50)
  const [displayCount, setDisplayCount] = useState(0)
  const [graph, setGraph] = useState<WikiGraph>({ nodes: [], links: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [showAllLabels, setShowAllLabels] = useState(false)
  const [removeYearAndDayArticles, setRemoveYearAndDayArticles] = useState(true)
  const [graphMode, setGraphMode] = useState<GraphCanvasMode>('2d')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [finderOpen, setFinderOpen] = useState(false)
  const [finderQuery, setFinderQuery] = useState('')
  const [finderActiveIndex, setFinderActiveIndex] = useState(0)
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, requested: 0 })
  const [largeMapAcknowledged, setLargeMapAcknowledged] = useState(false)
  const [corpusStats, setCorpusStats] = useState<WikiStats | null>(null)
  const [simulationEnergy, setSimulationEnergy] = useState(0)
  const [simulationSettings, setSimulationSettings] = useState<GraphSimulationSettings>(() => ({ ...DEFAULT_SIMULATION_SETTINGS }))
  const requestRef = useRef<AbortController | null>(null)
  const requestVersionRef = useRef(0)
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const finderInputRef = useRef<HTMLInputElement>(null)
  const linkDistanceDecayPendingRef = useRef(false)
  const linkDistanceDecayActiveRef = useRef(false)
  const linkDistanceDecayElapsedRef = useRef(0)
  const energyUpdatedAtRef = useRef(0)
  const renderedGraphRef = useRef<GraphData | null>(null)
  // Keep the display slider proportional when a newly generated graph has a
  // different number of loaded articles.
  const displayRatioRef = useRef(1)
  const reportedGraphArticles = corpusStats?.graphArticles && corpusStats.graphArticles > 0
    ? corpusStats.graphArticles
    : corpusStats?.articles && corpusStats.articles > 0
      ? corpusStats.articles
      : DEFAULT_LOCAL_ARTICLES
  const articleMaximum = usesLocalCorpus
    ? Math.max(1, Math.floor(reportedGraphArticles))
    : PUBLIC_MAX_ARTICLES
  const articleMinimum = Math.min(10, articleMaximum)
  const articleTicks = useMemo(() => {
    const values = [...new Set([articleMinimum, 1_000, articleMaximum].filter((value) => value <= articleMaximum))]
    return values.sort((a, b) => a - b).map((value) => ({ value, label: value.toLocaleString() }))
  }, [articleMaximum, articleMinimum])
  const updateSimulationSetting = useCallback(<K extends keyof GraphSimulationSettings>(key: K, value: GraphSimulationSettings[K]) => {
    setSimulationSettings((previous) => ({ ...previous, [key]: value }))
  }, [])
  const stopLinkDistanceDecay = useCallback(() => {
    linkDistanceDecayActiveRef.current = false
  }, [])
  const updateLinkDistanceScale = useCallback((value: number) => {
    linkDistanceDecayPendingRef.current = false
    stopLinkDistanceDecay()
    updateSimulationSetting('linkDistanceScale', value)
  }, [stopLinkDistanceDecay, updateSimulationSetting])

  const startLinkDistanceDecay = useCallback(() => {
    stopLinkDistanceDecay()
    linkDistanceDecayActiveRef.current = true
    linkDistanceDecayElapsedRef.current = 0
  }, [stopLinkDistanceDecay])

  const advanceLinkDistanceDecay = useCallback(() => {
    if (!linkDistanceDecayActiveRef.current) return
    const elapsed = linkDistanceDecayElapsedRef.current + LINK_DISTANCE_SCALE_PHYSICS_STEP_MS
    linkDistanceDecayElapsedRef.current = elapsed
    const nextScale = decayedLinkDistanceScale(elapsed)
    setSimulationSettings((previous) => previous.linkDistanceScale === nextScale
      ? previous
      : { ...previous, linkDistanceScale: nextScale })
    if (elapsed >= LINK_DISTANCE_SCALE_DECAY_MS) stopLinkDistanceDecay()
  }, [stopLinkDistanceDecay])

  const handlePhysicsTick = useCallback((energy: number) => {
    advanceLinkDistanceDecay()
    const now = typeof performance === 'undefined' ? Date.now() : performance.now()
    if (now - energyUpdatedAtRef.current < 100 && energy > 0) return
    energyUpdatedAtRef.current = now
    setSimulationEnergy(energy)
  }, [advanceLinkDistanceDecay])

  useEffect(() => () => stopLinkDistanceDecay(), [stopLinkDistanceDecay])

  useEffect(() => {
    if (!usesLocalCorpus) return
    const controller = new AbortController()
    void fetchWikiStats(controller.signal).then((stats) => {
      if (controller.signal.aborted || !stats) return
      setCorpusStats(stats)
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    setCount((previous) => Math.min(previous, articleMaximum))
  }, [articleMaximum])

  const load = useCallback(async (amount: number, options: { replaceCalendarArticles?: boolean; maximum?: number } = {}) => {
    const targetAmount = Math.max(1, Math.floor(amount) || 1)
    const replaceCalendarArticles = options.replaceCalendarArticles ?? false
    const maximum = Math.max(targetAmount, Math.floor(options.maximum ?? (usesLocalCorpus ? Number.MAX_SAFE_INTEGER : PUBLIC_MAX_ARTICLES)))
    let requestAmount = targetAmount
    linkDistanceDecayPendingRef.current = true
    renderedGraphRef.current = null
    stopLinkDistanceDecay()
    setSimulationSettings((previous) => previous.linkDistanceScale === LINK_DISTANCE_SCALE_START
      ? previous
      : { ...previous, linkDistanceScale: LINK_DISTANCE_SCALE_START })
    const version = ++requestVersionRef.current
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(null)
    try {
      let next: WikiGraph = { nodes: [], links: [] }
      let previousNodeCount = -1
      let previousEligibleCount = -1
      while (true) {
        setLoadProgress({ loaded: 0, requested: requestAmount })
        next = await fetchWikiGraphProgressive(requestAmount, controller.signal, ({ loaded, requested, graph: partial }) => {
          if (version !== requestVersionRef.current) return
          setLoadProgress({ loaded, requested })
          setGraph(partial)
        })
        const hasDisambiguation = next.nodes.some((node) => node.isDisambiguation || isDisambiguationTitle(node.title))
        if (!replaceCalendarArticles && !hasDisambiguation) break
        const eligibleCount = next.nodes.reduce((total, node) => total + ((hasDisambiguation && (node.isDisambiguation || isDisambiguationTitle(node.title))) || (replaceCalendarArticles && isYearOrDayArticle(node.title)) ? 0 : 1), 0)
        if (eligibleCount >= targetAmount || requestAmount >= maximum) break
        // Stop when a local tier, a public preview, or the finite fallback
        // cannot provide any more records. Hosted public-API batches can still
        // yield new records after a sparse response, so keep topping those up.
        if (next.nodes.length <= previousNodeCount && eligibleCount <= previousEligibleCount
          && (usesLocalCorpus || next.source === 'fallback')) break
        previousNodeCount = next.nodes.length
        previousEligibleCount = eligibleCount
        const missing = targetAmount - eligibleCount
        const nextRequestAmount = Math.min(maximum, Math.max(requestAmount + 1, requestAmount + missing))
        if (nextRequestAmount <= requestAmount) break
        requestAmount = nextRequestAmount
      }
      if (version !== requestVersionRef.current) return
      setGraph(next)
      setSelectedId(null)
      setHoveredId(null)
      if (next.source === 'fallback') setError('Wikipedia is unavailable — showing a local demo graph (up to 51 articles).')
      else if (requestAmount > 500 && usesLocalCorpus && next.local !== true) setError('The local Wikipedia index is still building — showing a 1,000-article public-API preview until its tiers are ready.')
      else if (requestAmount > 500 && !usesLocalCorpus) setError('The hosted public API is limited to 500 articles. Run the local D: host for the full indexed corpus.')
    } catch (cause) {
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return
      if (version === requestVersionRef.current) setError('Unable to load Wikipedia articles. Try generating the map again.')
    } finally {
      if (version === requestVersionRef.current) setLoading(false)
    }
  }, [stopLinkDistanceDecay])

  useEffect(() => {
    void load(count, { replaceCalendarArticles: true })
    return () => {
      requestVersionRef.current += 1
      requestRef.current?.abort()
    }
  }, [load])

  const filteredGraph = useMemo(() => {
    const removedIds = new Set(graph.nodes
      .filter((node) => node.isDisambiguation || isDisambiguationTitle(node.title) || (removeYearAndDayArticles && isYearOrDayArticle(node.title)))
      .map((node) => node.id))
    if (!removedIds.size) return graph
    const endpointId = (endpoint: string | WikiGraph['nodes'][number]) => typeof endpoint === 'string' ? endpoint : endpoint.id
    const nodes = graph.nodes.filter((node) => !removedIds.has(node.id))
    const links = graph.links.filter((link) => !removedIds.has(endpointId(link.source)) && !removedIds.has(endpointId(link.target)))
    const degrees = new Map(nodes.map((node) => [node.id, { inDegree: 0, outDegree: 0 }]))
    for (const link of links) {
      const source = degrees.get(endpointId(link.source))
      const target = degrees.get(endpointId(link.target))
      if (source) source.outDegree += 1
      if (target) target.inDegree += 1
    }
    return {
      ...graph,
      nodes: nodes.map((node) => ({ ...node, ...degrees.get(node.id) })),
      links,
    }
  }, [graph, removeYearAndDayArticles])
  const nodeById = useMemo(() => new Map(filteredGraph.nodes.map((node) => [node.id, node])), [filteredGraph.nodes])
  const selected = selectedId ? nodeById.get(selectedId) : undefined
  const finderResults = useMemo(() => {
    const query = finderQuery.trim().toLocaleLowerCase()
    if (!query) return []
    return filteredGraph.nodes
      .map((node) => {
        const title = node.title.toLocaleLowerCase()
        const id = node.id.toLocaleLowerCase()
        const titleIndex = title.indexOf(query)
        const idIndex = id.indexOf(query)
        if (titleIndex < 0 && idIndex < 0) return null
        const score = title === query ? 0 : title.startsWith(query) ? 1 : titleIndex >= 0 ? 2 : 3
        return { node, score, matchIndex: titleIndex >= 0 ? titleIndex : idIndex }
      })
      .filter((result): result is { node: WikiGraph['nodes'][number]; score: number; matchIndex: number } => Boolean(result))
      .sort((a, b) => a.score - b.score || a.matchIndex - b.matchIndex || a.node.title.localeCompare(b.node.title))
      .slice(0, 18)
  }, [finderQuery, filteredGraph.nodes])
  const selectedLinks = useMemo(() => {
    if (!selected) return 0
    let count = 0
    for (const edge of filteredGraph.links) {
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id
      if (source === selected.id || target === selected.id) count += 1
    }
    return count
  }, [filteredGraph.links, selected])
  const relatedArticles = useMemo(() => {
    if (!selected) return []
    const relatedIds = new Set<string>()
    for (const edge of filteredGraph.links) {
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id
      if (source === selected.id) relatedIds.add(target)
      if (target === selected.id) relatedIds.add(source)
    }
    return [...relatedIds].slice(0, 5).map((id) => nodeById.get(id)).filter((node): node is WikiGraph['nodes'][number] => Boolean(node))
  }, [filteredGraph.links, nodeById, selected])
  const hubIds = useMemo(() => selectHubIds(filteredGraph.nodes, filteredGraph.links), [filteredGraph])
  const displayMinimum = hubIds.size
  const displayMaximum = filteredGraph.nodes.length
  const effectiveDisplayCount = displayMaximum > 0
    ? Math.max(displayMinimum, Math.min(displayMaximum, displayCount || displayMinimum))
    : 0
  const displaySliderCenter = displayMaximum > displayMinimum
    ? displayMaximum > 1_000 ? 1_000 : Math.sqrt(Math.max(1, displayMinimum) * displayMaximum)
    : displayMinimum
  const rankedVisibleArticles = useMemo(
    () => rankVisibleArticleNodes(filteredGraph.nodes, hubIds),
    [filteredGraph.nodes, hubIds],
  )
  const visibleNodeIds = useMemo(
    () => selectVisibleArticleIds(filteredGraph.nodes, filteredGraph.links, effectiveDisplayCount, selectedId, hubIds, rankedVisibleArticles),
    [effectiveDisplayCount, filteredGraph, hubIds, rankedVisibleArticles, selectedId],
  )
  const visibleArticleCount = visibleNodeIds.size
  const graphForCanvas = useMemo(() => {
    return {
      nodes: filteredGraph.nodes.map((node) => {
        const degree = (node.inDegree ?? 0) + (node.outDegree ?? 0)
        return {
          ...node,
          color: hubIds.has(node.id) ? '#254fef' : degree >= 4 ? '#6e86f2' : '#b6c4ff',
        }
      }),
      links: filteredGraph.links,
    }
  }, [filteredGraph, hubIds])
  useEffect(() => {
    if (!displayMaximum) {
      setDisplayCount(0)
      return
    }
    const next = Math.max(displayMinimum, Math.min(displayMaximum, Math.round(displayMaximum * displayRatioRef.current)))
    setDisplayCount((previous) => previous === next ? previous : next)
  }, [displayMaximum, displayMinimum])
  useEffect(() => {
    energyUpdatedAtRef.current = 0
    setSimulationEnergy(0)
  }, [graphForCanvas])
  useEffect(() => {
    if (hoveredId && !visibleNodeIds.has(hoveredId)) setHoveredId(null)
  }, [hoveredId, visibleNodeIds])
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null)
  }, [nodeById, selectedId])
  const updateDisplayCount = useCallback((value: number) => {
    const next = Math.max(displayMinimum, Math.min(displayMaximum, Math.round(value)))
    setDisplayCount(next)
    if (displayMaximum > 0) displayRatioRef.current = next / displayMaximum
  }, [displayMaximum, displayMinimum])
  const toggleCalendarArticleFilter = useCallback(() => {
    const next = !removeYearAndDayArticles
    setRemoveYearAndDayArticles(next)
    // Refresh immediately so deleted calendar pages are replaced without
    // making the user press Generate again.
    if (count <= SAFE_NODE_THRESHOLD || largeMapAcknowledged) void load(count, { replaceCalendarArticles: next, maximum: articleMaximum })
  }, [articleMaximum, count, largeMapAcknowledged, load, removeYearAndDayArticles])
  const handleSelect = useCallback((node: GraphData['nodes'][number]) => {
    setSelectedId((current) => current === node.id ? null : node.id)
  }, [])
  const focusArticle = useCallback((node: WikiGraph['nodes'][number]) => {
    setSelectedId(node.id)
    setFinderOpen(false)
    setFinderActiveIndex(0)
    canvasRef.current?.focusNode(node.id)
    // The selection makes hidden nodes renderable on the next React paint. A
    // second pass keeps the article centered after that visibility update.
    if (typeof window !== 'undefined') window.requestAnimationFrame(() => canvasRef.current?.focusNode(node.id))
  }, [])
  const openFinder = useCallback(() => {
    setFinderOpen(true)
    setFinderQuery('')
    setFinderActiveIndex(0)
  }, [])

  useEffect(() => {
    const handleFinderShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openFinder()
        return
      }
      if (finderOpen && event.key === 'Escape') {
        event.preventDefault()
        setFinderOpen(false)
      }
    }
    window.addEventListener('keydown', handleFinderShortcut)
    return () => window.removeEventListener('keydown', handleFinderShortcut)
  }, [finderOpen, openFinder])

  useEffect(() => {
    if (!finderOpen) return
    window.requestAnimationFrame(() => finderInputRef.current?.focus())
  }, [finderOpen])

  useEffect(() => {
    setFinderActiveIndex((index) => Math.max(0, Math.min(index, Math.max(0, finderResults.length - 1))))
  }, [finderResults.length])
  const startPendingLinkDistanceDecay = useCallback(() => {
    if (!linkDistanceDecayPendingRef.current) return
    linkDistanceDecayPendingRef.current = false
    startLinkDistanceDecay()
  }, [startLinkDistanceDecay])
  const handleGraphRendered = useCallback((renderedGraph: GraphData) => {
    renderedGraphRef.current = renderedGraph
    if (!loading && renderedGraph === graphForCanvas) startPendingLinkDistanceDecay()
  }, [graphForCanvas, loading, startPendingLinkDistanceDecay])
  // A small local graph can be emitted as progress and then returned as the
  // final result by the loader without changing its object identity. In that
  // case the canvas already painted it while loading, so acknowledge the
  // render when loading completes as well.
  useEffect(() => {
    if (loading || !filteredGraph.nodes.length || renderedGraphRef.current !== graphForCanvas) return
    startPendingLinkDistanceDecay()
  }, [filteredGraph.nodes.length, graphForCanvas, loading, startPendingLinkDistanceDecay])
  const averageLinks = filteredGraph.nodes.length ? filteredGraph.links.length / filteredGraph.nodes.length : 0
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
        <LogSlider id="article-count" label="" value={Math.max(articleMinimum, Math.min(count, articleMaximum))} min={articleMinimum} max={articleMaximum} step={10} center={Math.min(1_000, articleMaximum)} onChange={(value) => { setCount(value); setLargeMapAcknowledged(false) }} format={(value) => Math.round(value).toLocaleString()} ticks={articleTicks} />
        {displayMaximum > 0 && <>
          <label className="field-label displayed-articles-label" htmlFor="displayed-article-count">DISPLAYED ARTICLES <output>{effectiveDisplayCount.toLocaleString()}</output></label>
          <LogSlider id="displayed-article-count" label="" value={effectiveDisplayCount} min={displayMinimum} max={displayMaximum} step={1} center={displaySliderCenter} onChange={updateDisplayCount} disabled={displayMinimum >= displayMaximum} format={(value) => Math.round(value).toLocaleString()} />
          <div className="range-labels"><span>{displayMinimum.toLocaleString()}</span><span>{Math.round(displaySliderCenter).toLocaleString()}</span><span>{displayMaximum.toLocaleString()}</span></div>
        </>}
        {largeMap && <label className="large-map-warning"><input type="checkbox" checked={largeMapAcknowledged} onChange={(event) => setLargeMapAcknowledged(event.target.checked)} /> Large maps may use significant memory and processing time. Continue past {SAFE_NODE_THRESHOLD.toLocaleString()} articles.</label>}
        <button className="primary-button" onClick={() => void load(count, { replaceCalendarArticles: removeYearAndDayArticles, maximum: articleMaximum })} disabled={loading || (largeMap && !largeMapAcknowledged)}><span>{loading ? '◌' : '↻'}</span>{loading ? progressLabel : 'Generate new map'}</button>
        <div className="rule" />
        <div className="field-label">SIMULATION</div>
        <button className="toggle-row" onClick={() => setPaused(!paused)} aria-pressed={!paused}><span>Physics engine</span><span className={`toggle ${!paused ? 'on' : ''}`}><i /></span></button>
        <button type="button" className="toggle-row" onClick={() => setShowLabels(!showLabels)} aria-label={`${showLabels ? 'Hide' : 'Show'} article names`} aria-pressed={showLabels}><span>Article names</span><span className={`toggle ${showLabels ? 'on' : ''}`}><i /></span></button>
        <button type="button" className="toggle-row" onClick={() => setShowAllLabels(!showAllLabels)} aria-label={`${showAllLabels ? 'Show fewer' : 'Show all'} article names`} aria-pressed={showAllLabels} disabled={!showLabels}><span>Show all names</span><span className={`toggle ${showAllLabels ? 'on' : ''}`}><i /></span></button>
        <button type="button" className="toggle-row" onClick={toggleCalendarArticleFilter} aria-label={`${removeYearAndDayArticles ? 'Show' : 'Remove'} year and day articles`} aria-pressed={removeYearAndDayArticles}><span>Remove year and day articles</span><span className={`toggle ${removeYearAndDayArticles ? 'on' : ''}`}><i /></span></button>
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
          <LogSlider id="setting-link-scale" label={`Link distance${simulationSettings.linkDistanceExponent === 3 ? '³' : '²'} scale`} value={simulationSettings.linkDistanceScale} min={1} max={300000} step={1} center={1_000} onChange={updateLinkDistanceScale} format={(value) => value.toLocaleString()} />
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
          <button type="button" className="settings-reset" onClick={() => { linkDistanceDecayPendingRef.current = false; stopLinkDistanceDecay(); setSimulationSettings({ ...DEFAULT_SIMULATION_SETTINGS }) }}>Reset physics values</button>
        </details>
      </aside>
      <section className="canvas-panel" aria-label="Wikipedia article graph">
        <div className="canvas-toolbar"><span><b>{visibleArticleCount}</b>{visibleArticleCount === filteredGraph.nodes.length ? ' articles' : ` of ${filteredGraph.nodes.length.toLocaleString()} articles`} <i /> <b>{filteredGraph.links.length}</b> connections <i /> <span className="muted">{averageLinks.toFixed(1)} avg links/article</span> <i /> <span className="muted energy-readout" title="Kinetic energy in layout units per simulation tick">energy {formatKineticEnergy(simulationEnergy)}</span>{hoveredId && <><i /> <span className="hover-readout">{nodeById.get(hoveredId)?.title}</span></>}</span><span className="toolbar-actions"><span className="view-badge">{graphMode.toUpperCase()} VIEW</span><button type="button" onClick={openFinder} disabled={!filteredGraph.nodes.length}>Find</button><button type="button" onClick={() => canvasRef.current?.fit()} disabled={!filteredGraph.nodes.length}>Fit</button><button type="button" onClick={() => canvasRef.current?.resetView()} disabled={!filteredGraph.nodes.length}>Reset</button><button type="button" className="export-button" onClick={() => canvasRef.current?.exportSvg()} disabled={loading || !filteredGraph.nodes.length} title="Download the full-resolution graph with every article name" aria-label="Export full-resolution graph as SVG">Export SVG</button><span className="zoom-hint">{graphMode === '3d' ? 'DRAG OR ARROWS TO ORBIT · SCROLL TO ZOOM' : 'SCROLL TO ZOOM'}</span></span></div>
        {finderOpen && <div className="finder-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFinderOpen(false) }}>
          <section className="article-finder" role="dialog" aria-modal="true" aria-label="Article finder">
            <header className="article-finder-header">
              <div className="eyebrow">ARTICLE FINDER</div>
              <button type="button" className="finder-close" onClick={() => setFinderOpen(false)} aria-label="Close article finder">ESC</button>
            </header>
            <div className="finder-input-wrap">
              <span className="finder-search-icon" aria-hidden="true">⌕</span>
              <input
                ref={finderInputRef}
                className="finder-input"
                value={finderQuery}
                onChange={(event) => { setFinderQuery(event.target.value); setFinderActiveIndex(0) }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { event.preventDefault(); setFinderOpen(false) }
                  else if (event.key === 'ArrowDown' && finderResults.length > 0) { event.preventDefault(); setFinderActiveIndex((index) => (index + 1) % finderResults.length) }
                  else if (event.key === 'ArrowUp' && finderResults.length > 0) { event.preventDefault(); setFinderActiveIndex((index) => (index - 1 + finderResults.length) % finderResults.length) }
                  else if (event.key === 'Enter' && finderResults[finderActiveIndex]) { event.preventDefault(); focusArticle(finderResults[finderActiveIndex].node) }
                }}
                placeholder="Search article titles…"
                aria-label="Search article titles"
                aria-controls="article-finder-results"
                aria-activedescendant={finderResults[finderActiveIndex] ? `finder-result-${finderActiveIndex}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <kbd>CTRL F</kbd>
            </div>
            {finderQuery.trim() && <div className="finder-meta" aria-live="polite">
              {`${finderResults.length} match${finderResults.length === 1 ? '' : 'es'}`}
              <span>↑↓ navigate <i /> ↵ open</span>
            </div>}
            <div id="article-finder-results" className="finder-results" role="listbox" aria-label="Matching articles">
              {!finderQuery.trim() && <div className="finder-empty"><span className="finder-empty-mark">↗</span><strong>Type to search the graph</strong><span>Choose an article to center it in your current view.</span></div>}
              {finderQuery.trim() && finderResults.length === 0 && <div className="finder-empty"><span className="finder-empty-mark">∅</span><strong>No matching articles</strong><span>Try a broader title or another keyword.</span></div>}
              {finderResults.map(({ node }, index) => <button
                key={node.id}
                id={`finder-result-${index}`}
                type="button"
                role="option"
                aria-selected={index === finderActiveIndex}
                className={`finder-result${index === finderActiveIndex ? ' active' : ''}`}
                onMouseEnter={() => setFinderActiveIndex(index)}
                onClick={() => focusArticle(node)}
              >
                <span className="finder-result-copy"><strong>{node.title}</strong><span>{node.extract ? node.extract.slice(0, 86) : 'Wikipedia article'}</span></span>
                <span className="finder-result-degree">{((node.inDegree ?? 0) + (node.outDegree ?? 0)).toLocaleString()} links</span>
              </button>)}
            </div>
          </section>
        </div>}
        {error && <div className="notice" role="status">{error}</div>}
        <GraphCanvas className="graph-canvas-host" ref={canvasRef} graph={graphForCanvas} visibleNodeIds={visibleNodeIds} mode={graphMode} showLabels={showLabels} showAllLabels={showAllLabels} onGraphRendered={handleGraphRendered} onPhysicsTick={handlePhysicsTick} selectedId={selectedId} onSelect={handleSelect} onHover={(node) => setHoveredId(node?.id ?? null)} onSimulationGuard={() => setError('Layout paused after a runaway link impulse. Reduce the link distance scale or generate a fresh map.')} paused={paused} settings={simulationSettings} />
        {loading && <div className="loading-overlay"><span className="spinner" />{progressLabel}</div>}
        {selected && <article className="inspector"><button className="close-button" onClick={() => setSelectedId(null)} aria-label="Close inspector">×</button><div className="eyebrow">ARTICLE INSPECTOR</div><h3>{selected.title}</h3><span className="category">WIKIPEDIA ARTICLE</span><p>{selected.extract ?? 'Explore this article and its connections in the knowledge graph.'}</p><div className="inspector-stat"><span>CONNECTIONS</span><b>{selectedLinks}</b></div><div className="inspector-degree"><span><b>{selected.outDegree ?? 0}</b> outbound</span><span><b>{selected.inDegree ?? 0}</b> inbound</span></div><div className="inspector-size"><span>ARTICLE SIZE</span><b>{formatArticleSize(selected.byteLength ?? selected.articleSize)}</b></div>{relatedArticles.length > 0 && <div className="related"><div className="field-label">CONNECTED ARTICLES</div><ul>{relatedArticles.map((node) => <li key={node.id}>{node.title}</li>)}</ul></div>}<a className="text-button" href={selected.url} target="_blank" rel="noreferrer">Open on Wikipedia ↗</a></article>}
      </section>
    </section>
  </main>
}
