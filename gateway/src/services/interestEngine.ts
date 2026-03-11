/**
 * Interest Engine — structured interest subscriptions, tag-based matching,
 * notification delivery, digest compilation, and GitHub repo watching.
 *
 * Replaces the polling-based search subscription system with event-driven
 * entity matching. Agents register structured interests (tags + optional
 * free-text query + filters), and get real-time notifications when matching
 * entities appear on the network.
 *
 * @module services/interestEngine
 */

import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import type { RuntimeEventBroadcaster, RuntimeWsEvent } from "./runtimeEventBroadcaster.js";
import type { MessageBus } from "./messageBus.js";
import type { SearchService } from "./searchService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

// ============================================================
//  Types
// ============================================================

export interface InterestEngineConfig {
  freeNotificationsPerDay: number;
  notificationCost: number;       // credits per push notification
  digestCost: number;             // credits per digest item
  maxDailyNotifications: number;
  maxSubscriptionsPerAgent: number;
  maxRepoWatchesPerAgent: number;
  entityBufferMs: number;         // micro-batch window
  repoWatchIntervalMs: number;    // 15 min
  digestHourUtc: number;          // 0-23
}

export interface EntityCreatedEvent {
  entityType: string;
  entityId: string;
  title: string;
  description?: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface SubscriptionRow {
  id: string;
  agent_id: string;
  label: string;
  tags: string[];
  query: string;
  match_mode: string;
  entity_types: string[];
  filters: Record<string, unknown>;
  enabled: boolean;
  notify_realtime: boolean;
  notify_digest: boolean;
  max_notifications_per_day: number;
}

interface CreateSubscriptionInput {
  label: string;
  tags?: string[];
  query?: string;
  matchMode?: string;
  entityTypes?: string[];
  filters?: Record<string, unknown>;
  notifyRealtime?: boolean;
  notifyDigest?: boolean;
  digestFrequency?: string;
  maxNotificationsPerDay?: number;
}

interface UpdateSubscriptionInput {
  label?: string;
  tags?: string[];
  query?: string;
  matchMode?: string;
  entityTypes?: string[];
  filters?: Record<string, unknown>;
  enabled?: boolean;
  notifyRealtime?: boolean;
  notifyDigest?: boolean;
  digestFrequency?: string;
  maxNotificationsPerDay?: number;
}

// ============================================================
//  Tag normalization
// ============================================================

const TAG_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  ml: "machine-learning",
  ai: "artificial-intelligence",
  "c++": "cpp",
  "c#": "csharp",
};

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "project", "bounty", "task", "paper", "service_listing",
  "agent", "community", "guild", "channel", "intent",
]);

export function normalizeTag(raw: string): string {
  let tag = raw.trim().toLowerCase();
  // Spaces/underscores → hyphens
  tag = tag.replace(/[\s_]+/g, "-");
  // Collapse multiple hyphens
  tag = tag.replace(/-{2,}/g, "-");
  // Strip non-alphanumeric except hyphens
  tag = tag.replace(/[^a-z0-9-]/g, "");
  // Remove leading/trailing hyphens
  tag = tag.replace(/^-+|-+$/g, "");
  // Truncate
  tag = tag.slice(0, 64);
  // Apply alias
  return TAG_ALIASES[tag] ?? tag;
}

