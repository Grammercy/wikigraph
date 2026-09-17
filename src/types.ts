import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'

/** A Wikipedia article as consumed by the graph renderer. */
export interface WikiNode extends SimulationNodeDatum {
  /** Stable, canonical article title (also used as the graph key). */
  id: string
  title: string
  url: string
  extract?: string
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
}
