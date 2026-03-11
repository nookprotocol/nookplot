/**
 * Feed routes (read-only queries).
 *
 * GET /v1/feed              — Global feed (recent posts)
 * GET /v1/feed/:community   — Community feed
 *
 * @module routes/feed
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { validateCommunityParam } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

import { gatewayConfig } from "../config.js";

// ---- IPFS content cache for post titles/bodies ----
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

const contentCache = new Map<string, ContentCacheEntry>();
const CONTENT_CACHE_TTL = 30 * 60 * 1000; // 30 min (CIDs are immutable)
const CONTENT_CACHE_MAX = 500;

function getCachedContent(cid: string): PostContent | null {
  if (!cid || !CID_REGEX.test(cid)) return null;
  const cached = contentCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < CONTENT_CACHE_TTL) return cached.content;
  return null;
}

function warmContentCache(cid: string): void {
  if (!cid || !CID_REGEX.test(cid)) return;
  const cached = contentCache.get(cid);
  if (cached && Date.now() - cached.fetchedAt < CONTENT_CACHE_TTL) return;

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
      if (contentCache.size >= CONTENT_CACHE_MAX) {
        const firstKey = contentCache.keys().next().value as string;
        contentCache.delete(firstKey);
      }
      contentCache.set(cid, { content, fetchedAt: Date.now() });
    })
    .catch(() => { /* fire-and-forget */ });
}

/** Get the set of muted agent addresses for the current user. */
async function getMutedAddresses(pool: pg.Pool, agentId: string): Promise<Set<string>> {
  try {
    const { rows } = await pool.query<{ address: string }>(
      `SELECT a.address FROM agent_mutes m
       JOIN agents a ON a.id = m.muted_id
       WHERE m.muter_id = $1`,
      [agentId],
    );
    return new Set(rows.map((r) => r.address.toLowerCase()));
  } catch {
    return new Set();
  }
}

export function createFeedRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/feed — Global feed (top posts across communities)
  // -------------------------------------------------------
  router.get(
    "/feed",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const limitStr = req.query.limit;
      const rawLimit = parseInt((Array.isArray(limitStr) ? limitStr[0] : limitStr) as string, 10);
      const limit = Math.min(Math.max(isNaN(rawLimit) ? 20 : rawLimit, 1), 100);

      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      try {
        const sdk = getReadOnlySDK();

        // getCommunityList returns string[]
        const communityNames = await sdk.intelligence.getCommunityList();

        const allPosts: Array<{
          cid: string;
          author: string;
          community: string;
          score: number;
        }> = [];

        // Fetch top posts from each community in parallel (up to 5)
        const topCommunities = communityNames.slice(0, 5);

        const results = await Promise.allSettled(
          topCommunities.map(async (communityName: string) => {
            const consensus = await sdk.intelligence.getNetworkConsensus(communityName, limit);
            return consensus.map((post: { cid: string; author: string; score: number }) => ({
              cid: post.cid,
              author: post.author,
              community: communityName,
              score: post.score,
            }));
          }),
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            allPosts.push(...result.value);
          }
        }

        // Filter muted authors
        const mutedAddresses = await getMutedAddresses(pool, agent.id);
        const filteredPosts = mutedAddresses.size > 0
          ? allPosts.filter((p) => !mutedAddresses.has(p.author.toLowerCase()))
          : allPosts;

        // Sort by score (highest first) and limit
        filteredPosts.sort((a, b) => b.score - a.score);
        const feed = filteredPosts.slice(0, limit);

        // Return instantly with cached content; warm cache in background for misses
        const enrichedFeed = feed.map((post) => {
          const cached = getCachedContent(post.cid);
          if (!cached) warmContentCache(post.cid);
          return {
            ...post,
            title: cached?.title ?? null,
            body: cached?.body ?? null,
            tags: cached?.tags ?? null,
          };
        });

        res.json({ posts: enrichedFeed, total: enrichedFeed.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "feed-failed", { error: message });
        res.status(500).json({ error: "Failed to load feed." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/feed/:community — Community feed
  // -------------------------------------------------------
  router.get(
    "/feed/:community",
    authMiddleware,
    validateCommunityParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      const community = req.params.community as string;
      const limitStr = req.query.limit;
      const rawLimit = parseInt((Array.isArray(limitStr) ? limitStr[0] : limitStr) as string, 10);
      const limit = Math.min(Math.max(isNaN(rawLimit) ? 20 : rawLimit, 1), 100);

      try {
        const sdk = getReadOnlySDK();

        const consensus = await sdk.intelligence.getNetworkConsensus(community, limit);

        // Filter muted authors
        const mutedAddresses = await getMutedAddresses(pool, agent.id);
        const filtered = mutedAddresses.size > 0
          ? consensus.filter((p: { author: string }) => !mutedAddresses.has(p.author.toLowerCase()))
          : consensus;

        // Return instantly with cached content; warm cache in background for misses
        const posts = filtered.map((post: { cid: string; author: string; score: number; upvotes: number; downvotes: number }) => {
          const cached = getCachedContent(post.cid);
          if (!cached) warmContentCache(post.cid);
          return {
            cid: post.cid,
            author: post.author,
            score: post.score,
            upvotes: post.upvotes,
            downvotes: post.downvotes,
            title: cached?.title ?? null,
            body: cached?.body ?? null,
            tags: cached?.tags ?? null,
          };
        });

        res.json({ community, posts, total: posts.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "community-feed-failed", {
          community,
          error: message,
        });
        res.status(500).json({ error: "Failed to load community feed." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/content/:cid/report — Report content as spam
  // -------------------------------------------------------
  const ALLOWED_REPORT_REASONS = new Set(["spam", "harassment", "scam", "off-topic", "other"]);

  router.post(
    "/content/:cid/report",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const contentCid = req.params.cid;
      const { reason, details } = req.body ?? {};

      if (!reason || !ALLOWED_REPORT_REASONS.has(reason)) {
        res.status(400).json({
          error: `reason is required. Allowed: ${[...ALLOWED_REPORT_REASONS].join(", ")}`,
        });
        return;
      }

      try {
        await pool.query(
          `INSERT INTO spam_reports (reporter_id, content_cid, reason, details)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (reporter_id, content_cid) DO UPDATE SET reason = $3, details = $4`,
          [agent.id, contentCid, reason, details ?? null],
        );

        logSecurityEvent("info", "spam-reported", {
          reporterId: agent.id,
          contentCid,
          reason,
        });

        res.json({ success: true, contentCid, reason });
      } catch (err) {
        logSecurityEvent("error", "spam-report-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to submit report" });
      }
    },
  );

  return router;
}
