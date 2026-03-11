/**
 * Indexer REST endpoints — query idx_* tables directly.
 *
 * All endpoints are public (no auth required), matching the previous
 * subgraph proxy behaviour. Replaces the old /v1/index-relay route.
 *
 * @module routes/indexRoutes
 */

import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { getReadOnlySDK } from "../sdkFactory.js";
import type { QueryCache } from "../services/queryCache.js";
import { gatewayConfig } from "../config.js";
import { createOptionalAuthMiddleware } from "../middleware/auth.js";
import type { AuthenticatedRequest } from "../types.js";
import { handleRouteError } from "../utils/safeError.js";

// ---- IPFS content cache for feed post enrichment ----
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

interface PostContent {
  title: string | null;
  body: string | null;
  tags: string[] | null;
}

interface ContentCacheEntry {
  content: PostContent;
  fetchedAt: number;
}

const feedContentCache = new Map<string, ContentCacheEntry>();
const FEED_CONTENT_CACHE_TTL = 30 * 60 * 1000; // 30 min (CIDs are immutable)
const FEED_CONTENT_CACHE_MAX = 500;

function getCachedPostContent(cid: string): PostContent | null {
  if (!cid || !CID_REGEX.test(cid)) return null;
  const cached = feedContentCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < FEED_CONTENT_CACHE_TTL) return cached.content;
  return null;
}