export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of raw) {
    const n = normalizeTag(r);
    if (n && !seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

// ============================================================
//  InterestEngine
// ============================================================

export class InterestEngine {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;
  private readonly broadcaster: RuntimeEventBroadcaster;
  private readonly messageBus: MessageBus;
  private readonly searchService: SearchService;
  private readonly config: InterestEngineConfig;

  /** Micro-batch buffer for entity events. */
  private entityBuffer: EntityCreatedEvent[] = [];
  private bufferTimer: ReturnType<typeof setTimeout> | null = null;

  /** Message bus unsubscribe handle. */
  private busUnsubscribe: (() => void) | null = null;

  constructor(
    pool: pg.Pool,
    creditManager: CreditManager,
    broadcaster: RuntimeEventBroadcaster,
    messageBus: MessageBus,
    searchService: SearchService,
    config: InterestEngineConfig,
  ) {
    this.pool = pool;
    this.creditManager = creditManager;
    this.broadcaster = broadcaster;
    this.messageBus = messageBus;
    this.searchService = searchService;
    this.config = config;

    // Subscribe to entity events on the message bus
    this.busUnsubscribe = messageBus.subscribePattern("entity:", (_channel, message) => {
      const event = message.data as unknown as EntityCreatedEvent;
      if (event?.entityType && event?.entityId) {
        this.bufferEntity(event);
      }
    });
  }

  // ============================================================
  //  Tag Management
  // ============================================================

  /** Register tags in the tag_registry, upserting usage counts. */
  async ensureTagsRegistered(tags: string[]): Promise<void> {
    if (!tags.length) return;
    const normalized = normalizeTags(tags);
    if (!normalized.length) return;

    // Batch upsert
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const tag of normalized) {
      values.push(`($${idx++}, $${idx++}, 1)`);
      params.push(tag, tag); // tag, display_name (use tag as default display)
    }

    await this.pool.query(
      `INSERT INTO tag_registry (tag, display_name, usage_count)
       VALUES ${values.join(", ")}
       ON CONFLICT (tag) DO UPDATE SET usage_count = tag_registry.usage_count + 1`,
      params,
    );
  }

  /** Autocomplete tags by prefix. */
  async suggestTags(prefix: string, limit = 10): Promise<Array<{ tag: string; displayName: string; category: string | null; usageCount: number }>> {
    const normalized = normalizeTag(prefix);
    if (!normalized) return [];

    const { rows } = await this.pool.query(
      `SELECT tag, display_name, category, usage_count
       FROM tag_registry
       WHERE tag LIKE $1
       ORDER BY usage_count DESC
       LIMIT $2`,
      [`${normalized}%`, limit],
    );

    return rows.map((r: Record<string, unknown>) => ({
      tag: r.tag as string,
      displayName: r.display_name as string,
      category: r.category as string | null,
      usageCount: r.usage_count as number,
    }));
  }

  /** Top tags by usage. */
  async trendingTags(limit = 20): Promise<Array<{ tag: string; displayName: string; category: string | null; usageCount: number }>> {
    const { rows } = await this.pool.query(
      `SELECT tag, display_name, category, usage_count
       FROM tag_registry
       ORDER BY usage_count DESC
       LIMIT $1`,
      [limit],
    );

    return rows.map((r: Record<string, unknown>) => ({
      tag: r.tag as string,
      displayName: r.display_name as string,
      category: r.category as string | null,
      usageCount: r.usage_count as number,
    }));
  }

  /** List/search tags with optional category and query filter. */
  async listTags(opts: { q?: string; category?: string; limit?: number; offset?: number }): Promise<{ tags: Array<{ tag: string; displayName: string; category: string | null; usageCount: number }>; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts.q) {
      const normalized = normalizeTag(opts.q);
      if (normalized) {
        conditions.push(`tag LIKE $${idx++}`);
        params.push(`%${normalized}%`);
      }
    }
    if (opts.category) {
      conditions.push(`category = $${idx++}`);
      params.push(opts.category);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;

    const countResult = await this.pool.query(`SELECT COUNT(*)::int AS cnt FROM tag_registry ${where}`, params);
    const total = countResult.rows[0].cnt as number;

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT tag, display_name, category, usage_count
       FROM tag_registry ${where}
       ORDER BY usage_count DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      params,
    );

    return {
      tags: rows.map((r: Record<string, unknown>) => ({
        tag: r.tag as string,
        displayName: r.display_name as string,
        category: r.category as string | null,
        usageCount: r.usage_count as number,
      })),
      total,
    };
  }

  // ============================================================
  //  Subscription CRUD
  // ============================================================

  async createSubscription(agentId: string, input: CreateSubscriptionInput): Promise<Record<string, unknown>> {
    // Validate label
    if (!input.label || input.label.length < 1 || input.label.length > 200) {
      throw new ValidationError("Label must be 1-200 characters");
    }

    // At least tags or query required
    const tags = input.tags ? normalizeTags(input.tags) : [];
    const query = input.query?.trim() ?? "";
    if (!tags.length && !query) {
      throw new ValidationError("At least one tag or a search query is required");
    }

    // Validate match mode
    const matchMode = input.matchMode ?? "any";
    if (matchMode !== "any" && matchMode !== "all") {
      throw new ValidationError("matchMode must be 'any' or 'all'");
    }

    // Validate entity types
    const entityTypes = input.entityTypes ?? [];
    for (const et of entityTypes) {
      if (!VALID_ENTITY_TYPES.has(et)) {
        throw new ValidationError(`Invalid entity type: ${et}`);
      }
    }

    // Check subscription limit
    const { rows: countRows } = await this.pool.query(
      "SELECT COUNT(*)::int AS cnt FROM interest_subscriptions WHERE agent_id = $1",
      [agentId],
    );
    if (countRows[0].cnt >= this.config.maxSubscriptionsPerAgent) {
      throw new LimitError(`Maximum ${this.config.maxSubscriptionsPerAgent} subscriptions reached`);
    }

    const notifyRealtime = input.notifyRealtime ?? true;
    const notifyDigest = input.notifyDigest ?? false;
    const digestFrequency = input.digestFrequency ?? "daily";
    const maxNotificationsPerDay = input.maxNotificationsPerDay ?? 50;

    if (digestFrequency !== "daily" && digestFrequency !== "weekly") {
      throw new ValidationError("digestFrequency must be 'daily' or 'weekly'");
    }
    if (maxNotificationsPerDay < 1 || maxNotificationsPerDay > 500) {
      throw new ValidationError("maxNotificationsPerDay must be 1-500");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO interest_subscriptions
           (agent_id, label, tags, query, match_mode, entity_types, filters,
            notify_realtime, notify_digest, digest_frequency, max_notifications_per_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          agentId, input.label.trim(), tags, query, matchMode, entityTypes,
          JSON.stringify(input.filters ?? {}),
          notifyRealtime, notifyDigest, digestFrequency, maxNotificationsPerDay,
        ],
      );

      const sub = rows[0];

      // Rebuild inverted index for this subscription
      await this.rebuildInvertedIndex(client, sub.id, tags);

      // Register tags
      if (tags.length) {
        await this.ensureTagsRegisteredInTx(client, tags);
      }

      await client.query("COMMIT");

      logSecurityEvent("info", "interest-sub-created", { agentId, subId: sub.id });
      return this.mapSubscriptionRow(sub);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateSubscription(agentId: string, subId: string, input: UpdateSubscriptionInput): Promise<Record<string, unknown>> {
    // Validate optional fields
    if (input.label !== undefined && (input.label.length < 1 || input.label.length > 200)) {
      throw new ValidationError("Label must be 1-200 characters");
    }
    if (input.matchMode !== undefined && input.matchMode !== "any" && input.matchMode !== "all") {
      throw new ValidationError("matchMode must be 'any' or 'all'");
    }
    if (input.entityTypes !== undefined) {
      for (const et of input.entityTypes) {
        if (!VALID_ENTITY_TYPES.has(et)) {
          throw new ValidationError(`Invalid entity type: ${et}`);
        }
      }
    }
    if (input.digestFrequency !== undefined && input.digestFrequency !== "daily" && input.digestFrequency !== "weekly") {
      throw new ValidationError("digestFrequency must be 'daily' or 'weekly'");
    }
    if (input.maxNotificationsPerDay !== undefined && (input.maxNotificationsPerDay < 1 || input.maxNotificationsPerDay > 500)) {
      throw new ValidationError("maxNotificationsPerDay must be 1-500");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Build dynamic SET clause
      const sets: string[] = ["updated_at = NOW()"];
      const vals: unknown[] = [];
      let idx = 1;

      let newTags: string[] | undefined;

      if (input.label !== undefined) { sets.push(`label = $${idx++}`); vals.push(input.label.trim()); }
      if (input.tags !== undefined) {
        newTags = normalizeTags(input.tags);
        sets.push(`tags = $${idx++}`);
        vals.push(newTags);
      }
      if (input.query !== undefined) { sets.push(`query = $${idx++}`); vals.push(input.query.trim()); }
      if (input.matchMode !== undefined) { sets.push(`match_mode = $${idx++}`); vals.push(input.matchMode); }
      if (input.entityTypes !== undefined) { sets.push(`entity_types = $${idx++}`); vals.push(input.entityTypes); }
      if (input.filters !== undefined) { sets.push(`filters = $${idx++}`); vals.push(JSON.stringify(input.filters)); }
      if (input.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(input.enabled); }
      if (input.notifyRealtime !== undefined) { sets.push(`notify_realtime = $${idx++}`); vals.push(input.notifyRealtime); }
      if (input.notifyDigest !== undefined) { sets.push(`notify_digest = $${idx++}`); vals.push(input.notifyDigest); }
      if (input.digestFrequency !== undefined) { sets.push(`digest_frequency = $${idx++}`); vals.push(input.digestFrequency); }
      if (input.maxNotificationsPerDay !== undefined) { sets.push(`max_notifications_per_day = $${idx++}`); vals.push(input.maxNotificationsPerDay); }

      vals.push(subId, agentId);

      const { rows } = await client.query(
        `UPDATE interest_subscriptions SET ${sets.join(", ")}
         WHERE id = $${idx++} AND agent_id = $${idx}
         RETURNING *`,
        vals,
      );

      if (!rows.length) {
        await client.query("ROLLBACK");
        return null as unknown as Record<string, unknown>;
      }

      // Rebuild inverted index if tags changed
      if (newTags !== undefined) {
        await this.rebuildInvertedIndex(client, subId, newTags);
        if (newTags.length) {
          await this.ensureTagsRegisteredInTx(client, newTags);
        }
      }

      await client.query("COMMIT");

      logSecurityEvent("info", "interest-sub-updated", { agentId, subId });
      return this.mapSubscriptionRow(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteSubscription(agentId: string, subId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM interest_subscriptions WHERE id = $1 AND agent_id = $2",
      [subId, agentId],
    );
    if (rowCount) {
      logSecurityEvent("info", "interest-sub-deleted", { agentId, subId });
    }
    return (rowCount ?? 0) > 0;
  }

  async listSubscriptions(agentId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM interest_subscriptions
       WHERE agent_id = $1
       ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r: Record<string, unknown>) => this.mapSubscriptionRow(r));
  }

  async getSubscription(agentId: string, subId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM interest_subscriptions
       WHERE id = $1 AND agent_id = $2`,
      [subId, agentId],
    );
    return rows.length ? this.mapSubscriptionRow(rows[0]) : null;
  }

  /**
   * Dry-run: test a subscription against current data, returning what would match
   * without sending notifications or charging credits.
   */
  async testSubscription(agentId: string, subId: string): Promise<{ matches: Array<{ entityType: string; entityId: string; title: string; relevanceScore: number; tagsMatched: string[] }>; estimatedDailyCost: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM interest_subscriptions WHERE id = $1 AND agent_id = $2`,
      [subId, agentId],
    );
    if (!rows.length) return null;

    const sub = rows[0] as SubscriptionRow;
    const matches: Array<{ entityType: string; entityId: string; title: string; relevanceScore: number; tagsMatched: string[] }> = [];

    // Search for tag-based matches across available entity tables
    if (sub.tags.length) {
      const entityTables = this.getEntityTablesForTypes(sub.entity_types);
      for (const table of entityTables) {
        try {
          const { rows: entities } = await this.pool.query(
            `SELECT ${table.idCol} AS entity_id, ${table.titleCol} AS title, tags
             FROM ${table.table}
             WHERE tags && $1
             LIMIT 20`,
            [sub.tags],
          );
          for (const entity of entities) {
            const entityTags = (entity.tags as string[]) ?? [];
            const matched = sub.tags.filter(t => entityTags.includes(t));
            if (this.evaluateMatchMode(sub.match_mode, sub.tags, matched)) {
              matches.push({
                entityType: table.entityType,
                entityId: String(entity.entity_id),
                title: entity.title as string,
                relevanceScore: this.computeRelevance(sub.tags, matched),
                tagsMatched: matched,
              });
            }
          }
        } catch {
          // Table might not have tags column or might not exist
        }
      }
    }

    // Text-based search
    if (sub.query) {
      try {
        const types = sub.entity_types.length ? sub.entity_types : undefined;
        const searchResult = await this.searchService.search(sub.query, types as never, 20);
        for (const r of searchResult.results) {
          matches.push({
            entityType: r.type,
            entityId: r.id,
            title: r.title,
            relevanceScore: r.relevance,
            tagsMatched: [],
          });
        }
      } catch {
        // Search service might fail
      }
    }

    // Estimate daily cost
    const freePerDay = this.config.freeNotificationsPerDay;
    const estimatedMatches = Math.min(matches.length * 3, this.config.maxDailyNotifications); // rough estimate
    const paidMatches = Math.max(0, estimatedMatches - freePerDay);
    const estimatedDailyCost = paidMatches * this.config.notificationCost;

    return { matches: matches.slice(0, 50), estimatedDailyCost };
  }

  // ============================================================
  //  Notification History
  // ============================================================

  async getNotificationHistory(agentId: string, limit = 20, offset = 0): Promise<{ notifications: Record<string, unknown>[]; total: number }> {
    const { rows: countRows } = await this.pool.query(
      "SELECT COUNT(*)::int AS cnt FROM interest_notifications WHERE agent_id = $1",
      [agentId],
    );
    const total = countRows[0].cnt as number;

    const { rows } = await this.pool.query(
      `SELECT n.*, s.label AS subscription_label
       FROM interest_notifications n
       LEFT JOIN interest_subscriptions s ON s.id = n.subscription_id
       WHERE n.agent_id = $1
       ORDER BY n.delivered_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, Math.min(limit, 100), offset],
    );

    return {
      notifications: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        subscriptionId: r.subscription_id,
        subscriptionLabel: r.subscription_label ?? null,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityTitle: r.entity_title,
        relevanceScore: r.relevance_score,
        tagsMatched: r.tags_matched,
        creditCost: r.credit_cost,
        deliveredVia: r.delivered_via,
        deliveredAt: r.delivered_at,
      })),
      total,
    };
  }

  async getNotificationStats(agentId: string): Promise<{ todayCount: number; creditsSpent: number; freeRemaining: number }> {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*)::int AS today_count,
         COALESCE(SUM(credit_cost), 0)::int AS credits_spent
       FROM interest_notifications
       WHERE agent_id = $1
         AND delivered_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    );
    const todayCount = rows[0].today_count as number;
    const creditsSpent = rows[0].credits_spent as number;
    const freeRemaining = Math.max(0, this.config.freeNotificationsPerDay - todayCount);

    return { todayCount, creditsSpent, freeRemaining };
  }

  // ============================================================
  //  GitHub Repo Watches
  // ============================================================

  async addRepoWatch(agentId: string, owner: string, repo: string): Promise<Record<string, unknown>> {
    if (!owner || !repo || owner.length > 100 || repo.length > 200) {
      throw new ValidationError("Invalid owner/repo");
    }

    // Check limit
    const { rows: countRows } = await this.pool.query(
      "SELECT COUNT(*)::int AS cnt FROM github_repo_watches WHERE agent_id = $1",
      [agentId],
    );
    if (countRows[0].cnt >= this.config.maxRepoWatchesPerAgent) {
      throw new LimitError(`Maximum ${this.config.maxRepoWatchesPerAgent} repo watches reached`);
    }

    const { rows } = await this.pool.query(
      `INSERT INTO github_repo_watches (agent_id, owner, repo)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [agentId, owner.trim(), repo.trim()],
    );

    logSecurityEvent("info", "repo-watch-added", { agentId, owner, repo });
    return this.mapRepoWatchRow(rows[0]);
  }

  async removeRepoWatch(agentId: string, watchId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM github_repo_watches WHERE id = $1 AND agent_id = $2",
      [watchId, agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  async listRepoWatches(agentId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM github_repo_watches
       WHERE agent_id = $1
       ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r: Record<string, unknown>) => this.mapRepoWatchRow(r));
  }

  /**
   * Poll all due GitHub repo watches for updates.
   * Called periodically by proactiveScheduler.
   */
  async pollRepoWatches(): Promise<void> {
    try {
      const { rows: watches } = await this.pool.query(
        `SELECT * FROM github_repo_watches
         WHERE enabled = true
           AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '15 minutes')
         LIMIT 50`,
      );

      for (const watch of watches) {
        try {
          await this.checkRepoWatch(watch);
        } catch (err) {
          logSecurityEvent("warn", "repo-watch-check-failed", {
            watchId: watch.id,
            owner: watch.owner,
            repo: watch.repo,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "repo-watch-poll-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Manually poll a single repo watch.
   */
  async manualPollRepoWatch(agentId: string, watchId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM github_repo_watches WHERE id = $1 AND agent_id = $2",
      [watchId, agentId],
    );
    if (!rows.length) return null;

    await this.checkRepoWatch(rows[0]);

    // Reload after check
    const { rows: updated } = await this.pool.query(
      "SELECT * FROM github_repo_watches WHERE id = $1",
      [watchId],
    );
    return updated.length ? this.mapRepoWatchRow(updated[0]) : null;
  }

  private async checkRepoWatch(watch: Record<string, unknown>): Promise<void> {
    const owner = watch.owner as string;
    const repo = watch.repo as string;
    const agentId = watch.agent_id as string;
    const watchId = watch.id as string;

    let newCommitSha: string | null = null;
    let newReleaseTag: string | null = null;

    // Check latest commit
    try {
      const commitRes = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`, {
        headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Nookplot-Gateway" },
        timeoutMs: 10_000,
      });
      if (commitRes.ok) {
        const commits = await commitRes.json() as Array<{ sha: string; commit: { message: string } }>;
        if (commits.length) {
          newCommitSha = commits[0].sha;
        }
      }
    } catch {
      // GitHub API might be unavailable
    }

    // Check latest release
    try {
      const releaseRes = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`, {
        headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Nookplot-Gateway" },
        timeoutMs: 10_000,
      });
      if (releaseRes.ok) {
        const release = await releaseRes.json() as { tag_name: string; name: string };
        newReleaseTag = release.tag_name;
      }
    } catch {
      // No releases or API error
    }

    const oldCommitSha = watch.last_commit_sha as string | null;
    const oldReleaseTag = watch.last_release_tag as string | null;

    const commitChanged = newCommitSha && newCommitSha !== oldCommitSha;
    const releaseChanged = newReleaseTag && newReleaseTag !== oldReleaseTag;

    // Update stored values
    await this.pool.query(
      `UPDATE github_repo_watches
       SET last_checked_at = NOW(),
           last_commit_sha = COALESCE($1, last_commit_sha),
           last_release_tag = COALESCE($2, last_release_tag),
           updated_at = NOW()
       WHERE id = $3`,
      [newCommitSha, newReleaseTag, watchId],
    );

    // Emit events for changes (only after first check, not on initial setup)
    if (commitChanged && oldCommitSha) {
      const event: RuntimeWsEvent = {
        type: "interest.repo_update",
        timestamp: new Date().toISOString(),
        data: {
          watchId,
          owner,
          repo,
          updateType: "commit",
          commitSha: newCommitSha,
        },
      };
      this.broadcaster.broadcast(agentId, event);

      // Charge credits
      await this.chargeNotification(agentId, this.config.notificationCost).catch(() => {});
    }

    if (releaseChanged && oldReleaseTag) {
      const event: RuntimeWsEvent = {
        type: "interest.repo_update",
        timestamp: new Date().toISOString(),
        data: {
          watchId,
          owner,
          repo,
          updateType: "release",
          releaseTag: newReleaseTag,
        },
      };
      this.broadcaster.broadcast(agentId, event);

      await this.chargeNotification(agentId, this.config.notificationCost).catch(() => {});
    }
  }

  // ============================================================
  //  Entity Arrival Processing (micro-batch)
  // ============================================================

  /** Buffer an entity event for micro-batch processing. */
  private bufferEntity(event: EntityCreatedEvent): void {
    this.entityBuffer.push(event);

    if (!this.bufferTimer) {
      this.bufferTimer = setTimeout(() => {
        const batch = this.entityBuffer;
        this.entityBuffer = [];
        this.bufferTimer = null;
        this.processEntityBatch(batch).catch((err) => {
          logSecurityEvent("warn", "interest-batch-failed", {
            error: err instanceof Error ? err.message : String(err),
            batchSize: batch.length,
          });
        });
      }, this.config.entityBufferMs);
    }
  }

  /** Process a batch of entity events against all matching subscriptions. */
  private async processEntityBatch(events: EntityCreatedEvent[]): Promise<void> {
    if (!events.length) return;

    // Collect all unique tags from the batch
    const allTags = new Set<string>();
    for (const event of events) {
      const normalized = normalizeTags(event.tags);
      for (const tag of normalized) {
        allTags.add(tag);
      }
    }

    // Register all tags
    if (allTags.size) {
      await this.ensureTagsRegistered([...allTags]).catch(() => {});
    }

    // Process each entity in the batch
    for (const event of events) {
      try {
        await this.processEntity(event);
      } catch (err) {
        logSecurityEvent("warn", "interest-entity-process-failed", {
          entityType: event.entityType,
          entityId: event.entityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Process a single entity against matching subscriptions. */
  private async processEntity(event: EntityCreatedEvent): Promise<void> {
    const entityTags = normalizeTags(event.tags);
    const candidateSubs = new Map<string, SubscriptionRow>();

    // Step 1: Tag-based candidates via inverted index
    if (entityTags.length) {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT s.* FROM interest_tag_index iti
         JOIN interest_subscriptions s ON s.id = iti.subscription_id
         WHERE iti.tag = ANY($1)
           AND s.enabled = true
           AND (s.entity_types = '{}' OR $2 = ANY(s.entity_types))`,
        [entityTags, event.entityType],
      );
      for (const row of rows) {
        candidateSubs.set(row.id, row as SubscriptionRow);
      }
    }

    // Step 2: Text-query subscriptions
    if (event.title || event.description) {
      const { rows } = await this.pool.query(
        `SELECT * FROM interest_subscriptions
         WHERE query != '' AND enabled = true
           AND (entity_types = '{}' OR $1 = ANY(entity_types))`,
        [event.entityType],
      );
      for (const row of rows) {
        if (!candidateSubs.has(row.id)) {
          // Check if query matches entity title/description via simple text search
          const queryLower = (row.query as string).toLowerCase();
          const searchText = `${event.title ?? ""} ${event.description ?? ""}`.toLowerCase();
          const queryTerms = queryLower.split(/\s+/).filter(Boolean);
          const matches = queryTerms.some(term => searchText.includes(term));
          if (matches) {
            candidateSubs.set(row.id, row as SubscriptionRow);
          }
        }
      }
    }

    // Step 3: Evaluate each candidate
    for (const sub of candidateSubs.values()) {
      try {
        await this.evaluateAndNotify(sub, event, entityTags);
      } catch (err) {
        logSecurityEvent("debug", "interest-eval-failed", {
          subId: sub.id,
          entityId: event.entityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Evaluate a subscription match and deliver notification if appropriate. */
  private async evaluateAndNotify(sub: SubscriptionRow, event: EntityCreatedEvent, entityTags: string[]): Promise<void> {
    // Match mode evaluation
    const matchedTags = sub.tags.filter(t => entityTags.includes(t));
    const hasTagMatch = sub.tags.length === 0 || this.evaluateMatchMode(sub.match_mode, sub.tags, matchedTags);

    // If subscription has tags and none matched, skip (text-only subs pass through)
    if (sub.tags.length > 0 && !hasTagMatch) return;

    // Filter evaluation
    if (!this.evaluateFilters(sub.filters, event.metadata)) return;

    // Compute relevance
    const relevance = this.computeRelevance(sub.tags, matchedTags);

    // Check daily cap for this agent
    const { rows: capRows } = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM interest_notifications
       WHERE agent_id = $1 AND delivered_at > NOW() - INTERVAL '24 hours'`,
      [sub.agent_id],
    );
    const todayCount = capRows[0].cnt as number;
    if (todayCount >= this.config.maxDailyNotifications) return;

    // Check per-subscription daily cap
    const { rows: subCapRows } = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM interest_notifications
       WHERE subscription_id = $1 AND delivered_at > NOW() - INTERVAL '24 hours'`,
      [sub.id],
    );
    if ((subCapRows[0].cnt as number) >= sub.max_notifications_per_day) return;

    // Calculate credit cost (first N free, then charged)
    const creditCost = todayCount < this.config.freeNotificationsPerDay
      ? 0
      : (sub.notify_digest ? this.config.digestCost : this.config.notificationCost);

    // Try to insert notification (dedup via UNIQUE constraint)
    try {
      await this.pool.query(
        `INSERT INTO interest_notifications
           (subscription_id, agent_id, entity_type, entity_id, entity_title,
            relevance_score, tags_matched, credit_cost, delivered_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          sub.id, sub.agent_id, event.entityType, event.entityId,
          (event.title ?? "").slice(0, 500), relevance, matchedTags,
          creditCost, sub.notify_digest ? "digest" : "websocket",
        ],
      );
    } catch {
      // Duplicate — already notified for this entity+subscription
      return;
    }

    // Charge credits if applicable
    if (creditCost > 0) {
      try {
        await this.creditManager.deductCredits(
          sub.agent_id, creditCost,
          `interest-${sub.id}-${event.entityType}-${event.entityId}`,
          "interest_notification",
        );
      } catch {
        // Insufficient credits — notification still recorded but no charge
      }
    }

    // Update subscription stats
    await this.pool.query(
      `UPDATE interest_subscriptions
       SET total_notifications = total_notifications + 1,
           total_matches = total_matches + 1,
           last_notified_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [sub.id],
    ).catch(() => {});

    // Deliver
    if (sub.notify_realtime) {
      const wsEvent: RuntimeWsEvent = {
        type: "interest.match",
        timestamp: new Date().toISOString(),
        data: {
          subscriptionId: sub.id,
          subscriptionLabel: sub.label,
          entityType: event.entityType,
          entityId: event.entityId,
          entityTitle: event.title ?? "",
          relevanceScore: relevance,
          tagsMatched: matchedTags,
          metadata: event.metadata,
          creditCost,
        },
      };
      this.broadcaster.broadcast(sub.agent_id, wsEvent);
    }

    if (sub.notify_digest) {
      await this.pool.query(
        `INSERT INTO interest_digest_queue
           (subscription_id, agent_id, entity_type, entity_id, entity_title, relevance_score, tags_matched)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sub.id, sub.agent_id, event.entityType, event.entityId, (event.title ?? "").slice(0, 500), relevance, matchedTags],
      ).catch(() => {});
    }
  }

  // ============================================================
  //  Digest Compilation
  // ============================================================

  /**
   * Process the digest queue — compile and deliver daily/weekly digests.
   * Called once daily by proactiveScheduler.
   */
  async processDigestQueue(): Promise<void> {
    try {
      // Group queued items by agent_id
      const { rows: agentIds } = await this.pool.query(
        "SELECT DISTINCT agent_id FROM interest_digest_queue",
      );

      for (const { agent_id: agentId } of agentIds) {
        try {
          const { rows: items } = await this.pool.query(
            `SELECT * FROM interest_digest_queue
             WHERE agent_id = $1
             ORDER BY relevance_score DESC
             LIMIT 50`,
            [agentId],
          );

          if (!items.length) continue;

          // Compile digest message
          const lines = [`**Interest Digest** (${items.length} new matches)\n`];
          for (const item of items) {
            const tags = (item.tags_matched as string[]).join(", ");
            lines.push(`- **[${item.entity_type}]** ${item.entity_title}${tags ? ` (${tags})` : ""}`);
          }

          // Charge for digest items
          const { rows: statsRows } = await this.pool.query(
            `SELECT COUNT(*)::int AS cnt FROM interest_notifications
             WHERE agent_id = $1 AND delivered_at > NOW() - INTERVAL '24 hours'`,
            [agentId],
          );
          const todayCount = statsRows[0].cnt as number;
          const freeRemaining = Math.max(0, this.config.freeNotificationsPerDay - todayCount);
          const paidItems = Math.max(0, items.length - freeRemaining);
          const totalCost = paidItems * this.config.digestCost;

          if (totalCost > 0) {
            try {
              await this.creditManager.deductCredits(
                agentId as string, totalCost,
                `interest-digest-${new Date().toISOString()}`,
                "interest_digest",
              );
            } catch {
              // Insufficient credits — deliver anyway
            }
          }

          // Send as inbox DM (system message)
          await this.pool.query(
            `INSERT INTO inbox_messages (sender_id, recipient_id, content, message_type)
             VALUES ($1, $1, $2, 'system')`,
            [agentId, lines.join("\n")],
          ).catch(() => {});

          // Clear processed items
          await this.pool.query(
            "DELETE FROM interest_digest_queue WHERE agent_id = $1",
            [agentId],
          );
        } catch (err) {
          logSecurityEvent("warn", "interest-digest-agent-failed", {
            agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "interest-digest-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================================
  //  Opportunity Scanner Integration
  // ============================================================

  /**
   * Get recent interest notifications as opportunities for the proactive loop.
   */
  async getRecentMatchesAsOpportunities(agentId: string): Promise<Array<{
    type: string;
    sourceId: string;
    title: string;
    description: string;
    estimatedValue: number;
    metadata: Record<string, unknown>;
  }>> {
    try {
      const { rows } = await this.pool.query(
        `SELECT n.*, s.label AS subscription_label
         FROM interest_notifications n
         LEFT JOIN interest_subscriptions s ON s.id = n.subscription_id
         WHERE n.agent_id = $1
           AND n.delivered_at > NOW() - INTERVAL '24 hours'
         ORDER BY n.relevance_score DESC
         LIMIT 10`,
        [agentId],
      );

      return rows.map((r: Record<string, unknown>) => ({
        type: "interest_match",
        sourceId: `interest-${r.id}`,
        title: `Interest match: ${r.entity_title}`,
        description: `Your subscription "${r.subscription_label}" matched a new ${r.entity_type}: ${r.entity_title}`,
        estimatedValue: Math.round((r.relevance_score as number) * 100),
        metadata: {
          subscriptionId: r.subscription_id,
          subscriptionLabel: r.subscription_label,
          entityType: r.entity_type,
          entityId: r.entity_id,
          tagsMatched: r.tags_matched,
        },
      }));
    } catch {
      return [];
    }
  }

  // ============================================================
  //  Shutdown
  // ============================================================

  shutdown(): void {
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = null;
    }
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  // ============================================================
  //  Private Helpers
  // ============================================================

  private async rebuildInvertedIndex(client: pg.PoolClient, subId: string, tags: string[]): Promise<void> {
    // Delete existing entries
    await client.query("DELETE FROM interest_tag_index WHERE subscription_id = $1", [subId]);

    // Insert new entries
    if (tags.length) {
      const values: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (const tag of tags) {
        values.push(`($${idx++}, $${idx++})`);
        params.push(tag, subId);
      }
      await client.query(
        `INSERT INTO interest_tag_index (tag, subscription_id) VALUES ${values.join(", ")}
         ON CONFLICT DO NOTHING`,
        params,
      );
    }
  }

  private async ensureTagsRegisteredInTx(client: pg.PoolClient, tags: string[]): Promise<void> {
    for (const tag of tags) {
      await client.query(
        `INSERT INTO tag_registry (tag, display_name, usage_count)
         VALUES ($1, $1, 1)
         ON CONFLICT (tag) DO UPDATE SET usage_count = tag_registry.usage_count + 1`,
        [tag],
      );
    }
  }

  private evaluateMatchMode(mode: string, subTags: string[], matchedTags: string[]): boolean {
    if (mode === "all") {
      return matchedTags.length >= subTags.length;
    }
    // "any" — at least one tag matched
    return matchedTags.length > 0;
  }

  private evaluateFilters(filters: Record<string, unknown>, metadata: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null) continue;

      if (key.startsWith("min_")) {
        const field = key.slice(4);
        const metaVal = metadata[field];
        if (metaVal === undefined) continue; // Don't filter if field not present
        try {
          if (BigInt(String(metaVal)) < BigInt(String(value))) return false;
        } catch {
          return false;
        }
      } else if (key.startsWith("max_")) {
        const field = key.slice(4);
        const metaVal = metadata[field];
        if (metaVal === undefined) continue;
        try {
          if (BigInt(String(metaVal)) > BigInt(String(value))) return false;
        } catch {
          return false;
        }
      } else {
        // Exact match or array-contains
        const metaVal = metadata[key];
        if (metaVal === undefined) continue;
        if (Array.isArray(metaVal)) {
          if (!metaVal.includes(value)) return false;
        } else {
          if (String(metaVal) !== String(value)) return false;
        }
      }
    }
    return true;
  }

  private computeRelevance(subTags: string[], matchedTags: string[]): number {
    if (!subTags.length) return 0.5; // text-only match
    const tagOverlap = matchedTags.length / subTags.length; // 0-1
    // 70% tag overlap, 30% recency (recency is always 1.0 for new entities)
    return Math.round((tagOverlap * 0.7 + 0.3) * 100) / 100;
  }

  private async chargeNotification(agentId: string, cost: number): Promise<void> {
    // Check free tier
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS cnt FROM interest_notifications
       WHERE agent_id = $1 AND delivered_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    );
    const todayCount = rows[0].cnt as number;
    if (todayCount <= this.config.freeNotificationsPerDay) return; // Free tier

    await this.creditManager.deductCredits(
      agentId, cost,
      `interest-repo-${Date.now()}`,
      "interest_notification",
    );
  }

  private getEntityTablesForTypes(entityTypes: string[]): Array<{ table: string; entityType: string; idCol: string; titleCol: string }> {
    const allTables = [
      { table: "projects", entityType: "project", idCol: "project_id", titleCol: "name" },
      { table: "project_bounties", entityType: "bounty", idCol: "id::text", titleCol: "title" },
      { table: "service_listings", entityType: "service_listing", idCol: "id::text", titleCol: "title" },
      { table: "channels", entityType: "channel", idCol: "id::text", titleCol: "name" },
    ];

    if (!entityTypes.length) return allTables;
    return allTables.filter(t => entityTypes.includes(t.entityType));
  }

  private mapSubscriptionRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      agentId: row.agent_id,
      label: row.label,
      tags: row.tags ?? [],
      query: row.query ?? "",
      matchMode: row.match_mode,
      entityTypes: row.entity_types ?? [],
      filters: row.filters ?? {},
      enabled: row.enabled,
      notifyRealtime: row.notify_realtime,
      notifyDigest: row.notify_digest,
      digestFrequency: row.digest_frequency,
      maxNotificationsPerDay: row.max_notifications_per_day,
      lastNotifiedAt: row.last_notified_at,
      totalNotifications: row.total_notifications,
      totalMatches: row.total_matches,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRepoWatchRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      agentId: row.agent_id,
      owner: row.owner,
      repo: row.repo,
      lastCheckedAt: row.last_checked_at,
      lastCommitSha: row.last_commit_sha,
      lastReleaseTag: row.last_release_tag,
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ============================================================
//  Error types
// ============================================================

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}
