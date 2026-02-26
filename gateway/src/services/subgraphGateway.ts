/**
 * Centralized subgraph query gateway with rate limiting, two-tier caching,
 * and PostgreSQL persistence so cached data survives gateway restarts.
 *
 * ALL subgraph queries flow through this single service. It enforces a
 * configurable daily query budget with aggressive caching so normal traffic
 * never actually hits the limit. When budget is exhausted or the upstream
 * subgraph is unreachable, stale cached data is served transparently.
 *
 * Cache tiers:
 * 1. In-memory Map (fast, lost on restart)
 * 2. PostgreSQL subgraph_cache table (slow, survives restarts)
 *
 * Budget zones:
 * - Green  (0–70%):   Normal cache TTL
 * - Yellow (70–90%):  3x cache TTL — slows burn rate
 * - Red    (90–100%): 10x cache TTL — maximum conservation
 * - Exhausted (100%): No upstream queries, stale cache only
 *
 * @module services/subgraphGateway
 */

import crypto from "crypto";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface SubgraphQueryResult<T = unknown> {
  data: T;
  fromCache: boolean;
  stale: boolean;
}

export interface SubgraphUsage {
  count: number;
  limit: number;
  remaining: number;
  zone: "green" | "yellow" | "red" | "exhausted";
  resetsAt: string;
  cacheSize: number;
  cacheHitRate: number;
}

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
  cacheKey: string;
}

interface SubgraphGatewayOptions {
  dailyLimit?: number;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  maxCacheEntries?: number;
}

// ============================================================
//  SubgraphGateway
// ============================================================

export class SubgraphGateway {
  private readonly subgraphUrl: string | undefined;
  private readonly dailyLimit: number;
  private readonly baseCacheTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly maxCacheEntries: number;

  /** Optional Postgres pool for persistent cache. */
  private readonly db: pg.Pool | undefined;

  /** Cache: key → entry */
  private readonly cache = new Map<string, CacheEntry>();

  /** Daily query counter — resets at midnight UTC. */
  private queryCount = 0;
  private currentDay = this.todayUTC();

  /** Cache hit tracking for monitoring. */
  private cacheHits = 0;
  private cacheMisses = 0;

