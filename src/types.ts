import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

/** A Wikipedia article as consumed by the graph renderer. */
export interface WikiNode extends SimulationNodeDatum {
  /** Stable, canonical article title (also used as the graph key). */
  id: string
  title: string
  url: string
  extract?: string
  /** Optional source metadata from a dump/index (usually article byte length). */
  articleSize?: number
  byteLength?: number
  inDegree?: number
  outDegree?: number
}

export interface WikiLink extends SimulationLinkDatum<WikiNode> {
  source: string | WikiNode
  target: string | WikiNode
}

export interface WikiGraph {
  nodes: WikiNode[]
  links: WikiLink[]
  /** Identifies whether this graph came from Wikipedia or the offline seed graph. */
  source?: 'wikipedia' | 'fallback'
  /** True when the graph was served by the local dump-backed corpus. */
  local?: boolean
}

/** Corpus-level metadata returned by the local dump-backed API. */
export interface WikiStats {
  articles: number
  links?: number | null
  totalArticleBytes?: number | null
  pagesRead?: number
  indexed?: boolean
  building?: boolean
  source?: string
  tiers?: Array<{ count: number; links?: number; bytes?: number }>
  updatedAt?: string | null
}