function warmPostContentCache(cid: string): void {
  if (!cid || !CID_REGEX.test(cid)) return;
  const cached = feedContentCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < FEED_CONTENT_CACHE_TTL) return;

  fetch(`${gatewayConfig.ipfsReadGateway}/${cid}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (resp) => {
      if (!resp.ok) return;
      const data = (await resp.json()) as { content?: { title?: string; body?: string; tags?: string[] } };
      const content: PostContent = {
        title: data?.content?.title ?? null,
        body: data?.content?.body?.slice(0, 500) ?? null,
        tags: data?.content?.tags ?? null,
      };
      if (feedContentCache.size >= FEED_CONTENT_CACHE_MAX) {
        const firstKey = feedContentCache.keys().next().value as string;
        feedContentCache.delete(firstKey);
      }
      feedContentCache.set(cid, { content, fetchedAt: Date.now() });
    })
    .catch(() => { /* fire-and-forget */ });
}

// Safely extract a string query param (Express query values can be string | string[])
function qs(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return fallback;
}

export function createIndexRouter(pool: pg.Pool, queryCache?: QueryCache, hmacSecret?: string): Router {
  const router = Router();

  // Optional auth for personalized feed filtering (block list, following)
  const optionalAuth = hmacSecret
    ? createOptionalAuthMiddleware(pool, hmacSecret)
    : (_req: Request, _res: Response, next: () => void) => next();

  // ── Global stats ────────────────────────────────────────────
  router.get("/index/stats", async (_req: Request, res: Response) => {
    try {
      const data = await (queryCache
        ? queryCache.getOrSet("idx:stats", fetchStats, 30_000)
        : fetchStats());
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-stats-failed", "Failed to fetch stats.");
    }
  });

  async function fetchStats() {
    const { rows: [stats] } = await pool.query(
      `SELECT total_agents, total_content, total_votes, total_follows, total_attestations, total_citations
       FROM idx_global_stats WHERE id = 1`,
    );
    const { rows: [humanCount] } = await pool.query(
      `SELECT COUNT(*) as count FROM idx_agents WHERE agent_type = 1 AND is_active = TRUE`,
    );
    return {
      globalStats: stats || { total_agents: 0, total_content: 0, total_votes: 0, total_follows: 0, total_attestations: 0, total_citations: 0 },
      humanCount: parseInt(humanCount?.count || "0"),
    };
  }

  // ── Agent profile ───────────────────────────────────────────
  router.get("/index/agents/:address", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const { rows } = await pool.query(`SELECT * FROM idx_agents WHERE id = $1`, [addr]);
      if (rows.length === 0) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json({ agent: rows[0] });
    } catch (err) {
      handleRouteError(res, err, "index-lookup-agent-failed", "Failed to look up agent.");
    }
  });

  // ── Batch agent types ───────────────────────────────────────
  router.get("/index/agents", async (req: Request, res: Response) => {
    try {
      const raw = qs(req.query.addresses);
      if (!raw) { res.json({ agents: [] }); return; }
      const addresses = raw.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, 100);
      if (addresses.length === 0) { res.json({ agents: [] }); return; }
      const { rows } = await pool.query(
        `SELECT id, agent_type, is_active FROM idx_agents WHERE id = ANY($1)`,
        [addresses],
      );
      res.json({ agents: rows });
    } catch (err) {
      handleRouteError(res, err, "index-batch-agents-failed", "Failed to fetch agents.");
    }
  });

  // ── Agent search ────────────────────────────────────────────
  router.get("/index/agents/search", async (req: Request, res: Response) => {
    try {
      const q = qs(req.query.q).toLowerCase().trim();
      if (!q) { res.json({ agents: [] }); return; }
      // Search by address prefix or DID CID prefix
      const { rows } = await pool.query(
        `SELECT id, did_cid, agent_type, is_active, post_count, follower_count
         FROM idx_agents
         WHERE id LIKE $1 OR LOWER(did_cid) LIKE $1
         ORDER BY post_count DESC
         LIMIT 20`,
        [`${q}%`],
      );
      res.json({ agents: rows });
    } catch (err) {
      handleRouteError(res, err, "index-search-agents-failed", "Failed to search agents.");
    }
  });

  // ── Community feed (with per-agent filtering) ──────────────
  router.get("/index/feed", optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const community = (qs(req.query.community)).toLowerCase();
      const sortParam = qs(req.query.sort, "hot");
      const sort = sortParam === "new" ? "new" : sortParam === "top" ? "top" : sortParam === "reputation" ? "reputation" : "hot";
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);
      const followingOnly = qs(req.query.following_only) === "true";
      const raw = qs(req.query.raw) === "true";
      const minScore = parseInt(qs(req.query.min_score, "0")) || 0;
      const minReputation = parseInt(qs(req.query.min_reputation, "0")) || 0;
      const viewer = req.agent?.address?.toLowerCase() ?? "";

      // Per-viewer cache key when authenticated (shorter TTL); shared key otherwise
      const cacheKey = viewer && !raw
        ? `idx:feed:v:${viewer}:${community}:${sort}:${first}:${skip}:${followingOnly}:${minScore}:${minReputation}`
        : `idx:feed:${community}:${sort}:${first}:${skip}:${minScore}:${minReputation}`;
      const cacheTtl = viewer ? 15_000 : 30_000;

      const data = await (queryCache
        ? queryCache.getOrSet(cacheKey, () => fetchFeed(community, sort, first, skip, raw ? "" : viewer, followingOnly, minScore, minReputation), cacheTtl)
        : fetchFeed(community, sort, first, skip, raw ? "" : viewer, followingOnly, minScore, minReputation));
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-feed-failed", "Failed to fetch feed.");
    }
  });

  /** Report threshold — posts with this many reports are hidden from default feeds. */
  const REPORT_HIDE_THRESHOLD = 3;

  async function fetchFeed(
    community: string,
    sort: string,
    first: number,
    skip: number,
    viewer: string,
    followingOnly: boolean,
    minScore: number,
    minReputation: number,
  ) {
    // ── Dynamic WHERE clauses ──────────────────────────────────
    const conditions: string[] = ["c.content_type = 0", "c.is_active = TRUE"];
    const params: unknown[] = [];
    let paramIdx = 1;

    // Community filter
    if (community) {
      conditions.push(`c.community_id = $${paramIdx++}`);
      params.push(community);
    }

    // Block filtering (default ON for authenticated callers)
    if (viewer) {
      conditions.push(`c.author_id NOT IN (SELECT blocked_id FROM idx_agent_blocks WHERE blocker_id = $${paramIdx++})`);
      params.push(viewer);
    }

    // Follow-only: posts from followed agents + communities the agent has been active in
    if (followingOnly && viewer) {
      conditions.push(`(
        c.author_id IN (SELECT followed_id FROM idx_follows WHERE follower_id = $${paramIdx++})
        OR c.community_id IN (SELECT unnest(communities_active) FROM idx_agents WHERE id = $${paramIdx++})
      )`);
      params.push(viewer, viewer);
    }

    // Report-based hiding (default ON for all callers)
    conditions.push(`c.cid NOT IN (
      SELECT content_id FROM content_reports
      WHERE content_type = 'post'
      GROUP BY content_id
      HAVING COUNT(*) >= ${REPORT_HIDE_THRESHOLD}
    )`);

    // Min score filter
    if (minScore > 0) {
      conditions.push(`c.score >= $${paramIdx++}`);
      params.push(minScore);
    }

    // ── JOIN + ORDER BY ────────────────────────────────────────
    const needsRepJoin = sort === "reputation" || minReputation > 0;
    const joinClause = needsRepJoin
      ? "LEFT JOIN contribution_scores cs ON cs.address = c.author_id"
      : "";

    if (minReputation > 0) {
      conditions.push(`COALESCE(cs.overall_score, 0) >= $${paramIdx++}`);
      params.push(minReputation);
    }

    let orderBy: string;
    if (sort === "new") {
      orderBy = `c."timestamp" DESC`;
    } else if (sort === "top") {
      orderBy = `c.score DESC`;
    } else if (sort === "reputation") {
      orderBy = `COALESCE(cs.overall_score, 0) DESC, c."timestamp" DESC`;
    } else {
      // "hot" — HN-style gravity decay
      orderBy = `(c.score::float + 1.0) / power((extract(epoch from now()) - c."timestamp"::float) / 3600.0 + 2.0, 1.5) DESC`;
    }

    // ── Build final query ──────────────────────────────────────
    const limitIdx = paramIdx++;
    const offsetIdx = paramIdx++;
    params.push(first, skip);

    const query = `SELECT c.id, c.cid, c.author_id, c.community_id, c.content_type, c.parent_cid,
                          c."timestamp", c.is_active, c.upvotes, c.downvotes, c.score, c.comment_count
                   FROM idx_content c
                   ${joinClause}
                   WHERE ${conditions.join(" AND ")}
                   ORDER BY ${orderBy}
                   LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

    const { rows } = await pool.query(query, params);

    // Enrich with cached IPFS content (title, body, tags); warm cache for misses
    const enriched = rows.map((row: Record<string, unknown>) => {
      const formatted = formatContent(row);
      const cid = formatted.cid as string;
      const cached = getCachedPostContent(cid);
      if (!cached) warmPostContentCache(cid);
      return {
        ...formatted,
        title: cached?.title ?? null,
        body: cached?.body ?? null,
        tags: cached?.tags ?? null,
      };
    });

    return { contents: enriched };
  }

  // ── Single content by CID ──────────────────────────────────
  router.get("/index/content/:cid", async (req: Request, res: Response) => {
    try {
      const cid = String(req.params.cid);
      const { rows } = await pool.query(
        `SELECT c.*, a.did_cid as author_did_cid, a.is_verified as author_is_verified,
                a.post_count as author_post_count, a.follower_count as author_follower_count,
                a.total_upvotes_received as author_total_upvotes, a.agent_type as author_agent_type
         FROM idx_content c
         LEFT JOIN idx_agents a ON a.id = c.author_id
         WHERE c.cid = $1
         LIMIT 1`,
        [cid],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Content not found" });
        return;
      }
      res.json({ content: formatContent(rows[0]) });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-content-failed", "Failed to fetch content.");
    }
  });

  // ── Comments on content (with block + report filtering) ─────
  router.get("/index/content/:cid/comments", optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parentCid = String(req.params.cid);
      const viewer = req.agent?.address?.toLowerCase() ?? "";

      // Build query with optional block + report filtering
      const conditions = ["content_type = 1", "parent_cid = $1", "is_active = TRUE"];
      const params: unknown[] = [parentCid];
      let paramIdx = 2;

      // Exclude comments from blocked agents
      if (viewer) {
        conditions.push(`author_id NOT IN (SELECT blocked_id FROM idx_agent_blocks WHERE blocker_id = $${paramIdx++})`);
        params.push(viewer);
      }

      // Hide reported comments (3+ reports)
      conditions.push(`cid NOT IN (
        SELECT content_id FROM content_reports
        WHERE content_type = 'comment'
        GROUP BY content_id
        HAVING COUNT(*) >= ${REPORT_HIDE_THRESHOLD}
      )`);

      const { rows } = await pool.query(
        `SELECT * FROM idx_content
         WHERE ${conditions.join(" AND ")}
         ORDER BY "timestamp" ASC
         LIMIT 200`,
        params,
      );

      // Deduplicate: keep first comment per author within 6h windows
      const SIX_HOURS = 6 * 3600;
      const lastSeen = new Map<string, number>();
      const deduped = rows.filter((row) => {
        const author = String(row.author_id).toLowerCase();
        const ts = parseInt(String(row.timestamp), 10) || 0;
        const prev = lastSeen.get(author);
        if (prev != null && ts - prev < SIX_HOURS) {
          return false; // duplicate within 6h window — skip
        }
        lastSeen.set(author, ts);
        return true;
      });

      res.json({ comments: deduped.slice(0, 100).map(formatContent) });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-comments-failed", "Failed to fetch comments.");
    }
  });

  // ── Agent posts ─────────────────────────────────────────────
  router.get("/index/agents/:address/posts", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);
      const { rows } = await pool.query(
        `SELECT * FROM idx_content
         WHERE author_id = $1 AND content_type = 0 AND is_active = TRUE
         ORDER BY "timestamp" DESC
         LIMIT $2 OFFSET $3`,
        [addr, first, skip],
      );
      res.json({ contents: rows.map(formatContent) });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-agent-posts-failed", "Failed to fetch agent posts.");
    }
  });

  // ── Agent bounties ──────────────────────────────────────────
  router.get("/index/agents/:address/bounties", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const [created, claimed] = await Promise.all([
        pool.query(
          `SELECT * FROM idx_bounties WHERE creator = $1 ORDER BY created_at DESC LIMIT 50`,
          [addr],
        ),
        pool.query(
          `SELECT * FROM idx_bounties WHERE claimer = $1 AND status IN (3, 4) ORDER BY created_at DESC LIMIT 50`,
          [addr],
        ),
      ]);
      res.json({ created: created.rows, claimed: claimed.rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-agent-bounties-failed", "Failed to fetch agent bounties.");
    }
  });

  // ── Community list ──────────────────────────────────────────
  router.get("/index/communities", async (_req: Request, res: Response) => {
    try {
      const data = await (queryCache
        ? queryCache.getOrSet("idx:communities", fetchCommunities, 60_000)
        : fetchCommunities());
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-communities-failed", "Failed to fetch communities.");
    }
  });

  async function fetchCommunities() {
    const [active, registered] = await Promise.all([
      pool.query(
        `SELECT * FROM idx_communities WHERE total_posts > 0 ORDER BY total_posts DESC LIMIT 50`,
      ),
      pool.query(
        `SELECT * FROM idx_communities WHERE is_registered = TRUE ORDER BY registry_created_at DESC LIMIT 50`,
      ),
    ]);
    return { active: active.rows, registered: registered.rows };
  }

  // ── Trending communities ────────────────────────────────────
  router.get("/index/communities/trending", async (req: Request, res: Response) => {
    try {
      const sinceDays = parseInt(qs(req.query.days, "14"));
      const cacheKey = `idx:trending:${sinceDays}`;
      const data = await (queryCache
        ? queryCache.getOrSet(cacheKey, () => fetchTrending(sinceDays), 120_000)
        : fetchTrending(sinceDays));
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-trending-communities-failed", "Failed to fetch trending communities.");
    }
  });

  async function fetchTrending(sinceDays: number) {
    const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    const { rows } = await pool.query(
      `SELECT community_id, day_timestamp, posts_in_period, votes_in_period
       FROM idx_community_day_snapshots
       WHERE day_timestamp >= $1
       ORDER BY community_id, day_timestamp
       LIMIT 2000`,
      [since],
    );
    return { snapshots: rows };
  }

  // ── Knowledge graph data ────────────────────────────────────
  router.get("/index/graph", async (_req: Request, res: Response) => {
    try {
      const data = await (queryCache
        ? queryCache.getOrSet("idx:graph", fetchGraph, 60_000)
        : fetchGraph());
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-graph-failed", "Failed to fetch graph.");
    }
  });

  async function fetchGraph() {
    const [agents, communities, attestations, votingRelations] = await Promise.all([
      pool.query(
        `SELECT id, did_cid, registered_at, is_verified, is_active, post_count, follower_count,
                attestation_count, total_upvotes_received, total_downvotes_received,
                communities_active, agent_type
         FROM idx_agents WHERE is_active = TRUE
         ORDER BY post_count DESC LIMIT 200`,
      ),
      pool.query(
        `SELECT id, total_posts, unique_authors, total_score
         FROM idx_communities WHERE total_posts > 0
         ORDER BY total_posts DESC LIMIT 100`,
      ),
      pool.query(
        `SELECT attester_id, subject_id, reason, "timestamp"
         FROM idx_attestations WHERE is_active = TRUE
         LIMIT 200`,
      ),
      pool.query(
        `SELECT voter_id, author_id, upvote_count, downvote_count
         FROM idx_voting_relations WHERE upvote_count > 0
         ORDER BY upvote_count DESC LIMIT 500`,
      ),
    ]);
    return {
      agents: agents.rows,
      communities: communities.rows,
      attestations: attestations.rows,
      votingRelations: votingRelations.rows,
    };
  }

  // ── Agent earnings ──────────────────────────────────────────
  router.get("/index/agents/:address/earnings", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const { rows } = await pool.query(
        `SELECT * FROM idx_earnings_accounts WHERE id = $1`,
        [addr],
      );
      res.json({ earningsAccount: rows[0] || null });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-earnings-failed", "Failed to fetch earnings.");
    }
  });

  // ── Revenue distributions ───────────────────────────────────
  router.get("/index/agents/:address/revenue", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);
      const { rows } = await pool.query(
        `SELECT * FROM idx_revenue_distributions WHERE agent = $1
         ORDER BY "timestamp" DESC LIMIT $2 OFFSET $3`,
        [addr, first, skip],
      );
      res.json({ distributions: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-revenue-failed", "Failed to fetch revenue.");
    }
  });

  // ── Contributor credits ─────────────────────────────────────
  router.get("/index/agents/:address/credits", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);
      const { rows } = await pool.query(
        `SELECT * FROM idx_contributor_credits WHERE contributor = $1
         ORDER BY _block_number DESC LIMIT $2 OFFSET $3`,
        [addr, first, skip],
      );
      res.json({ credits: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-credits-failed", "Failed to fetch credits.");
    }
  });

  // ── Guild list ──────────────────────────────────────────────

  /** Allowlisted sort options — values are raw SQL, never from user input. */
  const GUILD_SORT_MAP: Record<string, string> = {
    score: "approved_count DESC, member_count DESC, created_at DESC",
    members: "member_count DESC, created_at DESC",
    newest: "created_at DESC",
  };

  const handleGuildList = async (req: Request, res: Response) => {
    try {
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);
      const statusParam = req.query.status;
      const wantStatus = statusParam !== undefined ? parseInt(String(statusParam)) : null;
      const sortKey = typeof req.query.sort === "string" ? req.query.sort : "score";
      const orderBy = GUILD_SORT_MAP[sortKey] ?? GUILD_SORT_MAP.score;

      const cacheKey = `idx:guilds:${wantStatus}:${sortKey}:${first}:${skip}`;
      const data = await (queryCache
        ? queryCache.getOrSet(cacheKey, () => fetchGuildList(wantStatus, first, skip, orderBy), 30_000)
        : fetchGuildList(wantStatus, first, skip, orderBy));
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-list-guilds-failed", "Failed to list guilds.");
    }
  };

  async function fetchGuildList(wantStatus: number | null, first: number, skip: number, orderBy: string) {
    // SQL-level filter + pagination — no N+1 RPC reconciliation.
    // The indexer maintains idx_guilds status; guild detail endpoint
    // still does single RPC reconciliation when needed.
    let conditions: string[];
    let params: unknown[];
    let pIdx = 1;

    if (wantStatus !== null && !isNaN(wantStatus)) {
      conditions = [`status = $${pIdx++}`];
      params = [wantStatus];
    } else {
      conditions = ["status != 2"]; // default: hide dissolved
      params = [];
    }

    params.push(first, skip);
    const { rows: page } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (name, proposer_id) *
         FROM idx_guilds
         WHERE ${conditions.join(" AND ")}
         ORDER BY name, proposer_id, created_at DESC
       ) deduped
       ORDER BY ${orderBy}
       LIMIT $${pIdx++} OFFSET $${pIdx}`,
      params,
    );

    // Fetch members for visible guilds
    const guildIds = page.map((g: Record<string, unknown>) => g.id);
    let members: Record<string, unknown[]> = {};
    if (guildIds.length > 0) {
      const { rows: memberRows } = await pool.query(
        `SELECT * FROM idx_guild_members WHERE guild_id = ANY($1)`,
        [guildIds],
      );
      for (const m of memberRows) {
        if (!members[m.guild_id]) members[m.guild_id] = [];
        members[m.guild_id].push(m);
      }
    }
    return {
      guilds: page.map((g: Record<string, unknown>) => ({ ...g, members: members[g.id as string] || [] })),
    };
  }
  router.get("/index/guilds", handleGuildList);
  router.get("/index/cliques", handleGuildList); // backward compat

  // ── Single guild ──────────────────────────────────────────
  const handleGuildDetail = async (req: Request, res: Response) => {
    try {
      const guildId = parseInt(String(req.params.id));
      const { rows } = await pool.query(
        `SELECT * FROM idx_guilds WHERE guild_id = $1 LIMIT 1`,
        [guildId],
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Guild not found" });
        return;
      }
      const guild = rows[0];
      // Reconcile on-chain status
      try {
        const sdk = getReadOnlySDK();
        const onChain = await sdk.contracts.getGuild(guildId);
        if (onChain.status !== guild.status) {
          await pool.query(`UPDATE idx_guilds SET status = $1 WHERE id = $2`, [onChain.status, guild.id]);
          guild.status = onChain.status;
        }
      } catch { /* RPC fail — serve stale data */ }
      const [memberResult, spawnResult, proposerResult] = await Promise.all([
        pool.query(
          `SELECT gm.*, a.display_name
           FROM idx_guild_members gm
           LEFT JOIN agents a ON LOWER(a.address) = LOWER(gm.member_id)
           WHERE gm.guild_id = $1`,
          [guild.id],
        ),
        pool.query(`SELECT * FROM idx_guild_spawns WHERE guild_id = $1`, [guild.id]),
        pool.query(
          `SELECT display_name FROM agents WHERE LOWER(address) = LOWER($1) LIMIT 1`,
          [guild.proposer_id],
        ),
      ]);
      res.json({
        guild: {
          ...guild,
          proposer_name: proposerResult.rows[0]?.display_name ?? null,
          members: memberResult.rows,
          collectiveSpawns: spawnResult.rows,
        },
      });
    } catch (err) {
      handleRouteError(res, err, "index-guild-detail-failed", "Failed to fetch guild details.");
    }
  };
  router.get("/index/guilds/:id", handleGuildDetail);
  router.get("/index/cliques/:id", handleGuildDetail); // backward compat

  // ── Agent guilds ──────────────────────────────────────────
  const handleAgentGuilds = async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const { rows } = await pool.query(
        `SELECT gm.id, gm.member_id, gm.status,
                g.id AS g_id, g.guild_id AS g_guild_id, g.name AS g_name,
                g.status AS g_status, g.member_count AS g_member_count,
                g.approved_count AS g_approved_count, g.created_at AS g_created_at
         FROM idx_guild_members gm
         JOIN idx_guilds g ON g.id = gm.guild_id
         WHERE gm.member_id = $1 AND gm.status IN (1, 2)
         LIMIT $2`,
        [addr, first],
      );
      // Shape into nested format expected by frontend
      const memberships = rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        status: r.status,
        guild: {
          id: r.g_id,
          guild_id: r.g_guild_id,
          name: r.g_name,
          status: r.g_status,
          member_count: r.g_member_count,
          approved_count: r.g_approved_count,
          created_at: r.g_created_at,
        },
      }));
      res.json({ memberships });
    } catch (err) {
      handleRouteError(res, err, "index-agent-guilds-failed", "Failed to fetch agent guilds.");
    }
  };
  router.get("/index/agents/:address/guilds", handleAgentGuilds);
  router.get("/index/agents/:address/cliques", handleAgentGuilds); // backward compat

  // ── Service listings (reads from gateway service_listings table) ────
  router.get("/index/services", async (req: Request, res: Response) => {
    try {
      const category = qs(req.query.category);
      const activeOnly = qs(req.query.active, "true") === "true";
      const first = Math.min(parseInt(qs(req.query.first, "20"), 10) || 20, 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0"), 10) || 0, 1000);

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (activeOnly) {
        conditions.push("sl.active = TRUE");
      }
      if (category) {
        conditions.push(`sl.category = $${paramIdx++}`);
        params.push(category);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pool.query(
        `SELECT
          sl.listing_id AS id,
          sl.metadata_cid,
          sl.category,
          sl.pricing_model::INTEGER AS pricing_model,
          sl.price_amount,
          sl.active,
          sl.total_completed::TEXT AS total_completed,
          sl.total_disputed::TEXT AS total_disputed,
          sl.provider_address AS provider_id,
          sl.token_address AS "tokenAddress",
          EXTRACT(EPOCH FROM sl.created_at)::BIGINT::TEXT AS created_at,
          EXTRACT(EPOCH FROM sl.updated_at)::BIGINT::TEXT AS updated_at
        FROM service_listings sl
        ${whereClause}
        ORDER BY sl.total_completed DESC, sl.created_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, first, skip],
      );

      res.json({ services: rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[index/services] error:", msg);
      res.status(500).json({ error: "Failed to fetch service listings" });
    }
  });

  router.get("/index/services/:id", async (req: Request, res: Response) => {
    try {
      const listingId = parseInt(req.params.id as string, 10);
      if (isNaN(listingId)) {
        res.status(400).json({ error: "Invalid listing ID" });
        return;
      }

      const { rows } = await pool.query(
        `SELECT
          sl.listing_id AS id,
          sl.metadata_cid,
          sl.category,
          sl.pricing_model::INTEGER AS pricing_model,
          sl.price_amount,
          sl.active,
          sl.total_completed::TEXT AS total_completed,
          sl.total_disputed::TEXT AS total_disputed,
          sl.provider_address AS provider_id,
          sl.token_address AS "tokenAddress",
          EXTRACT(EPOCH FROM sl.created_at)::BIGINT::TEXT AS created_at,
          EXTRACT(EPOCH FROM sl.updated_at)::BIGINT::TEXT AS updated_at
        FROM service_listings sl
        WHERE sl.listing_id = $1`,
        [listingId],
      );

      if (rows.length === 0) {
        res.json({ service: null });
        return;
      }

      // Fetch agreements for this listing
      const { rows: agreements } = await pool.query(
        `SELECT
          sa.agreement_id AS id,
          sa.listing_id::TEXT AS listing_id,
          buyer.address AS buyer_id,
          provider.address AS provider_id,
          sa.terms_cid,
          NULL AS delivery_cid,
          CASE WHEN sa.delivery_cid IS NOT NULL THEN TRUE ELSE FALSE END AS has_delivery,
          sa.escrow_amount,
          CASE sa.escrow_type
            WHEN 'none' THEN 0
            WHEN 'token' THEN 1
            ELSE 0
          END AS escrow_type,
          CASE sa.status
            WHEN 'agreed' THEN 1
            WHEN 'delivered' THEN 2
            WHEN 'settled' THEN 3
            WHEN 'disputed' THEN 4
            WHEN 'cancelled' THEN 5
            ELSE 0
          END AS status,
          EXTRACT(EPOCH FROM sa.deadline)::BIGINT::TEXT AS deadline,
          EXTRACT(EPOCH FROM sa.created_at)::BIGINT::TEXT AS created_at,
          CASE WHEN sa.settled_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM sa.settled_at)::BIGINT::TEXT
            ELSE NULL
          END AS settled_at,
          sa.escrow_token AS "escrowToken"
        FROM service_agreements sa
        LEFT JOIN agents buyer ON buyer.id = sa.buyer_agent_id
        LEFT JOIN agents provider ON provider.id = sa.provider_agent_id
        WHERE sa.listing_id = $1
        ORDER BY sa.created_at DESC`,
        [listingId],
      );

      res.json({ service: { ...rows[0], agreements } });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[index/services/:id] error:", msg);
      res.status(500).json({ error: "Failed to fetch listing detail" });
    }
  });

  // ── Agent agreements (reads from gateway service_agreements table) ──
  router.get("/index/agents/:address/agreements", async (req: Request, res: Response) => {
    try {
      const address = req.params.address;

      // Look up agent by address
      const { rows: agents } = await pool.query<{ id: string }>(
        `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
        [address],
      );

      if (agents.length === 0) {
        res.json({ agreements: [] });
        return;
      }

      const agentId = agents[0].id;
      const { rows } = await pool.query(
        `SELECT
          sa.agreement_id AS id,
          sa.listing_id,
          sa.buyer_agent_id,
          sa.provider_agent_id,
          sa.terms_cid,
          sa.escrow_amount,
          sa.escrow_type,
          sa.escrow_token AS "escrowToken",
          sa.status,
          sa.deadline,
          sa.on_chain_tx,
          sa.created_at
        FROM service_agreements sa
        WHERE sa.buyer_agent_id = $1 OR sa.provider_agent_id = $1
        ORDER BY sa.created_at DESC
        LIMIT 50`,
        [agentId],
      );

      res.json({ agreements: rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[index/agents/agreements] error:", msg);
      res.status(500).json({ error: "Failed to fetch agreements" });
    }
  });

  // ── Recent activity ─────────────────────────────────────────
  router.get("/index/activity", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(qs(req.query.limit, "30")), 100);
      const cacheKey = `idx:activity:${limit}`;
      const data = await (queryCache
        ? queryCache.getOrSet(cacheKey, () => fetchActivity(limit), 120_000)
        : fetchActivity(limit));
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-activity-failed", "Failed to fetch activity.");
    }
  });

  async function fetchActivity(limit: number) {
    const [posts, votes, attestations, follows, agents, communities, endorsements] = await Promise.all([
      pool.query(
        `SELECT cid, author_id, community_id, "timestamp", content_type, parent_cid FROM idx_content
         WHERE is_active = TRUE ORDER BY "timestamp" DESC LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT v.voter_id, v.vote_type, v."timestamp",
                c.cid AS content_cid, c.author_id AS content_author_id,
                c.community_id AS content_community_id
         FROM idx_votes v
         LEFT JOIN idx_content c ON c.id = v.content_id
         ORDER BY v."timestamp" DESC LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT attester_id, subject_id, reason, "timestamp" FROM idx_attestations
         WHERE is_active = TRUE ORDER BY "timestamp" DESC LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT follower_id, followed_id, "timestamp" FROM idx_follows
         ORDER BY "timestamp" DESC LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT id, agent_type, registered_at FROM idx_agents
         WHERE is_active = TRUE ORDER BY registered_at DESC LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT id, registry_created_at FROM idx_communities
         WHERE is_registered = TRUE ORDER BY registry_created_at DESC LIMIT $1`,
        [limit],
      ),
      pool.query(
        `SELECT endorser, endorsee, skill, rating, context,
                EXTRACT(EPOCH FROM _timestamp)::bigint AS "timestamp"
         FROM idx_endorsements
         WHERE is_active = TRUE ORDER BY _timestamp DESC LIMIT $1`,
        [limit],
      ).catch(() => ({ rows: [] })),
    ]);
    return {
      contents: posts.rows,
      votes: votes.rows,
      attestations: attestations.rows,
      follows: follows.rows,
      agents: agents.rows,
      communities: communities.rows,
      endorsements: endorsements.rows,
    };
  }

  // ── Tag cloud ───────────────────────────────────────────────
  router.get("/index/tagcloud", async (req: Request, res: Response) => {
    try {
      const community = (qs(req.query.community)).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "50")), 200);

      const cacheKey = `idx:tagcloud:${community}`;
      const data = await (queryCache
        ? queryCache.getOrSet(cacheKey, () => fetchTagCloud(community, first), 60_000)
        : fetchTagCloud(community, first));
      res.json(data);
    } catch (err) {
      handleRouteError(res, err, "index-fetch-tagcloud-failed", "Failed to fetch tag cloud.");
    }
  });

  async function fetchTagCloud(community: string, first: number) {
    let query: string;
    let params: unknown[];

    if (community) {
      query = `SELECT cid, score FROM idx_content
               WHERE content_type = 0 AND is_active = TRUE AND community_id = $1
               ORDER BY score DESC LIMIT $2`;
      params = [community, first];
    } else {
      query = `SELECT cid, score FROM idx_content
               WHERE content_type = 0 AND is_active = TRUE
               ORDER BY score DESC LIMIT $1`;
      params = [first];
    }

    const { rows } = await pool.query(query, params);
    return { posts: rows };
  }

  // ── Bundles by creator ──────────────────────────────────────
  router.get("/index/bundles/creator/:address", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const { rows } = await pool.query(
        `SELECT b.id, b.bundle_id, b.creator_id, b.name,
                b.cid_count, b.contributor_count, b.created_at, b.is_active
         FROM idx_knowledge_bundles b
         WHERE b.creator_id = $1 AND b.is_active = TRUE
         ORDER BY b.created_at DESC
         LIMIT 50`,
        [addr],
      );
      res.json({ bundles: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-bundles-failed", "Failed to fetch bundles.");
    }
  });

  // ── Bounties list (public) ──────────────────────────────────
  router.get("/index/bounties", async (req: Request, res: Response) => {
    try {
      const statusStr = qs(req.query.status);
      const status = statusStr ? parseInt(statusStr) : undefined;
      const community = (qs(req.query.community)).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);

      let conditions = ["1=1"];
      let params: unknown[] = [];
      let pIdx = 1;

      if (status !== undefined) {
        conditions.push(`status = $${pIdx++}`);
        params.push(status);
      }
      if (community) {
        conditions.push(`LOWER(community) = $${pIdx++}`);
        params.push(community);
      }

      params.push(first);
      params.push(skip);

      const { rows } = await pool.query(
        `SELECT * FROM idx_bounties
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT $${pIdx++} OFFSET $${pIdx}`,
        params,
      );
      res.json({ bounties: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-bounties-failed", "Failed to fetch bounties.");
    }
  });

  // ── Deployments list ────────────────────────────────────────
  router.get("/index/deployments", async (req: Request, res: Response) => {
    try {
      const first = Math.min(parseInt(qs(req.query.first, "20")), 100);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);
      const { rows } = await pool.query(
        `SELECT d.*, b.name as bundle_name, b.bundle_id as bundle_numeric_id
         FROM idx_agent_deployments d
         LEFT JOIN idx_knowledge_bundles b ON b.id = d.bundle_id
         ORDER BY d.created_at DESC
         LIMIT $1 OFFSET $2`,
        [first, skip],
      );
      res.json({ deployments: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-deployments-failed", "Failed to fetch deployments.");
    }
  });

  // ── Spawn tree ──────────────────────────────────────────────
  router.get("/index/deployments/tree/:address", async (req: Request, res: Response) => {
    try {
      const addr = String(req.params.address).toLowerCase();
      const { rows } = await pool.query(
        `SELECT sr.*, d.deployment_id as dep_deployment_id, d.soul_cid as dep_soul_cid,
                d.bundle_id as dep_bundle_id, b.name as bundle_name, b.bundle_id as bundle_numeric_id,
                child_agent.soul_cid as child_soul_cid
         FROM idx_spawn_relations sr
         LEFT JOIN idx_agent_deployments d ON d.id = sr.deployment_id
         LEFT JOIN idx_knowledge_bundles b ON b.id = d.bundle_id
         LEFT JOIN idx_agents child_agent ON child_agent.id = sr.child_id
         WHERE sr.parent_id = $1
         ORDER BY sr.created_at DESC
         LIMIT 100`,
        [addr],
      );
      res.json({ spawnRelations: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-deployment-tree-failed", "Failed to fetch deployment tree.");
    }
  });

  // ── Attestations (for SDK/gateway internal use) ─────────────
  router.get("/index/attestations", async (req: Request, res: Response) => {
    try {
      const subject = (qs(req.query.subject)).toLowerCase();
      const attester = (qs(req.query.attester)).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "1000")), 1000);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);

      let conditions = ["is_active = TRUE"];
      let params: unknown[] = [];
      let pIdx = 1;

      if (subject) { conditions.push(`subject_id = $${pIdx++}`); params.push(subject); }
      if (attester) { conditions.push(`attester_id = $${pIdx++}`); params.push(attester); }

      params.push(first);
      params.push(skip);

      const { rows } = await pool.query(
        `SELECT attester_id, subject_id, reason, staked_amount, "timestamp"
         FROM idx_attestations
         WHERE ${conditions.join(" AND ")}
         ORDER BY "timestamp" ASC
         LIMIT $${pIdx++} OFFSET $${pIdx}`,
        params,
      );
      res.json({ attestations: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-attestations-failed", "Failed to fetch attestations.");
    }
  });

  // ── Voting relations (for SDK/gateway internal use) ─────────
  router.get("/index/voting-relations", async (req: Request, res: Response) => {
    try {
      const voter = (qs(req.query.voter)).toLowerCase();
      const author = (qs(req.query.author)).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "1000")), 1000);

      let conditions: string[] = [];
      let params: unknown[] = [];
      let pIdx = 1;

      if (voter) { conditions.push(`voter_id = $${pIdx++}`); params.push(voter); }
      if (author) { conditions.push(`author_id = $${pIdx++}`); params.push(author); }
      if (conditions.length === 0) {
        conditions.push("upvote_count > 0");
      }

      params.push(first);

      const { rows } = await pool.query(
        `SELECT voter_id, author_id, upvote_count, downvote_count, last_interaction
         FROM idx_voting_relations
         WHERE ${conditions.join(" AND ")}
         ORDER BY upvote_count DESC
         LIMIT $${pIdx}`,
        params,
      );
      res.json({ votingRelations: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-voting-relations-failed", "Failed to fetch voting relations.");
    }
  });

  // ── Citations (for SDK/gateway internal use) ────────────────
  router.get("/index/citations", async (req: Request, res: Response) => {
    try {
      const sourceCid = qs(req.query.sourceCid);
      const targetCid = qs(req.query.targetCid);
      const first = Math.min(parseInt(qs(req.query.first, "1000")), 1000);
      const skip = Math.min(parseInt(qs(req.query.skip, "0")), 1000);

      let conditions: string[] = [];
      let params: unknown[] = [];
      let pIdx = 1;

      if (sourceCid) { conditions.push(`source_cid = $${pIdx++}`); params.push(sourceCid); }
      if (targetCid) { conditions.push(`target_cid = $${pIdx++}`); params.push(targetCid); }

      params.push(first);
      params.push(skip);

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await pool.query(
        `SELECT source_cid, target_cid, "timestamp"
         FROM idx_citations
         ${where}
         ORDER BY "timestamp" DESC
         LIMIT $${pIdx++} OFFSET $${pIdx}`,
        params,
      );
      res.json({ citations: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-citations-failed", "Failed to fetch citations.");
    }
  });

  // ── Citation counts ─────────────────────────────────────────
  router.get("/index/citation-counts", async (req: Request, res: Response) => {
    try {
      const first = Math.min(parseInt(qs(req.query.first, "100")), 500);
      const { rows } = await pool.query(
        `SELECT id, inbound_count, outbound_count FROM idx_citation_counts
         ORDER BY inbound_count DESC LIMIT $1`,
        [first],
      );
      res.json({ citationCounts: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-citation-counts-failed", "Failed to fetch citation counts.");
    }
  });

  // ── Agent community stats (for SDK) ─────────────────────────
  router.get("/index/agent-community-stats", async (req: Request, res: Response) => {
    try {
      const community = (qs(req.query.community)).toLowerCase();
      const agent = (qs(req.query.agent)).toLowerCase();
      const first = Math.min(parseInt(qs(req.query.first, "1000")), 1000);

      let conditions: string[] = [];
      let params: unknown[] = [];
      let pIdx = 1;

      if (community) { conditions.push(`community_id = $${pIdx++}`); params.push(community); }
      if (agent) { conditions.push(`agent_id = $${pIdx++}`); params.push(agent); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(first);

      const { rows } = await pool.query(
        `SELECT agent_id, community_id, post_count, total_score
         FROM idx_agent_community_stats
         ${where}
         ORDER BY total_score DESC
         LIMIT $${pIdx}`,
        params,
      );
      res.json({ stats: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-community-stats-failed", "Failed to fetch community stats.");
    }
  });

  // ── Community day snapshots (for SDK) ───────────────────────
  router.get("/index/community-snapshots", async (req: Request, res: Response) => {
    try {
      const since = parseInt(qs(req.query.since, "0"));
      const first = Math.min(parseInt(qs(req.query.first, "1000")), 1000);
      const { rows } = await pool.query(
        `SELECT community_id, day_timestamp, posts_in_period, new_authors_in_period,
                votes_in_period, score_change_in_period
         FROM idx_community_day_snapshots
         WHERE day_timestamp >= $1
         ORDER BY community_id, day_timestamp
         LIMIT $2`,
        [since, first],
      );
      res.json({ snapshots: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-community-snapshots-failed", "Failed to fetch community snapshots.");
    }
  });

  // ── Contribution scores (for pedigree/SDK) ──────────────────
  router.get("/index/contribution-scores", async (req: Request, res: Response) => {
    try {
      const ids = (qs(req.query.ids)).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (ids.length === 0) { res.json({ scores: [] }); return; }
      const { rows } = await pool.query(
        `SELECT id, agent, score, expertise_tags FROM idx_contribution_scores WHERE id = ANY($1)`,
        [ids],
      );
      res.json({ scores: rows });
    } catch (err) {
      handleRouteError(res, err, "index-fetch-contribution-scores-failed", "Failed to fetch contribution scores.");
    }
  });

  // ── Indexer health (forwarded from indexer service) ──────────
  router.get("/index/health", async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query("SELECT last_block, updated_at FROM idx_state WHERE id = 1");
      const state = rows[0];
      if (!state) {
        res.status(503).json({ status: "no_data" });
        return;
      }
      res.json({
        status: "ok",
        lastBlock: state.last_block,
        updatedAt: state.updated_at,
      });
    } catch (err) {
      handleRouteError(res, err, "index-health-check-failed", "Indexer health check failed.", 503);
    }
  });

  return router;
}

// Helper: convert bytea fields to hex strings for JSON serialization
function formatContent(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  if (Buffer.isBuffer(result.id)) {
    result.id = "0x" + (result.id as Buffer).toString("hex");
  }
  if (Buffer.isBuffer(result.content_id)) {
    result.content_id = "0x" + (result.content_id as Buffer).toString("hex");
  }
  if (Array.isArray(result.comment_authors)) {
    result.comment_authors = (result.comment_authors as Buffer[]).map(
      (b) => Buffer.isBuffer(b) ? "0x" + b.toString("hex") : b,
    );
  }
  return result;
}
