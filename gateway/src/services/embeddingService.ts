/**
 * Embedding service — generates and stores vector embeddings for
 * semantic knowledge search using OpenAI text-embedding-3-small.
 *
 * Uses the openai npm package directly (embeddings are infrastructure
 * cost, not per-agent billed via InferenceProxy).
 *
 * @module services/embeddingService
 */

import OpenAI from "openai";
import type pg from "pg";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const MAX_BATCH = 100; // OpenAI limit per request
const MAX_INPUT_LENGTH = 8000; // chars — truncate longer texts

export interface EmbeddingServiceConfig {
  backfillIntervalMs: number;  // default 300_000 (5 min)
  backfillBatchSize: number;   // default 50
}

export class EmbeddingService {
  private openai: OpenAI;
  private backfillTimer: ReturnType<typeof setInterval> | null = null;
  private pgvectorAvailable: boolean | null = null; // null = not checked yet

  constructor(
    private readonly pool: pg.Pool,
    apiKey: string,
    private readonly config: EmbeddingServiceConfig = {
      backfillIntervalMs: 300_000,
      backfillBatchSize: 50,
    },
  ) {
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Check if pgvector extension is installed. Cached after first check.
   */
  async hasPgvector(): Promise<boolean> {
    if (this.pgvectorAvailable !== null) return this.pgvectorAvailable;
    try {
      const { rows } = await this.pool.query<{ ok: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`,
      );
      this.pgvectorAvailable = rows[0]?.ok ?? false;
    } catch {
      this.pgvectorAvailable = false;
    }
    return this.pgvectorAvailable;
  }

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<number[]> {
    const input = text.slice(0, MAX_INPUT_LENGTH);
    const response = await this.openai.embeddings.create({
      model: MODEL,
      input,
      dimensions: DIMENSIONS,
    });
    return response.data[0].embedding;
  }

  /**
   * Generate embeddings for a batch of texts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    // Process in chunks of MAX_BATCH
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH).map((t) => t.slice(0, MAX_INPUT_LENGTH));
      const response = await this.openai.embeddings.create({
        model: MODEL,
        input: chunk,
        dimensions: DIMENSIONS,
      });
      for (const item of response.data) {
        results.push(item.embedding);
      }
    }
    return results;
  }

  /**
   * Generate embedding for a text and upsert into knowledge_embeddings.
   */
  async embedAndStore(
    contentType: string,
    contentId: string,
    text: string,
  ): Promise<void> {
    if (!text || text.trim().length < 10) return;
    if (!(await this.hasPgvector())) return; // no vector column — skip silently
    try {
      const embedding = await this.embed(text);
      const vectorStr = `[${embedding.join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ($1, $2, $3, $4::vector, $5)
         ON CONFLICT (content_type, content_id) DO UPDATE
           SET content_text = EXCLUDED.content_text,
               embedding = EXCLUDED.embedding,
               model = EXCLUDED.model,
               created_at = NOW()`,
        [contentType, contentId, text.slice(0, MAX_INPUT_LENGTH), vectorStr, MODEL],
      );
    } catch (err) {
      console.error(`[embedding] Failed to embed ${contentType}/${contentId}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Run one batch of backfill — find content missing embeddings, generate them.
   * Returns the number of items embedded.
   */
  async runBackfillBatch(): Promise<number> {
    if (!(await this.hasPgvector())) return 0;
    let embedded = 0;

    // Priority order: bundles, papers, projects, bounties, tasks, teaching
    const sources = [
      this.backfillBundles.bind(this),
      this.backfillPapers.bind(this),
      this.backfillProjects.bind(this),
      this.backfillBounties.bind(this),
      this.backfillTasks.bind(this),
      this.backfillTeaching.bind(this),
      this.backfillResources.bind(this),
      this.backfillIntents.bind(this),
      this.backfillAgentProfiles.bind(this),
    ];

    const remaining = this.config.backfillBatchSize;
    for (const source of sources) {
      if (embedded >= remaining) break;
      const count = await source(remaining - embedded);
      embedded += count;
    }

    return embedded;
  }

  // ---- Backfill helpers ----

  private async backfillBundles(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ bundle_id: string; name: string; summary: string | null }>(
      `SELECT b.bundle_id::text, b.name, b.summary
       FROM idx_knowledge_bundles b
       WHERE b.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_embeddings ke
           WHERE ke.content_type = 'bundle' AND ke.content_id = b.bundle_id::text
         )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => `${r.name || ""} ${r.summary || ""}`.trim());
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('bundle', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [rows[i].bundle_id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  private async backfillPapers(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; arxiv_id: string | null; title: string }>(
      `SELECT a.id::text, a.arxiv_id, a.title
       FROM arxiv_content_map a
       WHERE NOT EXISTS (
         SELECT 1 FROM knowledge_embeddings ke
         WHERE ke.content_type = 'paper' AND ke.content_id = COALESCE(a.arxiv_id, a.id::text)
       )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => r.title);
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const contentId = rows[i].arxiv_id || rows[i].id;
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('paper', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [contentId, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  private async backfillProjects(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ project_id: string; name: string; description: string | null }>(
      `SELECT p.project_id, p.name, p.description
       FROM projects p
       WHERE p.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_embeddings ke
           WHERE ke.content_type = 'project' AND ke.content_id = p.project_id
         )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => `${r.name} ${r.description || ""}`.trim());
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('project', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [rows[i].project_id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  private async backfillBounties(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; title: string; description: string | null }>(
      `SELECT b.id, b.title, b.description
       FROM project_bounties b
       WHERE NOT EXISTS (
         SELECT 1 FROM knowledge_embeddings ke
         WHERE ke.content_type = 'bounty' AND ke.content_id = b.id::text
       )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => `${r.title} ${r.description || ""}`.trim());
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('bounty', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [rows[i].id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  private async backfillTasks(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; title: string; description: string | null }>(
      `SELECT t.id, t.title, t.description
       FROM project_tasks t
       WHERE NOT EXISTS (
         SELECT 1 FROM knowledge_embeddings ke
         WHERE ke.content_type = 'task' AND ke.content_id = t.id::text
       )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => `${r.title} ${r.description || ""}`.trim());
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('task', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [rows[i].id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  private async backfillTeaching(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; goal: string }>(
      `SELECT te.id, te.goal
       FROM teaching_exchanges te
       WHERE te.status IN ('proposed', 'accepted', 'approved')
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_embeddings ke
           WHERE ke.content_type = 'teaching' AND ke.content_id = te.id::text
         )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => r.goal);
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('teaching', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [rows[i].id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  private async backfillResources(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; title: string; description: string | null }>(
      `SELECT kr.id, kr.title, kr.description
       FROM knowledge_resources kr
       WHERE kr.status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_embeddings ke
           WHERE ke.content_type = 'resource' AND ke.content_id = kr.id::text
         )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) => `${r.title} ${r.description || ""}`.trim());
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO knowledge_embeddings (content_type, content_id, content_text, embedding, model)
         VALUES ('resource', $1, $2, $3::vector, $4)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [rows[i].id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  // ---- Backfill lifecycle ----

  startBackfill(): void {
    if (this.backfillTimer) return;

    // Verify pgvector is available before starting backfill timer
    this.hasPgvector().then((ok) => {
      if (!ok) {
        console.log("[embedding] pgvector not available — backfill disabled (FTS-only mode)");
        return;
      }
      this._startBackfillTimer();
    }).catch(() => {
      console.log("[embedding] pgvector check failed — backfill disabled");
    });
  }

  private _startBackfillTimer(): void {
    if (this.backfillTimer) return;
    console.log(`[embedding] Backfill started (every ${this.config.backfillIntervalMs}ms, batch ${this.config.backfillBatchSize})`);
    this.backfillTimer = setInterval(async () => {
      try {
        const count = await this.runBackfillBatch();
        if (count > 0) {
          console.log(`[embedding] Backfilled ${count} embeddings`);
        }
      } catch (err) {
        console.error("[embedding] Backfill batch failed:", err instanceof Error ? err.message : err);
      }
    }, this.config.backfillIntervalMs);

    // Run initial backfill after a short delay
    setTimeout(() => {
      this.runBackfillBatch().then((count) => {
        if (count > 0) console.log(`[embedding] Initial backfill: ${count} embeddings`);
      }).catch((err) => {
        console.error("[embedding] Initial backfill failed:", err instanceof Error ? err.message : err);
      });
    }, 15_000);
  }

  stopBackfill(): void {
    if (this.backfillTimer) {
      clearInterval(this.backfillTimer);
      this.backfillTimer = null;
      console.log("[embedding] Backfill stopped");
    }
  }

  // ---- Intent + agent embedding methods ----

  /**
   * Embed an intent and upsert into intent_embeddings.
   */
  async embedIntent(intentId: string, text: string): Promise<void> {
    if (!text || text.trim().length < 10) return;
    if (!(await this.hasPgvector())) return;
    try {
      const embedding = await this.embed(text);
      const vectorStr = `[${embedding.join(",")}]`;
      await this.pool.query(
        `INSERT INTO intent_embeddings (intent_id, content_text, embedding, model)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (intent_id) DO UPDATE
           SET content_text = EXCLUDED.content_text,
               embedding = EXCLUDED.embedding,
               model = EXCLUDED.model,
               created_at = NOW()`,
        [intentId, text.slice(0, MAX_INPUT_LENGTH), vectorStr, MODEL],
      );
    } catch (err) {
      console.error(`[embedding] Failed to embed intent ${intentId}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Embed an agent profile and upsert into agent_embeddings.
   */
  async embedAgentProfile(agentId: string, text: string): Promise<void> {
    if (!text || text.trim().length < 10) return;
    if (!(await this.hasPgvector())) return;
    try {
      const embedding = await this.embed(text);
      const vectorStr = `[${embedding.join(",")}]`;
      await this.pool.query(
        `INSERT INTO agent_embeddings (agent_id, content_text, embedding, model)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (agent_id) DO UPDATE
           SET content_text = EXCLUDED.content_text,
               embedding = EXCLUDED.embedding,
               model = EXCLUDED.model,
               created_at = NOW()`,
        [agentId, text.slice(0, MAX_INPUT_LENGTH), vectorStr, MODEL],
      );
    } catch (err) {
      console.error(`[embedding] Failed to embed agent ${agentId}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Search intents by semantic similarity.
   */
  async searchIntentsSemantic(queryText: string, limit = 20): Promise<Array<{ intentId: string; contentText: string; similarity: number }>> {
    if (!(await this.hasPgvector())) return [];
    const embedding = await this.embed(queryText);
    const vectorStr = `[${embedding.join(",")}]`;
    const { rows } = await this.pool.query<{ intent_id: string; content_text: string; similarity: string }>(
      `SELECT ie.intent_id, ie.content_text,
              1 - (ie.embedding <=> $1::vector) AS similarity
       FROM intent_embeddings ie
       JOIN intents i ON i.id = ie.intent_id
       WHERE i.status = 'open'
       ORDER BY ie.embedding <=> $1::vector
       LIMIT $2`,
      [vectorStr, limit],
    );
    return rows.map((r) => ({
      intentId: r.intent_id,
      contentText: r.content_text,
      similarity: parseFloat(r.similarity),
    }));
  }

  /**
   * Search agents by semantic similarity.
   */
  async searchAgentsSemantic(queryText: string, limit = 20): Promise<Array<{ agentId: string; contentText: string; similarity: number }>> {
    if (!(await this.hasPgvector())) return [];
    const embedding = await this.embed(queryText);
    const vectorStr = `[${embedding.join(",")}]`;
    const { rows } = await this.pool.query<{ agent_id: string; content_text: string; similarity: string }>(
      `SELECT ae.agent_id, ae.content_text,
              1 - (ae.embedding <=> $1::vector) AS similarity
       FROM agent_embeddings ae
       ORDER BY ae.embedding <=> $1::vector
       LIMIT $2`,
      [vectorStr, limit],
    );
    return rows.map((r) => ({
      agentId: r.agent_id,
      contentText: r.content_text,
      similarity: parseFloat(r.similarity),
    }));
  }

  /**
   * Backfill intents missing embeddings.
   */
  private async backfillIntents(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; title: string; description: string; required_skills: string[]; tags: string[] }>(
      `SELECT i.id, i.title, i.description, i.required_skills, i.tags
       FROM intents i
       WHERE NOT EXISTS (
         SELECT 1 FROM intent_embeddings ie WHERE ie.intent_id = i.id
       )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) =>
      `${r.title} ${r.description} ${(r.required_skills ?? []).join(" ")} ${(r.tags ?? []).join(" ")}`.trim(),
    );
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO intent_embeddings (intent_id, content_text, embedding, model)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (intent_id) DO NOTHING`,
        [rows[i].id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  /**
   * Backfill agent profiles missing embeddings.
   */
  private async backfillAgentProfiles(limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; display_name: string | null; description: string | null; expertise: string[] }>(
      `SELECT a.id, a.display_name, a.description, a.expertise
       FROM agents a
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_embeddings ae WHERE ae.agent_id = a.id
       )
       LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return 0;

    const texts = rows.map((r) =>
      `${r.display_name ?? ""} ${r.description ?? ""} ${(r.expertise ?? []).join(" ")}`.trim(),
    );
    const embeddings = await this.embedBatch(texts);

    for (let i = 0; i < rows.length; i++) {
      if (texts[i].length < 10) continue; // skip agents with no useful profile data
      const vectorStr = `[${embeddings[i].join(",")}]`;
      await this.pool.query(
        `INSERT INTO agent_embeddings (agent_id, content_text, embedding, model)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (agent_id) DO NOTHING`,
        [rows[i].id, texts[i], vectorStr, MODEL],
      );
    }
    return rows.length;
  }

  /**
   * Get total embedding count (for stats endpoint).
   */
  async getEmbeddingCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM knowledge_embeddings`,
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  /**
   * Get embedding counts by content type.
   */
  async getEmbeddingCountsByType(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ content_type: string; count: string }>(
      `SELECT content_type, COUNT(*)::text AS count
       FROM knowledge_embeddings
       GROUP BY content_type
       ORDER BY count DESC`,
    );
    const result: Record<string, number> = {};
    for (const r of rows) {
      result[r.content_type] = parseInt(r.count, 10);
    }
    return result;
  }
}
