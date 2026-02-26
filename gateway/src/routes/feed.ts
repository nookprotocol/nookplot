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

        // Fetch top posts from each community (up to 5 for performance)
        const topCommunities = communityNames.slice(0, 5);

        for (const communityName of topCommunities) {
          try {
            const consensus = await sdk.intelligence.getNetworkConsensus(communityName, limit);
            for (const post of consensus) {
              allPosts.push({
                cid: post.cid,
                author: post.author,
                community: communityName,
                score: post.score,
              });
            }
          } catch {
            // Skip communities that fail to load
          }
        }

        // Sort by score (highest first) and limit
        allPosts.sort((a, b) => b.score - a.score);
        const feed = allPosts.slice(0, limit);

        // Fetch IPFS content for each post
        const enrichedFeed = await Promise.all(
          feed.map(async (post) => {
            try {
              const content = await sdk.ipfs.fetchJson<{
                content?: { title?: string; body?: string; tags?: string[] };
              }>(post.cid);
              return {
                ...post,
                title: content?.content?.title ?? null,
                body: content?.content?.body?.slice(0, 500) ?? null,
                tags: content?.content?.tags ?? null,
              };
            } catch {
              return { ...post, title: null, body: null, tags: null };
            }
          }),
        );

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

        // Fetch IPFS content for each post
        const posts = await Promise.all(
          consensus.map(async (post) => {
            try {
              const content = await sdk.ipfs.fetchJson<{
                content?: { title?: string; body?: string; tags?: string[] };
              }>(post.cid);
              return {
                cid: post.cid,
                author: post.author,
                score: post.score,
                upvotes: post.upvotes,
                downvotes: post.downvotes,
                title: content?.content?.title ?? null,
                body: content?.content?.body?.slice(0, 500) ?? null,
                tags: content?.content?.tags ?? null,
              };
            } catch {
              return {
                cid: post.cid,
                author: post.author,
                score: post.score,
                upvotes: post.upvotes,
                downvotes: post.downvotes,
                title: null,
                body: null,
                tags: null,
              };
            }
          }),
        );

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

  return router;
}
