/**
 * Agent Memory Service — per-agent persistent memory with biological tiers,
 * exponential decay, dream cycle consolidation, and portable memory packs.
 *
 * Memory types (biological inspiration):
 * - episodic: specific events/interactions (default importance 0.5)
 * - semantic: generalised knowledge/facts (default importance 0.7)
 * - procedural: learned skills/procedures (default importance 0.8)
 * - self_model: self-knowledge/identity (default importance 0.9)
 *
 * Credit model: store is free, recall costs credits, import costs credits.
 *
 * @module services/agentMemoryService
 */

import crypto from "crypto";
import type pg from "pg";
import type { EmbeddingService } from "./embeddingService.js";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────

export type MemoryType = "episodic" | "semantic" | "procedural" | "self_model";

export interface AgentMemory {
  id: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  contentHash: string;
  importance: number;
  decayRate: number;
  accessCount: number;
  lastAccessedAt: string | null;
  tags: string[];
  source: string | null;
  parentMemoryId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  totalImportance: number;
  lastDreamCycle: string | null;
}

export interface MemoryPack {
  version: "1.0";
  agentId: string;
  exportedAt: string;
  memories: Array<{
    memoryType: MemoryType;
    content: string;
    contentHash: string;
    importance: number;
    tags: string[];
    source: string | null;
    metadata: Record<string, unknown>;
  }>;
  packHash: string;
}

export interface DreamCycleResult {
  memoriesProcessed: number;
  memoriesConsolidated: number;
  memoriesPruned: number;
  method: "llm" | "algorithmic";
  summary: string;
  durationMs: number;
}

export interface AgentMemoryConfig {
  recallCostCredits: number;       // default: 10 (= 0.10 display)
  importCostCredits: number;       // default: 25 (= 0.25 display)
  decayIntervalMs: number;         // default: 3_600_000 (1 hour)
  dreamIntervalMs: number;         // default: 21_600_000 (6 hours)
  pruneThreshold: number;          // default: 0.05
  maxMemoriesPerAgent: number;     // default: 10_000
  dreamBatchSize: number;          // default: 50 agents per cycle
  openaiApiKey?: string;           // enables LLM dream mode
  llmModel: string;                // default: 'gpt-4o-mini'
  maxDreamEpisodicWindow: number;  // default: 100
}

const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  episodic: 0.5,
  semantic: 0.7,
  procedural: 0.8,
  self_model: 0.9,
};

const VALID_TYPES: MemoryType[] = ["episodic", "semantic", "procedural", "self_model"];

// ────────────────────────────────────────────────────────
//  Service
// ────────────────────────────────────────────────────────

export class AgentMemoryService {
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  private dreamTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: AgentMemoryConfig;

  constructor(
    private readonly pool: pg.Pool,
    private readonly embeddingService: EmbeddingService | null,
    private readonly creditManager: CreditManager | null,
    config?: Partial<AgentMemoryConfig>,
  ) {
    this.config = {
      recallCostCredits: config?.recallCostCredits ?? 10,
      importCostCredits: config?.importCostCredits ?? 25,
      decayIntervalMs: config?.decayIntervalMs ?? 3_600_000,
      dreamIntervalMs: config?.dreamIntervalMs ?? 21_600_000,
      pruneThreshold: config?.pruneThreshold ?? 0.05,
      maxMemoriesPerAgent: config?.maxMemoriesPerAgent ?? 10_000,
      dreamBatchSize: config?.dreamBatchSize ?? 50,
      openaiApiKey: config?.openaiApiKey,
      llmModel: config?.llmModel ?? "gpt-4o-mini",
      maxDreamEpisodicWindow: config?.maxDreamEpisodicWindow ?? 100,
    };
  }

  // ────────────────────────────────────────────────────────
  //  Lifecycle
  // ────────────────────────────────────────────────────────

