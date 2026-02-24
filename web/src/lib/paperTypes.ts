/**
 * TypeScript types for paper/citation API responses.
 *
 * @module lib/paperTypes
 */

/** Matches `arxiv_content_map` row from GET /v1/ingestion/papers */
export interface Paper {
  id: number;
  arxiv_id: string;
  doi: string | null;
  semantic_scholar_id: string | null;
  content_cid: string;
  title: string;
  authors: string[];
  categories: string[];
  published_date: string | null;
  quality_score: number;
  citation_count: number;
  grokipedia_score: number | null;
  ingested_at: string;
}

/** 6-dimension quality breakdown stored as JSONB */
export interface QualityBreakdown {
  referenceDepth: number;
  coauthorNetwork: number;
  institutionalSignal: number;
  venueSignal: number;
  citationSignal: number;
  publicSphere: number;
}

/** Pending citation from GET /v1/ingestion/papers/:arxivId */
export interface PendingCitation {
  target_external_id: string;
  target_platform: string;
  resolved_cid: string | null;
  resolved_at: string | null;
  created_at: string;
}

/** Single paper detail from GET /v1/ingestion/papers/:arxivId */
export interface PaperDetail extends Paper {
  quality_breakdown: QualityBreakdown | null;
  pendingCitations: PendingCitation[];
}

/** GET /v1/ingestion/papers response */
export interface PapersPaginatedResponse {
  papers: Paper[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** GET /v1/citations/most-cited response */
export interface MostCitedResponse {
  papers: Paper[];
  count: number;
}

/** GET /v1/ingestion/status response */
export interface IngestionStatus {
  recentRuns: {
    id: number;
    category: string;
    papers_found: number;
    papers_passed: number;
    papers_failed: number;
    started_at: string;
    completed_at: string | null;
  }[];
  totalPapersIngested: number;
  pendingCitations: number;
}

/** Outbound citation item from GET /v1/citations/:cid */
export interface OutboundCitation {
  id: number;
  target_external_id: string;
  target_platform: string;
  resolved_cid: string | null;
  resolved_at: string | null;
  created_at: string;
  resolved_title: string | null;
  resolved_arxiv_id: string | null;
}

/** Inbound citation item from GET /v1/citations/:cid */
export interface InboundCitation {
  id: number;
  source_cid: string;
  target_external_id: string;
  target_platform: string;
  created_at: string;
  source_title: string | null;
  source_arxiv_id: string | null;
}

/** GET /v1/citations/:cid response */
export interface CitationDetail {
  cid: string;
  outbound: OutboundCitation[];
  inbound: InboundCitation[];
  counts: {
    outbound: number;
    inbound: number;
  };
}

/** Recursive tree node from GET /v1/citations/:cid/tree */
export interface CitationTreeNode {
  cid: string;
  title: string | null;
  arxivId: string | null;
  depth: number;
  direction: "root" | "outbound" | "inbound";
  children: CitationTreeNode[];
}

/** GET /v1/citations/:cid/tree response */
export interface CitationTreeResponse {
  tree: CitationTreeNode;
}

/** Flattened node for react-force-graph-2d */
export interface CitationGraphNode {
  id: string;
  title: string | null;
  arxivId: string | null;
  direction: "root" | "outbound" | "inbound";
  depth: number;
  radius: number;
}

/** Edge for react-force-graph-2d */
export interface CitationGraphEdge {
  source: string;
  target: string;
  direction: "outbound" | "inbound";
}

// --------------- Global Citation Map ---------------

/** Node in the global citation graph (API response shape) */
export interface GlobalCitationNodeRaw {
  id: string;
  arxivId: string;
  title: string;
  categories: string[];
  citationCount: number;
  qualityScore: number;
}

/** Enriched node for react-force-graph-2d rendering */
export interface GlobalCitationNode extends GlobalCitationNodeRaw {
  genre: string;
  color: string;
  radius: number;
}

/** Edge in the global citation graph */
export interface GlobalCitationEdge {
  source: string;
  target: string;
}

/** GET /v1/citations/graph response */
export interface GlobalCitationGraphResponse {
  nodes: GlobalCitationNodeRaw[];
  edges: GlobalCitationEdge[];
  meta: { totalNodes: number; totalEdges: number; generatedAt: string };
}