  /** Periodic cache cleanup. */
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    subgraphUrl: string | undefined,
    options?: SubgraphGatewayOptions,
    db?: pg.Pool,
  ) {
    this.subgraphUrl = subgraphUrl;
    this.dailyLimit = options?.dailyLimit ?? 10_000;
    this.baseCacheTtlMs = options?.cacheTtlMs ?? 60_000;
    // Default stale TTL: 72 hours — graph data barely changes and serving
    // stale data is far better than an empty graph during rate-limit windows
    this.staleTtlMs = options?.staleTtlMs ?? 259_200_000;
    this.maxCacheEntries = options?.maxCacheEntries ?? 1_000;
    this.db = db;

    // Evict expired stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60_000);
    this.cleanupTimer.unref();

    logSecurityEvent("info", "subgraph-gateway-init", {
      dailyLimit: this.dailyLimit,
      cacheTtlMs: this.baseCacheTtlMs,
      staleTtlMs: this.staleTtlMs,
      configured: !!subgraphUrl,
      dbPersistence: !!db,
    });
  }

  // ============================================================
  //  Public API
  // ============================================================

  /**
   * Load persisted cache entries from Postgres into the in-memory Map.
   * Called once on startup so the gateway is never "cold".
   */
  async loadPersistedCache(): Promise<void> {
    if (!this.db) return;

    try {
      // Only load entries from the current subgraph URL.
      // Entries from a previous URL are stale and must not be served.
      const { rows } = await this.db.query<{
        cache_key: string;
        response: unknown;
        fetched_at: Date;
      }>(
        `SELECT cache_key, response, fetched_at
         FROM subgraph_cache
         WHERE source_url = $2 OR source_url IS NULL
         ORDER BY fetched_at DESC
         LIMIT $1`,
        [this.maxCacheEntries, this.subgraphUrl ?? ""],
      );

      for (const row of rows) {
        this.cache.set(row.cache_key, {
          cacheKey: row.cache_key,
          data: row.response,
          fetchedAt: row.fetched_at.getTime(),
        });
      }

      // Clean up entries from old subgraph URLs (fire-and-forget)
      if (this.subgraphUrl) {
        this.db.query(
          `DELETE FROM subgraph_cache WHERE source_url IS NOT NULL AND source_url <> $1`,
          [this.subgraphUrl],
        ).catch(() => { /* best-effort cleanup */ });
      }

      logSecurityEvent("info", "subgraph-cache-loaded", {
        entries: rows.length,
      });
    } catch (err) {
      // Non-fatal — just means cold cache on this startup
      logSecurityEvent("warn", "subgraph-cache-load-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Proactively warm the cache by fetching common queries.
   * Called after the server starts listening.
   */
  async warmUp(queries: Array<{ query: string; variables?: Record<string, unknown> }>): Promise<void> {
    if (!this.subgraphUrl) return;

    for (const q of queries) {
      try {
        await this.query(q.query, q.variables);
      } catch {
        // Warm-up failures are fine — we already have persisted cache
      }
    }

    logSecurityEvent("info", "subgraph-cache-warmup-complete", {
      queries: queries.length,
      cacheSize: this.cache.size,
    });
  }

  /**
   * Execute a subgraph query. Returns cached data when possible,
   * respects daily budget, and gracefully degrades to stale cache.
   */
  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<SubgraphQueryResult<T>> {
    if (!this.subgraphUrl) {
      throw new Error("Subgraph URL not configured");
    }

    this.rolloverIfNewDay();

    const cacheKey = this.buildCacheKey(query, variables);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // 1. Fresh cache hit — serve immediately
    if (cached && (now - cached.fetchedAt) < this.effectiveTtl()) {
      this.cacheHits++;
      return { data: cached.data as T, fromCache: true, stale: false };
    }

    // 2. Budget exhausted — serve stale cache or throw
    if (this.queryCount >= this.dailyLimit) {
      if (cached && (now - cached.fetchedAt) < this.staleTtlMs) {
        this.cacheHits++;
        return { data: cached.data as T, fromCache: true, stale: true };
      }
      throw new SubgraphBudgetExhaustedError(
        "Subgraph daily query budget exhausted and no cached data available",
      );
    }

    // 3. Fetch from upstream (with retry on 429)
    const MAX_RETRIES = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const payload = JSON.stringify({ query, variables: variables ?? undefined });
        const upstream = await fetch(this.subgraphUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(15_000),
        });

        this.queryCount++;
        if (attempt === 0) this.cacheMisses++;

        if (upstream.status === 429) {
          // Rate limited — wait and retry with exponential backoff
          const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
          await new Promise(r => setTimeout(r, delay));
          lastError = new Error(`Upstream subgraph returned HTTP 429 (attempt ${attempt + 1})`);
          continue;
        }

        if (!upstream.ok) {
          // Non-retryable upstream error — fall back to stale cache if available
          if (cached && (now - cached.fetchedAt) < this.staleTtlMs) {
            return { data: cached.data as T, fromCache: true, stale: true };
          }
          throw new Error(`Upstream subgraph returned HTTP ${upstream.status}`);
        }

        const json = (await upstream.json()) as {
          data?: T;
          errors?: Array<{ message: string }>;
        };

        if (json.errors?.length) {
          // GraphQL errors — fall back to stale cache if available
          if (cached && (now - cached.fetchedAt) < this.staleTtlMs) {
            return { data: cached.data as T, fromCache: true, stale: true };
          }
          throw new Error(`Subgraph query error: ${json.errors[0].message}`);
        }

        // Cache the result (memory + DB)
        if (json.data !== undefined) {
          this.putCache(cacheKey, json.data, query);
        }

        return { data: json.data as T, fromCache: false, stale: false };
      } catch (err) {
        if (err instanceof Error && err.message.includes("429")) {
          lastError = err;
          continue;
        }
        // Network error — fall back to stale cache
        if (cached && (now - cached.fetchedAt) < this.staleTtlMs) {
          return { data: cached.data as T, fromCache: true, stale: true };
        }
        throw err;
      }
    }

    // All retries exhausted — fall back to stale cache or throw
    if (cached && (now - cached.fetchedAt) < this.staleTtlMs) {
      return { data: cached.data as T, fromCache: true, stale: true };
    }
    throw lastError ?? new Error("Subgraph query failed after retries");
  }

  /**
   * Get current usage statistics for monitoring.
   */
  getUsage(): SubgraphUsage {
    this.rolloverIfNewDay();
    const totalRequests = this.cacheHits + this.cacheMisses;
    return {
      count: this.queryCount,
      limit: this.dailyLimit,
      remaining: Math.max(0, this.dailyLimit - this.queryCount),
      zone: this.currentZone(),
      resetsAt: this.nextMidnightUTC(),
      cacheSize: this.cache.size,
      cacheHitRate: totalRequests > 0
        ? Math.round((this.cacheHits / totalRequests) * 10000) / 10000
        : 0,
    };
  }

  // ============================================================
  //  Budget zone logic
  // ============================================================

  private currentZone(): "green" | "yellow" | "red" | "exhausted" {
    const ratio = this.queryCount / this.dailyLimit;
    if (ratio >= 1) return "exhausted";
    if (ratio >= 0.9) return "red";
    if (ratio >= 0.7) return "yellow";
    return "green";
  }

  /**
   * Effective cache TTL based on current budget zone.
   * Yellow = 3x, Red = 10x — slows burn rate under pressure.
   */
  private effectiveTtl(): number {
    const zone = this.currentZone();
    if (zone === "red" || zone === "exhausted") return this.baseCacheTtlMs * 10;
    if (zone === "yellow") return this.baseCacheTtlMs * 3;
    return this.baseCacheTtlMs;
  }

  // ============================================================
  //  Cache management
  // ============================================================

  private buildCacheKey(query: string, variables?: Record<string, unknown>): string {
    // Include subgraph URL so cache auto-invalidates when the upstream changes
    const payload = JSON.stringify({ url: this.subgraphUrl, query, variables: variables ?? null });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  private putCache(key: string, data: unknown, queryText?: string): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxCacheEntries) {
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);
    }
    const now = Date.now();
    this.cache.set(key, { data, fetchedAt: now, cacheKey: key });

    // Write-through to Postgres (fire-and-forget, non-blocking)
    if (this.db) {
      this.db.query(
        `INSERT INTO subgraph_cache (cache_key, query_text, response, fetched_at, source_url)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)
         ON CONFLICT (cache_key)
         DO UPDATE SET response = EXCLUDED.response, fetched_at = EXCLUDED.fetched_at, source_url = EXCLUDED.source_url`,
        [key, queryText ?? "", JSON.stringify(data), now, this.subgraphUrl ?? ""],
      ).catch((err) => {
        logSecurityEvent("warn", "subgraph-cache-persist-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.fetchedAt > this.staleTtlMs) {
        this.cache.delete(key);
      }
    }

    // Also clean old DB rows (fire-and-forget)
    if (this.db) {
      this.db.query(
        `DELETE FROM subgraph_cache WHERE fetched_at < NOW() - INTERVAL '7 days'`,
      ).catch(() => { /* best-effort cleanup */ });
    }
  }

  // ============================================================
  //  Day rollover
  // ============================================================

  private todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private rolloverIfNewDay(): void {
    const today = this.todayUTC();
    if (today !== this.currentDay) {
      logSecurityEvent("info", "subgraph-gateway-daily-reset", {
        previousDay: this.currentDay,
        previousCount: this.queryCount,
      });
      this.queryCount = 0;
      this.cacheHits = 0;
      this.cacheMisses = 0;
      this.currentDay = today;
    }
  }

  private nextMidnightUTC(): string {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.toISOString();
  }
}

// ============================================================
//  Custom error for budget exhaustion (so callers can 503)
// ============================================================

export class SubgraphBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubgraphBudgetExhaustedError";
  }
}