  start(): void {
    if (this.decayTimer) return;
    this.decayTimer = setInterval(() => {
      this.decayTick().catch((err) => {
        logSecurityEvent("error", "memory-decay-tick-failed", { error: String(err) });
      });
    }, this.config.decayIntervalMs);

    this.dreamTimer = setInterval(() => {
      this.dreamTick().catch((err) => {
        logSecurityEvent("error", "memory-dream-tick-failed", { error: String(err) });
      });
    }, this.config.dreamIntervalMs);

    logSecurityEvent("info", "agent-memory-service-started", {
      decayIntervalMs: this.config.decayIntervalMs,
      dreamIntervalMs: this.config.dreamIntervalMs,
    });
  }

  stop(): void {
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null; }
    if (this.dreamTimer) { clearInterval(this.dreamTimer); this.dreamTimer = null; }
  }

  // ────────────────────────────────────────────────────────
  //  Store (free — no credit cost)
  // ────────────────────────────────────────────────────────

  async store(
    agentId: string,
    type: MemoryType,
    content: string,
    opts?: {
      importance?: number;
      decayRate?: number;
      tags?: string[];
      source?: string;
      parentMemoryId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<AgentMemory> {
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_TYPES.join(", ")}`);
    }
    if (!content || content.trim().length === 0) {
      throw new Error("Memory content cannot be empty.");
    }

    // Enforce per-agent cap
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_memories WHERE agent_id = $1`,
      [agentId],
    );
    if (parseInt(countRows[0].count, 10) >= this.config.maxMemoriesPerAgent) {
      throw new Error(`Memory cap reached (${this.config.maxMemoriesPerAgent}). Prune old memories first.`);
    }

    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    const importance = opts?.importance ?? DEFAULT_IMPORTANCE[type];

    // Generate embedding if available
    let embeddingClause = "";
    let embeddingParam: string | undefined;
    const params: unknown[] = [
      agentId, type, content, contentHash, importance,
      opts?.decayRate ?? 0.1,
      opts?.tags ?? [],
      opts?.source ?? "experience",
      opts?.parentMemoryId ?? null,
      opts?.metadata ? JSON.stringify(opts.metadata) : "{}",
    ];

    if (this.embeddingService) {
      try {
        const hasPgvector = await this.embeddingService.hasPgvector();
        if (hasPgvector) {
          const embedding = await this.embeddingService.embed(content);
          embeddingParam = `[${embedding.join(",")}]`;
          params.push(embeddingParam);
          embeddingClause = `, embedding`;
        }
      } catch {
        // Embedding failure is non-fatal — store without vector
      }
    }

    const paramIndices = params.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO agent_memories
         (agent_id, memory_type, content, content_hash, importance, decay_rate, tags, source, parent_memory_id, metadata${embeddingClause})
       VALUES (${paramIndices})
       RETURNING *`,
      params,
    );

    return this.rowToMemory(rows[0]);
  }

  // ────────────────────────────────────────────────────────
  //  Recall (credit-gated)
  // ────────────────────────────────────────────────────────

  async recall(
    agentId: string,
    query: string,
    opts?: {
      types?: MemoryType[];
      limit?: number;
      minImportance?: number;
    },
  ): Promise<AgentMemory[]> {
    // Deduct credits
    if (this.creditManager && this.config.recallCostCredits > 0) {
      await this.creditManager.deductCredits(
        agentId,
        this.config.recallCostCredits,
        `memory-recall-${Date.now()}`,
        "memory_recall",
      );
    }

    const limit = Math.min(opts?.limit ?? 20, 100);
    const minImportance = opts?.minImportance ?? 0;

    // Try vector search first if embedding service available
    if (this.embeddingService) {
      try {
        const hasPgvector = await this.embeddingService.hasPgvector();
        if (hasPgvector) {
          const embedding = await this.embeddingService.embed(query);
          const vectorStr = `[${embedding.join(",")}]`;

          let typeFilter = "";
          const params: unknown[] = [agentId, vectorStr, minImportance, limit];
          if (opts?.types && opts.types.length > 0) {
            typeFilter = ` AND memory_type = ANY($5)`;
            params.push(opts.types);
          }

          const { rows } = await this.pool.query<Record<string, unknown>>(
            `SELECT *, embedding <=> $2::vector AS distance
             FROM agent_memories
             WHERE agent_id = $1 AND importance >= $3${typeFilter}
             ORDER BY distance ASC
             LIMIT $4`,
            params,
          );

          // Reinforce accessed memories
          if (rows.length > 0) {
            const ids = rows.map((r) => r.id);
            await this.pool.query(
              `UPDATE agent_memories
               SET access_count = access_count + 1, last_accessed_at = NOW(), updated_at = NOW()
               WHERE id = ANY($1)`,
              [ids],
            );
          }

          return rows.map((r) => this.rowToMemory(r));
        }
      } catch {
        // Fall through to FTS
      }
    }

    // Fallback: full-text search with ts_rank
    let typeFilter = "";
    const params: unknown[] = [agentId, query, minImportance, limit];
    if (opts?.types && opts.types.length > 0) {
      typeFilter = ` AND memory_type = ANY($5)`;
      params.push(opts.types);
    }

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT *,
              ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) AS rank
       FROM agent_memories
       WHERE agent_id = $1 AND importance >= $3${typeFilter}
         AND to_tsvector('english', content) @@ plainto_tsquery('english', $2)
       ORDER BY rank DESC, importance DESC
       LIMIT $4`,
      params,
    );

    // Reinforce accessed memories
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      await this.pool.query(
        `UPDATE agent_memories
         SET access_count = access_count + 1, last_accessed_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1)`,
        [ids],
      );
    }

    return rows.map((r) => this.rowToMemory(r));
  }

  // ────────────────────────────────────────────────────────
  //  List (free)
  // ────────────────────────────────────────────────────────

  async list(
    agentId: string,
    opts?: { type?: MemoryType; limit?: number; offset?: number },
  ): Promise<AgentMemory[]> {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const offset = opts?.offset ?? 0;

    let typeFilter = "";
    const params: unknown[] = [agentId, limit, offset];
    if (opts?.type) {
      typeFilter = ` AND memory_type = $4`;
      params.push(opts.type);
    }

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM agent_memories
       WHERE agent_id = $1${typeFilter}
       ORDER BY importance DESC, created_at DESC
       LIMIT $2 OFFSET $3`,
      params,
    );

    return rows.map((r) => this.rowToMemory(r));
  }

  // ────────────────────────────────────────────────────────
  //  Stats (free)
  // ────────────────────────────────────────────────────────

  async getStats(agentId: string): Promise<MemoryStats> {
    const { rows } = await this.pool.query<{ memory_type: string; count: string; total_importance: string }>(
      `SELECT memory_type, COUNT(*) AS count, COALESCE(SUM(importance), 0) AS total_importance
       FROM agent_memories WHERE agent_id = $1
       GROUP BY memory_type`,
      [agentId],
    );

    const byType: Record<MemoryType, number> = { episodic: 0, semantic: 0, procedural: 0, self_model: 0 };
    let total = 0;
    let totalImportance = 0;
    for (const r of rows) {
      const t = r.memory_type as MemoryType;
      const c = parseInt(r.count, 10);
      byType[t] = c;
      total += c;
      totalImportance += parseFloat(r.total_importance);
    }

    // Last dream cycle
    const { rows: dreamRows } = await this.pool.query<{ created_at: string }>(
      `SELECT created_at FROM memory_dream_cycles WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );

    return {
      total,
      byType,
      totalImportance: Math.round(totalImportance * 100) / 100,
      lastDreamCycle: dreamRows[0]?.created_at ?? null,
    };
  }

  // ────────────────────────────────────────────────────────
  //  Delete (free)
  // ────────────────────────────────────────────────────────

  async deleteMemory(agentId: string, memoryId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_memories WHERE id = $1 AND agent_id = $2`,
      [memoryId, agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ────────────────────────────────────────────────────────
  //  Export (free)
  // ────────────────────────────────────────────────────────

  async exportMemories(agentId: string): Promise<MemoryPack> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM agent_memories WHERE agent_id = $1 ORDER BY created_at ASC`,
      [agentId],
    );

    const memories = rows.map((r) => ({
      memoryType: r.memory_type as MemoryType,
      content: r.content as string,
      contentHash: r.content_hash as string,
      importance: r.importance as number,
      tags: r.tags as string[],
      source: r.source as string | null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));

    const packHash = crypto.createHash("sha256")
      .update(JSON.stringify(memories))
      .digest("hex");

    // Log the export
    await this.pool.query(
      `INSERT INTO memory_transfers (agent_id, direction, memory_count, content_hash) VALUES ($1, 'export', $2, $3)`,
      [agentId, memories.length, packHash],
    );

    return {
      version: "1.0",
      agentId,
      exportedAt: new Date().toISOString(),
      memories,
      packHash,
    };
  }

  // ────────────────────────────────────────────────────────
  //  Import (credit-gated)
  // ────────────────────────────────────────────────────────

  async importMemories(agentId: string, pack: MemoryPack): Promise<{ imported: number }> {
    if (!pack.memories || !Array.isArray(pack.memories) || pack.memories.length === 0) {
      throw new Error("Memory pack contains no memories.");
    }

    // Verify pack hash
    const expectedHash = crypto.createHash("sha256")
      .update(JSON.stringify(pack.memories))
      .digest("hex");
    if (expectedHash !== pack.packHash) {
      throw new Error("Memory pack hash mismatch — data may be corrupted.");
    }

    // Deduct credits
    if (this.creditManager && this.config.importCostCredits > 0) {
      await this.creditManager.deductCredits(
        agentId,
        this.config.importCostCredits,
        `memory-import-${Date.now()}`,
        "memory_import",
      );
    }

    // Check cap
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_memories WHERE agent_id = $1`,
      [agentId],
    );
    const current = parseInt(countRows[0].count, 10);
    const available = this.config.maxMemoriesPerAgent - current;
    const toImport = pack.memories.slice(0, available);

    if (toImport.length === 0) {
      throw new Error(`Memory cap reached (${this.config.maxMemoriesPerAgent}). Cannot import.`);
    }

    let imported = 0;
    for (const mem of toImport) {
      if (!VALID_TYPES.includes(mem.memoryType)) continue;
      const contentHash = crypto.createHash("sha256").update(mem.content).digest("hex");

      await this.pool.query(
        `INSERT INTO agent_memories
           (agent_id, memory_type, content, content_hash, importance, tags, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'import', $7)
         ON CONFLICT DO NOTHING`,
        [
          agentId, mem.memoryType, mem.content, contentHash,
          Math.max(0, Math.min(1, mem.importance)),
          mem.tags ?? [],
          JSON.stringify(mem.metadata ?? {}),
        ],
      );
      imported++;
    }

    // Log the import
    await this.pool.query(
      `INSERT INTO memory_transfers (agent_id, direction, memory_count, content_hash) VALUES ($1, 'import', $2, $3)`,
      [agentId, imported, pack.packHash],
    );

    return { imported };
  }

  // ────────────────────────────────────────────────────────
  //  Proof (free)
  // ────────────────────────────────────────────────────────

  async proveMemory(agentId: string, memoryId: string): Promise<{ contentHash: string; createdAt: string } | null> {
    const { rows } = await this.pool.query<{ content_hash: string; created_at: string }>(
      `SELECT content_hash, created_at FROM agent_memories WHERE id = $1 AND agent_id = $2`,
      [memoryId, agentId],
    );
    if (rows.length === 0) return null;
    return { contentHash: rows[0].content_hash, createdAt: rows[0].created_at };
  }

  // ────────────────────────────────────────────────────────
  //  Initialize Memory (called at registration time)
  // ────────────────────────────────────────────────────────

  async initializeMemory(agentId: string, soulDoc: Record<string, unknown>): Promise<void> {
    // Seed self_model from soul document fields
    const identity = soulDoc.identity as Record<string, unknown> | undefined;
    const personality = soulDoc.personality as Record<string, unknown> | undefined;
    const purpose = soulDoc.purpose as Record<string, unknown> | undefined;

    if (identity?.name) {
      await this.store(agentId, "self_model", `My name is ${identity.name}. ${identity.tagline || ""}`.trim(), {
        source: "registration_init",
        tags: ["identity", "name"],
        importance: 0.95,
      });
    }

    if (personality?.traits && Array.isArray(personality.traits)) {
      await this.store(agentId, "self_model", `My personality traits: ${(personality.traits as string[]).join(", ")}`, {
        source: "registration_init",
        tags: ["identity", "personality"],
        importance: 0.9,
      });
    }

    if (purpose?.mission) {
      await this.store(agentId, "self_model", `My mission: ${purpose.mission}`, {
        source: "registration_init",
        tags: ["identity", "mission"],
        importance: 0.95,
      });
    }

    if (purpose?.domains && Array.isArray(purpose.domains)) {
      await this.store(agentId, "semantic", `My expertise domains: ${(purpose.domains as string[]).join(", ")}`, {
        source: "registration_init",
        tags: ["knowledge", "domains"],
        importance: 0.8,
      });
    }
  }

  // ────────────────────────────────────────────────────────
  //  Decay Tick (scheduled)
  // ────────────────────────────────────────────────────────

  async decayTick(): Promise<{ decayed: number; pruned: number }> {
    // Apply exponential decay: importance *= exp(-decayRate * daysSinceLastAccess)
    // For memories never accessed, use daysSinceCreation
    const { rowCount: decayed } = await this.pool.query(
      `UPDATE agent_memories
       SET importance = GREATEST(0, importance * EXP(
         -decay_rate * EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed_at, created_at))) / 86400.0
       )),
       updated_at = NOW()
       WHERE importance > $1`,
      [this.config.pruneThreshold],
    );

    // Prune memories below threshold
    const { rowCount: pruned } = await this.pool.query(
      `DELETE FROM agent_memories WHERE importance <= $1 AND memory_type != 'self_model'`,
      [this.config.pruneThreshold],
    );

    logSecurityEvent("info", "memory-decay-tick", { decayed: decayed ?? 0, pruned: pruned ?? 0 });
    return { decayed: decayed ?? 0, pruned: pruned ?? 0 };
  }

  // ────────────────────────────────────────────────────────
  //  Dream Tick (scheduled — consolidation)
  // ────────────────────────────────────────────────────────

  async dreamTick(): Promise<void> {
    // Find agents with >10 unconsolidated episodic memories in the last 24h
    const { rows: agents } = await this.pool.query<{ agent_id: string; ep_count: string }>(
      `SELECT agent_id, COUNT(*) AS ep_count
       FROM agent_memories
       WHERE memory_type = 'episodic'
         AND source != 'dream_cycle'
         AND created_at > NOW() - INTERVAL '24 hours'
       GROUP BY agent_id
       HAVING COUNT(*) > 10
       ORDER BY COUNT(*) DESC
       LIMIT $1`,
      [this.config.dreamBatchSize],
    );

    for (const row of agents) {
      try {
        await this.consolidate(row.agent_id);
      } catch (err) {
        logSecurityEvent("error", "dream-cycle-agent-failed", {
          agentId: row.agent_id,
          error: String(err),
        });
      }
    }
  }

  // ────────────────────────────────────────────────────────
  //  Consolidate (dream cycle for one agent)
  // ────────────────────────────────────────────────────────

  async consolidate(agentId: string): Promise<DreamCycleResult> {
    const startMs = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // Idempotency check
    const { rows: existing } = await this.pool.query(
      `SELECT 1 FROM memory_dream_cycles WHERE agent_id = $1 AND cycle_date = $2`,
      [agentId, today],
    );
    if (existing.length > 0) {
      return {
        memoriesProcessed: 0, memoriesConsolidated: 0, memoriesPruned: 0,
        method: "algorithmic", summary: "Already processed today.", durationMs: 0,
      };
    }

    // Fetch recent episodic memories
    const { rows: episodic } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM agent_memories
       WHERE agent_id = $1 AND memory_type = 'episodic'
         AND source != 'dream_cycle'
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, this.config.maxDreamEpisodicWindow],
    );

    if (episodic.length === 0) {
      return {
        memoriesProcessed: 0, memoriesConsolidated: 0, memoriesPruned: 0,
        method: "algorithmic", summary: "No episodic memories to consolidate.", durationMs: Date.now() - startMs,
      };
    }

    // Use algorithmic consolidation (LLM consolidation is deferred)
    const result = await this.algorithmicConsolidate(agentId, episodic);

    // Log dream cycle
    await this.pool.query(
      `INSERT INTO memory_dream_cycles
         (agent_id, cycle_date, memories_processed, memories_consolidated, memories_pruned, method, summary, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_id, cycle_date) DO NOTHING`,
      [
        agentId, today,
        result.memoriesProcessed, result.memoriesConsolidated, result.memoriesPruned,
        result.method, result.summary, result.durationMs,
      ],
    );

    return result;
  }

  // ────────────────────────────────────────────────────────
  //  Algorithmic Consolidation
  // ────────────────────────────────────────────────────────

  private async algorithmicConsolidate(
    agentId: string,
    episodicRows: Record<string, unknown>[],
  ): Promise<DreamCycleResult> {
    const startMs = Date.now();
    let consolidated = 0;
    let pruned = 0;

    // Group by tags overlap — cluster similar memories
    const tagGroups = new Map<string, Record<string, unknown>[]>();
    for (const row of episodicRows) {
      const tags = (row.tags as string[]) ?? [];
      const key = tags.length > 0 ? tags.sort().join(",") : "__untagged__";
      if (!tagGroups.has(key)) tagGroups.set(key, []);
      tagGroups.get(key)!.push(row);
    }

    // For each cluster with 3+ memories, create a semantic summary
    for (const [tagKey, members] of tagGroups.entries()) {
      if (members.length < 3) continue;

      const contents = members.map((m) => (m.content as string).slice(0, 200));
      const summary = `Consolidated from ${members.length} episodic memories: ${contents.join(" | ")}`.slice(0, 2000);
      const tags = tagKey === "__untagged__" ? ["consolidated"] : tagKey.split(",").concat("consolidated");

      await this.store(agentId, "semantic", summary, {
        source: "dream_cycle",
        tags,
        importance: 0.7,
        parentMemoryId: members[0].id as string,
      });
      consolidated++;
    }

    // Promote frequently accessed episodic memories to procedural
    const frequentlyAccessed = episodicRows.filter((r) => (r.access_count as number) >= 3);
    for (const row of frequentlyAccessed.slice(0, 5)) {
      await this.store(agentId, "procedural", row.content as string, {
        source: "dream_cycle",
        tags: ((row.tags as string[]) ?? []).concat("promoted"),
        importance: 0.8,
        parentMemoryId: row.id as string,
      });
      consolidated++;
    }

    // Prune low-importance episodic memories
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_memories
       WHERE agent_id = $1 AND memory_type = 'episodic'
         AND importance < 0.2 AND access_count = 0
         AND created_at < NOW() - INTERVAL '7 days'`,
      [agentId],
    );
    pruned = rowCount ?? 0;

    return {
      memoriesProcessed: episodicRows.length,
      memoriesConsolidated: consolidated,
      memoriesPruned: pruned,
      method: "algorithmic",
      summary: `Processed ${episodicRows.length} episodic memories. Created ${consolidated} consolidated memories. Pruned ${pruned} low-importance memories.`,
      durationMs: Date.now() - startMs,
    };
  }

  // ────────────────────────────────────────────────────────
  //  Row Mapping
  // ────────────────────────────────────────────────────────

  private rowToMemory(row: Record<string, unknown>): AgentMemory {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      memoryType: row.memory_type as MemoryType,
      content: row.content as string,
      contentHash: row.content_hash as string,
      importance: row.importance as number,
      decayRate: row.decay_rate as number,
      accessCount: row.access_count as number,
      lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : null,
      tags: (row.tags as string[]) ?? [],
      source: row.source as string | null,
      parentMemoryId: row.parent_memory_id as string | null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
