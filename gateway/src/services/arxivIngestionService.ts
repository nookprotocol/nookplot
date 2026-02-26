/**
 * arXiv paper ingestion service.
 *
 * Polls arXiv RSS/Atom feeds for new papers, enriches them with Semantic
 * Scholar metadata and Grokipedia public-sphere scores, runs quality
 * scoring, and stores qualifying papers in the `arxiv_content_map` table.
 *
 * For each ingested paper:
 *   - Unclaimed credits are created for every author (platform='arxiv')
 *   - Pending citations are stored for references not yet ingested
 *   - Existing pending citations targeting this paper are resolved
 *
 * @module services/arxivIngestionService
 */

import crypto from "node:crypto";
import type { Pool } from "pg";
import { SemanticScholarClient, S2Paper } from "./semanticScholarClient.js";
import { PaperQualityScorer } from "./paperQualityScorer.js";
import { GrokipediaClient } from "./grokipediaClient.js";

// ============================================================
//  Types
// ============================================================

export interface IngestionRunResult {
  category: string;
  papersFound: number;
  papersPassed: number;
  papersFailed: number;
}

export interface ResolvedCitation {
  sourceCid: string;
  resolvedCid: string;
}

export interface IngestionStats {
  totalPapers: number;
  pendingCitations: number;
  recentRuns: Array<{
    category: string;
    papersFound: number;
    papersPassed: number;
    startedAt: Date;
  }>;
}

// ============================================================
//  Internal types for RSS parsing
// ============================================================

interface RssItem {
  title: string;
  link: string;
  arxivId: string;
  description: string;
}

// ============================================================
//  ArxivIngestionService
// ============================================================

export class ArxivIngestionService {
  private readonly pool: Pool;
  private readonly s2Client: SemanticScholarClient;
  private readonly qualityScorer: PaperQualityScorer;
  private readonly grokipediaClient: GrokipediaClient;

  constructor(
    pool: Pool,
    s2Client: SemanticScholarClient,
    qualityScorer: PaperQualityScorer,
    grokipediaClient: GrokipediaClient,
  ) {
    this.pool = pool;
    this.s2Client = s2Client;
    this.qualityScorer = qualityScorer;
    this.grokipediaClient = grokipediaClient;
  }

  // ------------------------------------------------------------------
  //  Public Methods
  // ------------------------------------------------------------------

