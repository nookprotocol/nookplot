/**
 * Semantic Scholar Academic Graph API client.
 *
 * Wraps the public S2 API for paper lookup, author profiles, and batch
 * retrieval. Supports optional API key for higher rate limits.
 *
 * Rate limiting: simple token bucket (100 req/5min without key,
 * 10k/5min with key). All methods gracefully return null on error.
 *
 * @module services/semanticScholarClient
 */

// ============================================================
//  Types
// ============================================================

export interface S2Paper {
  paperId: string;
  title: string;
  abstract?: string;
  authors: S2Author[];
  references?: S2Reference[];
  citations?: S2Reference[];
  venue?: string;
  year?: number;
  externalIds?: { ArXiv?: string; DOI?: string; DBLP?: string; CorpusId?: number };
  citationCount?: number;
  influentialCitationCount?: number;
}

export interface S2Author {
  authorId: string;
  name: string;
  affiliations?: string[];
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
  externalIds?: { ORCID?: string; DBLP?: string[] };
}

export interface S2Reference {
  paperId: string;
  title?: string;
}

// ============================================================
//  Token Bucket Rate Limiter
// ============================================================

class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(maxTokens: number, refillIntervalMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = maxTokens / refillIntervalMs;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume one token. Returns true if allowed, false if rate-limited.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ============================================================
//  Constants
// ============================================================

const S2_BASE_URL = "https://api.semanticscholar.org/graph/v1";

const PAPER_FIELDS = [
  "title",
  "abstract",
  "authors",
  "references",
  "citations",
  "venue",
  "year",
  "externalIds",
  "citationCount",
  "influentialCitationCount",
].join(",");

const AUTHOR_FIELDS = [
  "name",
  "affiliations",
  "paperCount",
  "citationCount",
  "hIndex",
  "externalIds",
].join(",");

const BATCH_FIELDS = [
  "title",
  "authors",
  "references",
  "externalIds",
  "citationCount",
  "venue",
  "year",
].join(",");

/** 5 minutes in milliseconds. */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

// ============================================================
//  SemanticScholarClient
// ============================================================

export class SemanticScholarClient {
  private readonly apiKey: string | undefined;
  private readonly bucket: TokenBucket;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.SEMANTIC_SCHOLAR_API_KEY || undefined;
    const limit = this.apiKey ? 10_000 : 100;
    this.bucket = new TokenBucket(limit, FIVE_MINUTES_MS);
  }

  // ------------------------------------------------------------------
  //  Public Methods
  // ------------------------------------------------------------------

  /**
   * Fetch a single paper by arXiv ID, DOI, or Semantic Scholar ID.
   *
   * arXiv IDs are automatically prefixed with `ARXIV:`, DOIs with `DOI:`.
   * Returns null if the paper is not found or on any error.
   */
  async getPaper(id: string): Promise<S2Paper | null> {
    const resolvedId = this.resolveId(id);
    const url = `${S2_BASE_URL}/paper/${encodeURIComponent(resolvedId)}?fields=${PAPER_FIELDS}`;
    return this.fetchJson<S2Paper>(url);
  }

  /**
   * Fetch an author profile by Semantic Scholar author ID.
   *
   * Returns null if the author is not found or on any error.
   */
  async getAuthor(authorId: string): Promise<S2Author | null> {
    const url = `${S2_BASE_URL}/author/${encodeURIComponent(authorId)}?fields=${AUTHOR_FIELDS}`;
    return this.fetchJson<S2Author>(url);
  }

  /**
   * Batch-fetch papers by ID (up to 500 per call).
   *
   * IDs are resolved with the same arXiv/DOI prefix logic as `getPaper`.
   * Returns an array of papers; papers that could not be found are omitted.
   */
  async getBulkPapers(ids: string[]): Promise<S2Paper[]> {
    if (ids.length === 0) return [];
    if (ids.length > 500) {
      ids = ids.slice(0, 500);
    }

    const resolvedIds = ids.map((id) => this.resolveId(id));
    const url = `${S2_BASE_URL}/paper/batch?fields=${BATCH_FIELDS}`;

    if (!this.bucket.consume()) {
      return [];
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "NookplotGateway/0.1.0",
      };
      if (this.apiKey) {
        headers["x-api-key"] = this.apiKey;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ids: resolvedIds }),
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as Array<S2Paper | null>;
      // Filter out null entries (papers not found)
      return data.filter((p): p is S2Paper => p !== null);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  //  Internal Helpers
  // ------------------------------------------------------------------

  /**
   * Resolve an identifier to the S2-expected format.
   *
   * - arXiv IDs (e.g. "2301.12345") → "ARXIV:2301.12345"
   * - DOIs (e.g. "10.1234/foo") → "DOI:10.1234/foo"
   * - Already-prefixed or S2 IDs → returned as-is
   */
  private resolveId(id: string): string {
    const trimmed = id.trim();

    // Already prefixed
    if (/^(ARXIV|DOI|DBLP|MAG|ACL|PMID|CorpusId):/i.test(trimmed)) {
      return trimmed;
    }

    // arXiv pattern: digits + dot + digits (with optional version)
    if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed)) {
      return `ARXIV:${trimmed}`;
    }

    // DOI pattern: starts with "10."
    if (trimmed.startsWith("10.")) {
      return `DOI:${trimmed}`;
    }

    // Assume S2 paper ID (40-char hex) or other identifier
    return trimmed;
  }

  /**
   * Perform a rate-limited GET request and parse the JSON response.
   * Returns null on any error (network, non-2xx status, parse failure).
   */
  private async fetchJson<T>(url: string): Promise<T | null> {
    if (!this.bucket.consume()) {
      return null;
    }

    try {
      const headers: Record<string, string> = {
        "User-Agent": "NookplotGateway/0.1.0",
      };
      if (this.apiKey) {
        headers["x-api-key"] = this.apiKey;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
