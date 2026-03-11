/**
 * Knowledge Query Service — hybrid semantic + keyword search across
 * all published knowledge, with credit-gated access and revenue
 * attribution to content creators.
 *
 * Query flow:
 * 1. Validate input
 * 2. Check credits
 * 3. Generate query embedding (or fall back to FTS-only)
 * 4. Semantic search (pgvector cosine similarity)
 * 5. FTS search (existing searchService)
 * 6. Merge + deduplicate + quality-weighted ranking
 * 7. Resolve creators
 * 8. Deduct credits + attribute revenue
 * 9. Log query + update topic map
 *
 * @module services/knowledgeQueryService
 */

import type pg from "pg";
import type { EmbeddingService } from "./embeddingService.js";
import type { SearchService, SearchResultType } from "./searchService.js";
import type { CreditManager } from "./creditManager.js";

// ---- Types ----

export interface KnowledgeQueryInput {
  query: string;
  types?: string[];
  limit?: number;
  minQuality?: number;
}

export interface KnowledgeQueryResultItem {
  contentType: string;
  contentId: string;
  title: string;
  snippet: string;
  compositeScore: number;
  semanticScore: number;
  ftsScore: number;
  qualityScore: number;
  citationCount: number;
  creatorAddress: string | null;
  creatorAgentId: string | null;
  creatorName: string | null;
  createdAt: string;
}

export interface KnowledgeQueryResponse {
  results: KnowledgeQueryResultItem[];
  query: string;
  totalResults: number;
  costCredits: number;
  durationMs: number;
  mode: "hybrid" | "fts_only";
}

export interface KnowledgeQueryServiceConfig {
  costCredits: number;          // stored units (50 = 0.50 display)
  revenueShareCredits: number;  // stored units (25 = 0.25 display)
  maxResults: number;
  rateLimitPerHour: number;
}

const ALLOWED_CONTENT_TYPES = new Set([
  "bundle", "paper", "project", "bounty", "task", "resource", "teaching",
]);

const TOP_N_ATTRIBUTION = 5;

// ---- Service ----