  /**
   * Poll a single arXiv RSS category feed and ingest new papers.
   *
   * Fetches `https://export.arxiv.org/rss/${category}`, parses the XML
   * for `<item>` blocks, and processes each paper through the
   * enrichment/scoring/storage pipeline.
   *
   * Papers that already exist in `arxiv_content_map` are skipped.
   * Individual paper failures do not halt the batch.
   */
  async pollCategory(category: string): Promise<IngestionRunResult> {
    const startedAt = new Date();
    console.log(`[arxiv-ingestion] Polling category: ${category}`);

    const result: IngestionRunResult = {
      category,
      papersFound: 0,
      papersPassed: 0,
      papersFailed: 0,
    };

    // 1. Fetch RSS feed
    let feedXml: string;
    try {
      const feedUrl = `https://export.arxiv.org/rss/${encodeURIComponent(category)}`;
      const response = await fetch(feedUrl, {
        headers: { "User-Agent": "NookplotGateway/0.1.0" },
      });
      if (!response.ok) {
        console.log(`[arxiv-ingestion] Failed to fetch RSS for ${category}: HTTP ${response.status}`);
        await this.recordIngestionRun(category, result, startedAt);
        return result;
      }
      feedXml = await response.text();
    } catch (err) {
      console.log(`[arxiv-ingestion] Network error fetching RSS for ${category}: ${err instanceof Error ? err.message : String(err)}`);
      await this.recordIngestionRun(category, result, startedAt);
      return result;
    }

    // 2. Parse items from RSS XML
    const items = this.parseRssItems(feedXml);
    result.papersFound = items.length;
    console.log(`[arxiv-ingestion] Found ${items.length} items in ${category}`);

    // 3. Process each paper
    for (const item of items) {
      try {
        const ingested = await this.processItem(item);
        if (ingested) {
          result.papersPassed++;
        }
      } catch (err) {
        result.papersFailed++;
        console.log(`[arxiv-ingestion] Failed to process paper ${item.arxivId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. Record the ingestion run
    await this.recordIngestionRun(category, result, startedAt);

    console.log(
      `[arxiv-ingestion] Category ${category} complete: ${result.papersPassed} passed, ${result.papersFailed} failed out of ${result.papersFound} found`,
    );

    return result;
  }

  /**
   * Resolve pending citations that target a given external ID.
   *
   * When a newly ingested paper was previously referenced by an already-
   * ingested paper, this method links the pending citation to the new
   * paper's content CID.
   */
  async resolvePendingCitations(externalId: string, contentCid: string): Promise<ResolvedCitation[]> {
    const { rows } = await this.pool.query<{ source_cid: string }>(
      `SELECT source_cid FROM pending_citations
       WHERE target_external_id = $1 AND resolved_cid IS NULL`,
      [externalId],
    );

    if (rows.length === 0) return [];

    const resolved: ResolvedCitation[] = [];

    for (const row of rows) {
      await this.pool.query(
        `UPDATE pending_citations
         SET resolved_cid = $1, resolved_at = NOW()
         WHERE target_external_id = $2 AND source_cid = $3 AND resolved_cid IS NULL`,
        [contentCid, externalId, row.source_cid],
      );
      resolved.push({ sourceCid: row.source_cid, resolvedCid: contentCid });
    }

    if (resolved.length > 0) {
      console.log(`[arxiv-ingestion] Resolved ${resolved.length} pending citations for ${externalId}`);
    }

    return resolved;
  }

  /**
   * Ingest a single historical paper by arXiv ID, DOI, or Semantic Scholar ID.
   *
   * Uses the same enrichment/scoring/storage pipeline as `pollCategory` but
   * operates on a single paper fetched directly from Semantic Scholar.
   *
   * @returns true if ingested, false if rejected or already exists
   */
  async ingestHistoricalPaper(id: string): Promise<boolean> {
    console.log(`[arxiv-ingestion] Ingesting historical paper: ${id}`);

    // Check if already exists (try arXiv ID, DOI, and S2 ID)
    const { rows: existing } = await this.pool.query(
      `SELECT arxiv_id FROM arxiv_content_map
       WHERE arxiv_id = $1 OR doi = $1 OR semantic_scholar_id = $1
       LIMIT 1`,
      [id],
    );

    if (existing.length > 0) {
      console.log(`[arxiv-ingestion] Paper ${id} already exists, skipping`);
      return false;
    }

    // Fetch from Semantic Scholar
    const s2Paper = await this.s2Client.getPaper(id);
    if (!s2Paper) {
      console.log(`[arxiv-ingestion] Paper ${id} not found on Semantic Scholar`);
      return false;
    }

    // Get Grokipedia score
    const authorNames = s2Paper.authors.map((a) => a.name);
    const influence = await this.grokipediaClient.getInfluenceScore(s2Paper.title, authorNames);

    // Run quality scorer
    const qualityResult = this.qualityScorer.scorePaper(s2Paper, influence.score);
    const decision = this.qualityScorer.meetsThreshold(qualityResult.total);

    if (decision === "reject") {
      console.log(`[arxiv-ingestion] Paper ${id} rejected (score: ${qualityResult.total})`);
      return false;
    }

    // Generate placeholder content CID
    const contentCid = crypto.randomUUID();

    // Extract identifiers
    const arxivId = s2Paper.externalIds?.ArXiv ?? null;
    const doi = s2Paper.externalIds?.DOI ?? null;
    const s2Id = s2Paper.paperId;

    // Store in arxiv_content_map
    await this.pool.query(
      `INSERT INTO arxiv_content_map (
        arxiv_id, doi, semantic_scholar_id, content_cid, title, authors,
        categories, published_date, quality_score, quality_breakdown,
        citation_count, grokipedia_score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (arxiv_id) DO NOTHING`,
      [
        arxivId,
        doi,
        s2Id,
        contentCid,
        s2Paper.title,
        JSON.stringify(s2Paper.authors.map((a) => ({ name: a.name, authorId: a.authorId }))),
        JSON.stringify([]),
        s2Paper.year ? new Date(`${s2Paper.year}-01-01`) : null,
        qualityResult.total,
        JSON.stringify(qualityResult.breakdown),
        s2Paper.citationCount ?? 0,
        influence.score,
      ],
    );

    // Create unclaimed credits for authors
    await this.createUnclaimedCreditsForAuthors(s2Paper, contentCid);

    // Store pending citations for references
    await this.storePendingCitations(s2Paper, contentCid);

    // Resolve any pending citations pointing at this paper
    if (arxivId) {
      await this.resolvePendingCitations(arxivId, contentCid);
    }
    if (doi) {
      await this.resolvePendingCitations(doi, contentCid);
    }
    await this.resolvePendingCitations(s2Id, contentCid);

    console.log(`[arxiv-ingestion] Historical paper ${id} ingested (score: ${qualityResult.total}, decision: ${decision})`);
    return true;
  }

  /**
   * Poll all configured arXiv categories sequentially.
   *
   * Categories are read from the `ARXIV_CATEGORIES` env var (comma-separated).
   * Defaults to `cs.AI,cs.LG,cs.MA,cs.CL` if not set.
   */
  async pollAllCategories(): Promise<void> {
    const categoriesEnv = process.env.ARXIV_CATEGORIES || "cs.AI,cs.LG,cs.MA,cs.CL";
    const categories = categoriesEnv.split(",").map((c) => c.trim()).filter(Boolean);

    console.log(`[arxiv-ingestion] Starting poll for ${categories.length} categories: ${categories.join(", ")}`);

    for (const category of categories) {
      try {
        const result = await this.pollCategory(category);
        console.log(`[arxiv-ingestion] ${category}: ${result.papersPassed}/${result.papersFound} ingested`);
      } catch (err) {
        console.log(`[arxiv-ingestion] Error polling category ${category}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log("[arxiv-ingestion] Poll complete for all categories");
  }

  /**
   * Get aggregate ingestion statistics.
   *
   * Returns total paper count, unresolved pending citation count, and
   * the 20 most recent ingestion runs.
   */
  async getIngestionStats(): Promise<IngestionStats> {
    const [totalResult, pendingResult, runsResult] = await Promise.all([
      this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM arxiv_content_map`),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pending_citations WHERE resolved_cid IS NULL`,
      ),
      this.pool.query<{
        category: string;
        papers_found: number;
        papers_passed: number;
        started_at: Date;
      }>(
        `SELECT category, papers_found, papers_passed, started_at
         FROM ingestion_runs
         ORDER BY started_at DESC
         LIMIT 20`,
      ),
    ]);

    return {
      totalPapers: parseInt(totalResult.rows[0]?.count ?? "0", 10),
      pendingCitations: parseInt(pendingResult.rows[0]?.count ?? "0", 10),
      recentRuns: runsResult.rows.map((r) => ({
        category: r.category,
        papersFound: r.papers_found,
        papersPassed: r.papers_passed,
        startedAt: r.started_at,
      })),
    };
  }

  // ------------------------------------------------------------------
  //  Private Helpers
  // ------------------------------------------------------------------

  /**
   * Parse `<item>` blocks from an arXiv RSS/Atom XML feed.
   *
   * Uses regex — no xml2js dependency. Extracts title, link, arXiv ID,
   * and description from each item.
   */
  private parseRssItems(xml: string): RssItem[] {
    const items: RssItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];

      const title = this.extractTag(block, "title");
      const link = this.extractTag(block, "link");
      const description = this.extractTag(block, "description");

      if (!title || !link) continue;

      // Extract arXiv ID from link.
      // Links look like: http://arxiv.org/abs/2301.12345 or https://arxiv.org/abs/2301.12345v2
      const idMatch = link.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
      if (!idMatch) continue;

      const arxivId = idMatch[1].replace(/v\d+$/, ""); // Strip version suffix

      items.push({
        title: this.cleanHtml(title),
        link,
        arxivId,
        description: description ? this.cleanHtml(description) : "",
      });
    }

    return items;
  }

  /**
   * Extract the text content of an XML tag from a block of XML.
   */
  private extractTag(xml: string, tagName: string): string | null {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * Strip HTML tags and decode common HTML entities.
   */
  private cleanHtml(text: string): string {
    return text
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .trim();
  }

  /**
   * Process a single RSS item through the enrichment/scoring/storage pipeline.
   *
   * @returns true if the paper was ingested, false if skipped (duplicate or rejected)
   */
  private async processItem(item: RssItem): Promise<boolean> {
    // Check if already ingested
    const { rows: existing } = await this.pool.query(
      `SELECT arxiv_id FROM arxiv_content_map WHERE arxiv_id = $1 LIMIT 1`,
      [item.arxivId],
    );

    if (existing.length > 0) {
      return false; // Already ingested
    }

    // Fetch Semantic Scholar enrichment
    const s2Paper = await this.s2Client.getPaper(item.arxivId);
    if (!s2Paper) {
      console.log(`[arxiv-ingestion] S2 lookup returned null for ${item.arxivId}, skipping`);
      return false;
    }

    // Get Grokipedia score
    const authorNames = s2Paper.authors.map((a) => a.name);
    const influence = await this.grokipediaClient.getInfluenceScore(s2Paper.title, authorNames);

    // Run quality scorer
    const qualityResult = this.qualityScorer.scorePaper(s2Paper, influence.score);
    const decision = this.qualityScorer.meetsThreshold(qualityResult.total);

    if (decision === "reject") {
      return false;
    }

    // Generate placeholder content CID
    const contentCid = crypto.randomUUID();

    // Extract identifiers
    const arxivId = s2Paper.externalIds?.ArXiv ?? item.arxivId;
    const doi = s2Paper.externalIds?.DOI ?? null;
    const s2Id = s2Paper.paperId;
    const categories = JSON.stringify([item.link.includes("/") ? item.link : ""]);

    // Store in arxiv_content_map
    await this.pool.query(
      `INSERT INTO arxiv_content_map (
        arxiv_id, doi, semantic_scholar_id, content_cid, title, authors,
        categories, published_date, quality_score, quality_breakdown,
        citation_count, grokipedia_score
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (arxiv_id) DO NOTHING`,
      [
        arxivId,
        doi,
        s2Id,
        contentCid,
        s2Paper.title,
        JSON.stringify(s2Paper.authors.map((a) => ({ name: a.name, authorId: a.authorId }))),
        categories,
        s2Paper.year ? new Date(`${s2Paper.year}-01-01`) : null,
        qualityResult.total,
        JSON.stringify(qualityResult.breakdown),
        s2Paper.citationCount ?? 0,
        influence.score,
      ],
    );

    // Create unclaimed credits for authors
    await this.createUnclaimedCreditsForAuthors(s2Paper, contentCid);

    // Store pending citations for references
    await this.storePendingCitations(s2Paper, contentCid);

    // Resolve any pending citations pointing at this paper
    await this.resolvePendingCitations(arxivId, contentCid);
    if (doi) {
      await this.resolvePendingCitations(doi, contentCid);
    }
    await this.resolvePendingCitations(s2Id, contentCid);

    return true;
  }

  /**
   * Create unclaimed credit entries for each author of a paper.
   *
   * Uses the Semantic Scholar author ID as the external identifier
   * on the 'arxiv' platform, with attribution type 'paper_author'.
   */
  private async createUnclaimedCreditsForAuthors(paper: S2Paper, contentCid: string): Promise<void> {
    for (const author of paper.authors) {
      if (!author.authorId) continue;

      try {
        await this.pool.query(
          `INSERT INTO unclaimed_credits (
            platform, external_id, attribution_type, content_cid, display_name, amount
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING`,
          [
            "arxiv",
            author.authorId,
            "paper_author",
            contentCid,
            author.name,
            100, // Default credit amount for paper authorship
          ],
        );
      } catch (err) {
        console.log(
          `[arxiv-ingestion] Failed to create unclaimed credits for author ${author.name} (${author.authorId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Store pending citation entries for each reference in the paper.
   *
   * If a referenced paper is already in `arxiv_content_map`, the citation
   * is stored as already resolved. Otherwise, it is stored as pending so
   * it can be resolved when the target paper is eventually ingested.
   */
  private async storePendingCitations(paper: S2Paper, sourceCid: string): Promise<void> {
    if (!paper.references || paper.references.length === 0) return;

    for (const ref of paper.references) {
      if (!ref.paperId) continue;

      try {
        // Check if the referenced paper already exists
        const { rows: targetRows } = await this.pool.query<{ content_cid: string }>(
          `SELECT content_cid FROM arxiv_content_map
           WHERE semantic_scholar_id = $1
           LIMIT 1`,
          [ref.paperId],
        );

        const resolvedCid = targetRows.length > 0 ? targetRows[0].content_cid : null;

        await this.pool.query(
          `INSERT INTO pending_citations (
            source_cid, target_external_id, resolved_cid, resolved_at
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING`,
          [
            sourceCid,
            ref.paperId,
            resolvedCid,
            resolvedCid ? new Date() : null,
          ],
        );
      } catch (err) {
        console.log(
          `[arxiv-ingestion] Failed to store pending citation for ref ${ref.paperId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Record an ingestion run in the `ingestion_runs` table.
   */
  private async recordIngestionRun(
    category: string,
    result: IngestionRunResult,
    startedAt: Date,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO ingestion_runs (category, papers_found, papers_passed, papers_failed, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [category, result.papersFound, result.papersPassed, result.papersFailed, startedAt],
      );
    } catch (err) {
      console.log(`[arxiv-ingestion] Failed to record ingestion run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
