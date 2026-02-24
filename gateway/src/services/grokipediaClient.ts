/**
 * Grokipedia client for public sphere influence signals.
 *
 * Scrapes Grokipedia pages to determine how prominently a paper or
 * topic is represented in the public sphere. Returns a score 0-20:
 *   0  = not found
 *   5  = mentioned in passing
 *   10 = has a dedicated section
 *   15 = prominent section (large, with subheadings)
 *   20 = dedicated page
 *
 * If `baseUrl` is empty or not set, the client is disabled and all
 * lookups return `{ score: 0, found: false }`.
 *
 * Uses a 15-minute in-memory cache to avoid redundant fetches.
 *
 * @module services/grokipediaClient
 */

// ============================================================
//  Types
// ============================================================

export interface InfluenceResult {
  score: number;
  found: boolean;
}

// ============================================================
//  Cache Entry
// ============================================================

interface CacheEntry {
  result: InfluenceResult;
  expiresAt: number;
}

// ============================================================
//  Constants
// ============================================================

/** Cache TTL: 15 minutes. */
const CACHE_TTL_MS = 15 * 60 * 1000;

// ============================================================
//  GrokipediaClient
// ============================================================

export class GrokipediaClient {
  private readonly baseUrl: string;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.GROKIPEDIA_BASE_URL || "").replace(/\/+$/, "");
  }

  // ------------------------------------------------------------------
  //  Public Methods
  // ------------------------------------------------------------------

  /**
   * Get influence score for a paper by title and optional author names.
   *
   * Searches Grokipedia for the title and evaluates how prominently
   * the content appears. Returns `{ score: 0, found: false }` on any
   * error or if the client is disabled (no baseUrl).
   */
  async getInfluenceScore(title: string, authors?: string[]): Promise<InfluenceResult> {
    // Feature disabled — no base URL configured
    if (!this.baseUrl) {
      return { score: 0, found: false };
    }

    const cacheKey = this.buildCacheKey(title, authors);

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    try {
      const result = await this.fetchAndScore(title, authors);
      this.cacheResult(cacheKey, result);
      return result;
    } catch {
      return { score: 0, found: false };
    }
  }

  // ------------------------------------------------------------------
  //  Internal Helpers
  // ------------------------------------------------------------------

  /**
   * Fetch the Grokipedia search results page and score prominence.
   */
  private async fetchAndScore(title: string, authors?: string[]): Promise<InfluenceResult> {
    const query = encodeURIComponent(title);
    const searchUrl = `${this.baseUrl}/search?q=${query}`;

    const response = await fetch(searchUrl, {
      headers: { "User-Agent": "NookplotGateway/0.1.0" },
    });

    if (!response.ok) {
      return { score: 0, found: false };
    }

    const html = await response.text();

    // Check for dedicated page (redirected or single result with full content)
    if (this.hasDedicatedPage(html, title)) {
      return { score: 20, found: true };
    }

    // Check for prominent section (h2/h3 heading + substantial content)
    if (this.hasProminentSection(html, title)) {
      return { score: 15, found: true };
    }

    // Check for any section heading mentioning the title
    if (this.hasSection(html, title)) {
      return { score: 10, found: true };
    }

    // Check for any mention at all
    if (this.hasMention(html, title, authors)) {
      return { score: 5, found: true };
    }

    return { score: 0, found: false };
  }

  /**
   * Check if the page appears to be a dedicated article for this title.
   * Heuristic: <h1> contains the title text.
   */
  private hasDedicatedPage(html: string, title: string): boolean {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!h1Match) return false;
    const h1Text = this.stripTags(h1Match[1]).toLowerCase();
    const titleLower = title.toLowerCase();
    return h1Text.includes(titleLower) || this.fuzzyContains(h1Text, titleLower);
  }

  /**
   * Check if there is a prominent section (heading + >500 chars of content).
   */
  private hasProminentSection(html: string, title: string): boolean {
    const titleLower = title.toLowerCase();
    // Match h2 or h3 headings
    const headingRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(html)) !== null) {
      const headingText = this.stripTags(match[1]).toLowerCase();
      if (headingText.includes(titleLower) || this.fuzzyContains(headingText, titleLower)) {
        // Check the content after this heading until the next heading
        const afterHeading = html.slice(match.index + match[0].length);
        const nextHeading = afterHeading.search(/<h[1-6][^>]*>/i);
        const sectionHtml = nextHeading > 0 ? afterHeading.slice(0, nextHeading) : afterHeading.slice(0, 2000);
        const sectionText = this.stripTags(sectionHtml).trim();
        if (sectionText.length > 500) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if any heading contains the title (section-level mention).
   */
  private hasSection(html: string, title: string): boolean {
    const titleLower = title.toLowerCase();
    const headingRegex = /<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/gi;
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(html)) !== null) {
      const headingText = this.stripTags(match[1]).toLowerCase();
      if (headingText.includes(titleLower) || this.fuzzyContains(headingText, titleLower)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if the title or any author name appears in the page body.
   */
  private hasMention(html: string, title: string, authors?: string[]): boolean {
    const bodyText = this.stripTags(html).toLowerCase();
    const titleLower = title.toLowerCase();

    if (bodyText.includes(titleLower)) {
      return true;
    }

    // Check author names
    if (authors && authors.length > 0) {
      for (const author of authors) {
        if (author && bodyText.includes(author.toLowerCase())) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Fuzzy containment check: returns true if at least 80% of the
   * words in `needle` appear in `haystack`.
   */
  private fuzzyContains(haystack: string, needle: string): boolean {
    const words = needle.split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return false;
    const matched = words.filter((w) => haystack.includes(w));
    return matched.length / words.length >= 0.8;
  }

  /**
   * Strip HTML tags from a string.
   */
  private stripTags(html: string): string {
    return html.replace(/<[^>]*>/g, "");
  }

  /**
   * Build a deterministic cache key from the title and authors.
   */
  private buildCacheKey(title: string, authors?: string[]): string {
    const parts = [title.toLowerCase().trim()];
    if (authors && authors.length > 0) {
      parts.push(authors.map((a) => a.toLowerCase().trim()).sort().join(","));
    }
    return parts.join("|");
  }

  /**
   * Store a result in the in-memory cache with TTL.
   */
  private cacheResult(key: string, result: InfluenceResult): void {
    // Evict expired entries periodically (every 100 writes)
    if (this.cache.size > 0 && this.cache.size % 100 === 0) {
      this.evictExpired();
    }

    this.cache.set(key, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  /**
   * Remove all expired entries from the cache.
   */
  private evictExpired(): void {
    const now = Date.now();
    const keys = Array.from(this.cache.keys());
    for (const key of keys) {
      const entry = this.cache.get(key);
      if (entry && now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