export class KnowledgeQueryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddingService: EmbeddingService | null,
    private readonly searchService: SearchService,
    private readonly creditManager: CreditManager,
    private readonly config: KnowledgeQueryServiceConfig,
  ) {}

  /**
   * Execute a semantic + keyword knowledge query.
   */
  async query(
    agentId: string,
    input: KnowledgeQueryInput,
  ): Promise<KnowledgeQueryResponse> {
    const startMs = Date.now();

    // 1. Validate
    const { query, types, limit: rawLimit, minQuality } = input;
    if (!query || query.length < 2 || query.length > 500) {
      throw new Error("VALIDATION: query must be 2-500 characters");
    }
    const limit = Math.min(Math.max(rawLimit ?? 10, 1), this.config.maxResults);
    const filteredTypes = types?.filter((t) => ALLOWED_CONTENT_TYPES.has(t));
    const qualityGate = minQuality ?? 0;

    // 2. Anti-abuse checks
    await this.checkAntiAbuse(agentId);

    // 3. Check rate limit
    await this.checkRateLimit(agentId);

    // 4. Check credits
    const account = await this.creditManager.getBalance(agentId);
    if (!account || account.balance < this.config.costCredits) {
      throw new Error("INSUFFICIENT_CREDITS");
    }

    // 5. Generate query embedding (graceful degradation to FTS-only)
    let queryEmbedding: number[] | null = null;
    let mode: "hybrid" | "fts_only" = "fts_only";
    if (this.embeddingService && await this.embeddingService.hasPgvector()) {
      try {
        queryEmbedding = await this.embeddingService.embed(query);
        mode = "hybrid";
      } catch (err) {
        console.error("[knowledge-query] Embedding failed, falling back to FTS:", err instanceof Error ? err.message : err);
      }
    }

    // 6. Parallel: semantic search + FTS search
    const [semanticResults, ftsResults] = await Promise.all([
      queryEmbedding ? this.semanticSearch(queryEmbedding, filteredTypes, limit * 2) : Promise.resolve([]),
      this.ftsSearch(query, filteredTypes, limit * 2),
    ]);

    // 7. Merge + deduplicate
    const merged = this.mergeResults(semanticResults, ftsResults, qualityGate);

    // 8. Quality-weighted ranking
    const ranked = this.rankResults(merged, limit);

    // 9. Resolve creators
    const resolved = await this.resolveCreators(ranked);

    // 10. Generate query ID for transaction reference
    const queryId = crypto.randomUUID();

    // 11. Deduct credits
    await this.creditManager.deductCredits(agentId, this.config.costCredits, queryId, "knowledge_query");

    // 12. Revenue attribution (top 5 results, skip self-dealing)
    await this.distributeRevenue(agentId, queryId, resolved);

    // 13. Log query (fire-and-forget)
    const durationMs = Date.now() - startMs;
    const queryVectorStr = queryEmbedding ? `[${queryEmbedding.join(",")}]` : null;
    this.logQuery(agentId, queryId, query, queryVectorStr, resolved.length, this.config.costCredits, durationMs, { types: filteredTypes }).catch(() => {});

    // 14. Update topic map (fire-and-forget)
    this.updateTopicMap(agentId, query).catch(() => {});

    return {
      results: resolved,
      query,
      totalResults: resolved.length,
      costCredits: this.config.costCredits / 100,
      durationMs,
      mode,
    };
  }

  // ---- Anti-abuse ----

  private async checkAntiAbuse(agentId: string): Promise<void> {
    // Check account age (>= 1 day)
    const { rows: ageRows } = await this.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM agents WHERE id = $1`,
      [agentId],
    );
    if (ageRows.length > 0) {
      const ageDays = (Date.now() - ageRows[0].created_at.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 1) {
        throw new Error("ACCOUNT_TOO_NEW");
      }
    }
  }

  private async checkRateLimit(agentId: string): Promise<void> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM knowledge_queries
       WHERE querying_agent_id = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [agentId],
    );
    const count = parseInt(rows[0]?.count ?? "0", 10);
    if (count >= this.config.rateLimitPerHour) {
      throw new Error("RATE_LIMIT_EXCEEDED");
    }
  }

  // ---- Semantic search ----

  private async semanticSearch(
    queryEmbedding: number[],
    types: string[] | undefined,
    limit: number,
  ): Promise<MergeableResult[]> {
    const vectorStr = `[${queryEmbedding.join(",")}]`;
    const typeFilter = types && types.length > 0
      ? `AND content_type = ANY($3)`
      : "";
    const params: unknown[] = [vectorStr, limit];
    if (types && types.length > 0) params.push(types);

    const { rows } = await this.pool.query<{
      content_type: string;
      content_id: string;
      content_text: string;
      similarity: string;
    }>(
      `SELECT content_type, content_id, content_text,
              1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_embeddings
       WHERE 1 - (embedding <=> $1::vector) > 0.15
         ${typeFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      params,
    );

    return rows.map((r) => ({
      contentType: r.content_type,
      contentId: r.content_id,
      title: "",
      snippet: r.content_text.slice(0, 200),
      semanticScore: parseFloat(r.similarity),
      ftsScore: 0,
      qualityScore: 0,
      citationCount: 0,
      createdAt: "",
    }));
  }

  // ---- FTS search ----

  private async ftsSearch(
    query: string,
    types: string[] | undefined,
    limit: number,
  ): Promise<MergeableResult[]> {
    // Map our content types to SearchService types
    const searchTypes: SearchResultType[] | undefined = types?.filter(
      (t): t is SearchResultType => ["project", "task", "bounty", "paper", "bundle", "teaching"].includes(t),
    );

    const ftsResponse = await this.searchService.search(query, searchTypes, limit, 0);

    return ftsResponse.results.map((r) => ({
      contentType: r.type,
      contentId: r.id,
      title: r.title,
      snippet: r.snippet,
      semanticScore: 0,
      ftsScore: r.relevance,
      qualityScore: 0,
      citationCount: 0,
      createdAt: r.createdAt,
    }));
  }

  // ---- Merge + Rank ----

  private mergeResults(
    semantic: MergeableResult[],
    fts: MergeableResult[],
    qualityGate: number,
  ): MergeableResult[] {
    const map = new Map<string, MergeableResult>();

    for (const item of semantic) {
      const key = `${item.contentType}:${item.contentId}`;
      map.set(key, item);
    }

    for (const item of fts) {
      const key = `${item.contentType}:${item.contentId}`;
      const existing = map.get(key);
      if (existing) {
        // Found in both — combine scores, keep best title/snippet
        existing.ftsScore = item.ftsScore;
        if (item.title && !existing.title) existing.title = item.title;
        if (item.snippet && existing.snippet.length < item.snippet.length) existing.snippet = item.snippet;
        if (item.createdAt && !existing.createdAt) existing.createdAt = item.createdAt;
      } else {
        map.set(key, item);
      }
    }

    const results = [...map.values()];

    // Apply quality gate if specified
    if (qualityGate > 0) {
      return results.filter((r) => r.qualityScore >= qualityGate || r.semanticScore > 0.5);
    }

    return results;
  }

  private rankResults(results: MergeableResult[], limit: number): MergeableResult[] {
    // Normalize FTS scores to 0-1 range
    const maxFts = Math.max(...results.map((r) => r.ftsScore), 0.001);
    const maxCitations = Math.max(...results.map((r) => r.citationCount), 1);

    for (const r of results) {
      const normFts = r.ftsScore / maxFts;
      const normQuality = r.qualityScore / 100;
      const normCitations = Math.log(1 + r.citationCount) / Math.log(1 + maxCitations);

      r.compositeScore =
        0.55 * r.semanticScore +
        0.20 * normFts +
        0.15 * normQuality +
        0.10 * normCitations;
    }

    return results
      .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))
      .slice(0, limit);
  }

  // ---- Creator resolution ----

  private async resolveCreators(
    results: MergeableResult[],
  ): Promise<KnowledgeQueryResultItem[]> {
    if (results.length === 0) return [];

    // Batch-resolve creators by content type
    const resolved: KnowledgeQueryResultItem[] = [];

    for (const r of results) {
      const creator = await this.resolveCreator(r.contentType, r.contentId);

      // Try to enrich title from source tables if missing
      let title = r.title;
      if (!title) {
        title = await this.resolveTitle(r.contentType, r.contentId);
      }

      resolved.push({
        contentType: r.contentType,
        contentId: r.contentId,
        title: title || `${r.contentType} ${r.contentId}`,
        snippet: r.snippet,
        compositeScore: r.compositeScore ?? 0,
        semanticScore: r.semanticScore,
        ftsScore: r.ftsScore,
        qualityScore: r.qualityScore,
        citationCount: r.citationCount,
        creatorAddress: creator.address,
        creatorAgentId: creator.agentId,
        creatorName: creator.name,
        createdAt: r.createdAt,
      });
    }

    return resolved;
  }

  private async resolveCreator(
    contentType: string,
    contentId: string,
  ): Promise<{ address: string | null; agentId: string | null; name: string | null }> {
    try {
      switch (contentType) {
        case "bundle": {
          const { rows } = await this.pool.query<{ creator_id: string }>(
            `SELECT creator_id FROM idx_knowledge_bundles WHERE bundle_id = $1`,
            [contentId],
          );
          if (rows.length > 0 && rows[0].creator_id) {
            const agent = await this.resolveAgent(rows[0].creator_id);
            return { address: rows[0].creator_id, ...agent };
          }
          break;
        }
        case "project": {
          const { rows } = await this.pool.query<{ agent_id: string; address: string; display_name: string | null }>(
            `SELECT a.id AS agent_id, a.address, a.display_name
             FROM projects p JOIN agents a ON a.id = p.agent_id
             WHERE p.project_id = $1`,
            [contentId],
          );
          if (rows.length > 0) {
            return { address: rows[0].address, agentId: rows[0].agent_id, name: rows[0].display_name };
          }
          break;
        }
        case "paper": {
          // Papers don't have a single agent creator — skip attribution
          return { address: null, agentId: null, name: null };
        }
        case "bounty":
        case "task": {
          const table = contentType === "bounty" ? "project_bounties" : "project_tasks";
          const { rows } = await this.pool.query<{ agent_id: string; address: string; display_name: string | null }>(
            `SELECT a.id AS agent_id, a.address, a.display_name
             FROM ${table} t JOIN projects p ON p.id = t.project_id JOIN agents a ON a.id = p.agent_id
             WHERE t.id = $1`,
            [contentId],
          );
          if (rows.length > 0) {
            return { address: rows[0].address, agentId: rows[0].agent_id, name: rows[0].display_name };
          }
          break;
        }
        case "teaching": {
          const { rows } = await this.pool.query<{ agent_id: string; address: string; display_name: string | null }>(
            `SELECT a.id AS agent_id, a.address, a.display_name
             FROM teaching_exchanges te JOIN agents a ON a.id = te.teacher_id
             WHERE te.id = $1`,
            [contentId],
          );
          if (rows.length > 0) {
            return { address: rows[0].address, agentId: rows[0].agent_id, name: rows[0].display_name };
          }
          break;
        }
        case "resource": {
          const { rows } = await this.pool.query<{ agent_id: string; address: string; display_name: string | null }>(
            `SELECT a.id AS agent_id, a.address, a.display_name
             FROM knowledge_resources kr JOIN agents a ON a.id = kr.agent_id
             WHERE kr.id = $1`,
            [contentId],
          );
          if (rows.length > 0) {
            return { address: rows[0].address, agentId: rows[0].agent_id, name: rows[0].display_name };
          }
          break;
        }
      }
    } catch {
      // Graceful degradation — skip creator resolution
    }
    return { address: null, agentId: null, name: null };
  }

  private async resolveAgent(address: string): Promise<{ agentId: string | null; name: string | null }> {
    const { rows } = await this.pool.query<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM agents WHERE LOWER(address) = LOWER($1)`,
      [address],
    );
    if (rows.length > 0) {
      return { agentId: rows[0].id, name: rows[0].display_name };
    }
    return { agentId: null, name: null };
  }

  private async resolveTitle(contentType: string, contentId: string): Promise<string> {
    try {
      switch (contentType) {
        case "bundle": {
          const { rows } = await this.pool.query<{ name: string }>(
            `SELECT name FROM idx_knowledge_bundles WHERE bundle_id = $1`,
            [contentId],
          );
          return rows[0]?.name || "";
        }
        case "project": {
          const { rows } = await this.pool.query<{ name: string }>(
            `SELECT name FROM projects WHERE project_id = $1`,
            [contentId],
          );
          return rows[0]?.name || "";
        }
        case "paper": {
          const { rows } = await this.pool.query<{ title: string }>(
            `SELECT title FROM arxiv_content_map WHERE arxiv_id = $1 OR id::text = $1`,
            [contentId],
          );
          return rows[0]?.title || "";
        }
        case "bounty": {
          const { rows } = await this.pool.query<{ title: string }>(
            `SELECT title FROM project_bounties WHERE id = $1`,
            [contentId],
          );
          return rows[0]?.title || "";
        }
        case "task": {
          const { rows } = await this.pool.query<{ title: string }>(
            `SELECT title FROM project_tasks WHERE id = $1`,
            [contentId],
          );
          return rows[0]?.title || "";
        }
        case "teaching": {
          const { rows } = await this.pool.query<{ goal: string }>(
            `SELECT goal FROM teaching_exchanges WHERE id = $1`,
            [contentId],
          );
          return rows[0]?.goal || "";
        }
        case "resource": {
          const { rows } = await this.pool.query<{ title: string }>(
            `SELECT title FROM knowledge_resources WHERE id = $1`,
            [contentId],
          );
          return rows[0]?.title || "";
        }
      }
    } catch {
      // Graceful
    }
    return "";
  }

  // ---- Revenue attribution ----

  private async distributeRevenue(
    queryingAgentId: string,
    queryId: string,
    results: KnowledgeQueryResultItem[],
  ): Promise<void> {
    if (this.config.revenueShareCredits <= 0) return;

    // Top N results earn revenue
    const eligible = results
      .slice(0, TOP_N_ATTRIBUTION)
      .filter((r) => {
        // Skip self-dealing: querier === creator
        if (r.creatorAgentId === queryingAgentId) return false;
        // Skip items without a creator agent
        if (!r.creatorAgentId) return false;
        return true;
      });

    if (eligible.length === 0) return;

    // Distribute proportional to composite score
    const totalScore = eligible.reduce((sum, r) => sum + r.compositeScore, 0);
    if (totalScore <= 0) return;

    for (let i = 0; i < eligible.length; i++) {
      const item = eligible[i];
      const share = Math.floor(this.config.revenueShareCredits * (item.compositeScore / totalScore));
      if (share <= 0) continue;

      try {
        // Credit the creator
        await this.creditManager.addCredits(
          item.creatorAgentId!,
          share,
          "knowledge_query_revenue",
          queryId,
        );

        // Log attribution
        await this.pool.query(
          `INSERT INTO knowledge_query_attributions
            (query_id, content_type, content_id, creator_address, creator_agent_id, rank_position, similarity_score, credits_earned)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [queryId, item.contentType, item.contentId, item.creatorAddress, item.creatorAgentId, i + 1, item.compositeScore, share],
        );
      } catch (err) {
        console.error(`[knowledge-query] Revenue attribution failed for ${item.contentType}/${item.contentId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // ---- Query logging ----

  private async logQuery(
    agentId: string,
    queryId: string,
    queryText: string,
    queryVector: string | null,
    resultCount: number,
    costCredits: number,
    durationMs: number,
    filters: Record<string, unknown>,
  ): Promise<void> {
    // If queryVector is available AND pgvector is installed, store the embedding.
    // Otherwise, insert without the query_embedding column (it may not exist).
    const hasPgvector = this.embeddingService ? await this.embeddingService.hasPgvector() : false;
    if (queryVector && hasPgvector) {
      await this.pool.query(
        `INSERT INTO knowledge_queries (id, querying_agent_id, query_text, query_embedding, result_count, cost_credits, duration_ms, filters)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8)`,
        [queryId, agentId, queryText, queryVector, resultCount, costCredits, durationMs, JSON.stringify(filters)],
      );
    } else {
      await this.pool.query(
        `INSERT INTO knowledge_queries (id, querying_agent_id, query_text, result_count, cost_credits, duration_ms, filters)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [queryId, agentId, queryText, resultCount, costCredits, durationMs, JSON.stringify(filters)],
      );
    }
  }

  // ---- Topic map ----

  private async updateTopicMap(agentId: string, query: string): Promise<void> {
    // Extract key terms (simple approach: 2-3 word phrases from query)
    const words = query.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return;

    // Use the full query as the topic key (normalized)
    const topicKey = words.slice(0, 5).join(" ");
    await this.pool.query(
      `INSERT INTO agent_query_topics (agent_id, topic_keywords, query_count, last_queried_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (agent_id, topic_keywords) DO UPDATE
         SET query_count = agent_query_topics.query_count + 1,
             last_queried_at = NOW()`,
      [agentId, topicKey],
    );
  }

  // ---- Read-only methods ----

  /**
   * Get paginated query history for an agent.
   */
  async getQueryHistory(
    agentId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ queries: QueryHistoryItem[]; total: number }> {
    const [dataResult, countResult] = await Promise.all([
      this.pool.query<{
        id: string; query_text: string; result_count: number;
        cost_credits: string; duration_ms: number; filters: unknown; created_at: Date;
      }>(
        `SELECT id, query_text, result_count, cost_credits::text, duration_ms, filters, created_at
         FROM knowledge_queries
         WHERE querying_agent_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [agentId, limit, offset],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM knowledge_queries WHERE querying_agent_id = $1`,
        [agentId],
      ),
    ]);

    return {
      queries: dataResult.rows.map((r) => ({
        id: r.id,
        queryText: r.query_text,
        resultCount: r.result_count,
        costCredits: Number(r.cost_credits) / 100,
        durationMs: r.duration_ms,
        filters: r.filters,
        createdAt: r.created_at.toISOString(),
      })),
      total: parseInt(countResult.rows[0]?.count ?? "0", 10),
    };
  }

  /**
   * Get attribution earnings for a creator address.
   */
  async getEarnings(
    agentId: string,
    days = 30,
  ): Promise<{ totalEarned: number; attributionCount: number; topContent: EarningsByContent[] }> {
    const [totalResult, topResult] = await Promise.all([
      this.pool.query<{ total: string; count: string }>(
        `SELECT COALESCE(SUM(credits_earned), 0)::text AS total, COUNT(*)::text AS count
         FROM knowledge_query_attributions
         WHERE creator_agent_id = $1
           AND created_at > NOW() - ($2 || ' days')::INTERVAL`,
        [agentId, days],
      ),
      this.pool.query<{ content_type: string; content_id: string; total_earned: string; query_count: string }>(
        `SELECT content_type, content_id,
                SUM(credits_earned)::text AS total_earned,
                COUNT(*)::text AS query_count
         FROM knowledge_query_attributions
         WHERE creator_agent_id = $1
           AND created_at > NOW() - ($2 || ' days')::INTERVAL
         GROUP BY content_type, content_id
         ORDER BY SUM(credits_earned) DESC
         LIMIT 10`,
        [agentId, days],
      ),
    ]);

    return {
      totalEarned: Number(totalResult.rows[0]?.total ?? "0") / 100,
      attributionCount: parseInt(totalResult.rows[0]?.count ?? "0", 10),
      topContent: topResult.rows.map((r) => ({
        contentType: r.content_type,
        contentId: r.content_id,
        totalEarned: Number(r.total_earned) / 100,
        queryCount: parseInt(r.query_count, 10),
      })),
    };
  }

  /**
   * Get topic map for an agent (their inferred query interests).
   */
  async getTopicMap(
    agentId: string,
  ): Promise<TopicMapItem[]> {
    const { rows } = await this.pool.query<{
      topic_keywords: string; query_count: number; last_queried_at: Date;
    }>(
      `SELECT topic_keywords, query_count, last_queried_at
       FROM agent_query_topics
       WHERE agent_id = $1
       ORDER BY query_count DESC
       LIMIT 50`,
      [agentId],
    );

    return rows.map((r) => ({
      topic: r.topic_keywords,
      queryCount: r.query_count,
      lastQueried: r.last_queried_at.toISOString(),
    }));
  }

  /**
   * Get public stats (no auth needed).
   */
  async getStats(embeddingService: EmbeddingService | null): Promise<{
    embeddingCount: number;
    embeddingsByType: Record<string, number>;
    queriesToday: number;
    topTopics: string[];
  }> {
    const [embCount, embByType, queryCount, topTopics] = await Promise.all([
      embeddingService?.getEmbeddingCount() ?? Promise.resolve(0),
      embeddingService?.getEmbeddingCountsByType() ?? Promise.resolve({}),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM knowledge_queries WHERE created_at > NOW() - INTERVAL '24 hours'`,
      ),
      this.pool.query<{ topic_keywords: string }>(
        `SELECT topic_keywords FROM agent_query_topics
         ORDER BY query_count DESC
         LIMIT 10`,
      ),
    ]);

    return {
      embeddingCount: embCount,
      embeddingsByType: embByType,
      queriesToday: parseInt(queryCount.rows[0]?.count ?? "0", 10),
      topTopics: topTopics.rows.map((r) => r.topic_keywords),
    };
  }
}

// ---- Internal types ----

interface MergeableResult {
  contentType: string;
  contentId: string;
  title: string;
  snippet: string;
  semanticScore: number;
  ftsScore: number;
  qualityScore: number;
  citationCount: number;
  createdAt: string;
  compositeScore?: number;
}

interface QueryHistoryItem {
  id: string;
  queryText: string;
  resultCount: number;
  costCredits: number;
  durationMs: number;
  filters: unknown;
  createdAt: string;
}

interface EarningsByContent {
  contentType: string;
  contentId: string;
  totalEarned: number;
  queryCount: number;
}

interface TopicMapItem {
  topic: string;
  queryCount: number;
  lastQueried: string;
}
