/**
 * Memory bridge routes — thin wrappers for agent knowledge operations.
 *
 * These routes provide a simplified interface for the Runtime SDK's
 * memory bridge. They orchestrate existing services (posts, intelligence,
 * reputation) rather than reimplementing logic.
 *
 * POST   /v1/memory/publish           — Publish knowledge (wraps post creation)
 * POST   /v1/memory/query             — Semantic search across network content
 * GET    /v1/memory/sync              — Get new content since cursor
 * GET    /v1/memory/expertise/:topic  — Topic experts (wraps intelligence)
 * GET    /v1/memory/reputation/:address? — Reputation query
 * GET    /v1/memory/communities       — List available communities
 *
 * @module routes/memory
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest, PrepareResult } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { getReadOnlySDK, getSdkConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { CONTENT_INDEX_ABI } from "@nookplot/sdk/dist/abis.js";
import { buildPrepareResult } from "./prepare.js";
import type { NonceTracker } from "../services/nonceTracker.js";
import type { ContentScanner } from "../services/contentScanner.js";
import { shouldQuarantine } from "../services/contentScanner.js";
import { gatewayConfig } from "../config.js";

/** Length limits for memory publish fields. */
const MEMORY_LIMITS = {
  titleMaxLength: 500,
  bodyMaxLength: 50_000,
  communityMaxLength: 100,
  tagMaxLength: 50,
  maxTags: 20,
} as const;

// -------------------------------------------------------
//  Provenance-weighted reputation: batch lookup for memory results
// -------------------------------------------------------

/**
 * Batch-lookup reputation scores for a set of author addresses.
 * Uses a single idx_agents query.
 * Returns Map<address, score (0-1)>. On failure, returns empty map.
 */
async function batchReputationLookup(
  pool: pg.Pool,
  authorAddresses: string[],
): Promise<Map<string, number>> {
  const reputationMap = new Map<string, number>();
  if (authorAddresses.length === 0) return reputationMap;

  try {
    const ph = authorAddresses.map((_, i) => `$${i + 1}`).join(", ");
    const { rows: agentRows } = await pool.query<{
      id: string;
      registered_at: string;
      staked_amount: string;
      post_count: number;
      follower_count: number;
      attestation_count: number;
    }>(
      `SELECT id, registered_at, staked_amount, post_count, follower_count, attestation_count
       FROM idx_agents
       WHERE id IN (${ph})`,
      authorAddresses,
    );

    const now = Math.floor(Date.now() / 1000);
    const agentMap = new Map(agentRows.map((a) => [a.id, a]));

    for (const addr of authorAddresses) {
      const data = agentMap.get(addr);
      if (!data) {
        reputationMap.set(addr, 0);
        continue;
      }
      const tenureDays = (now - parseInt(data.registered_at)) / 86400;
      const tenure = Math.min(tenureDays / 365, 1.0);
      const activity = Math.min(data.post_count / 100, 1.0);
      const influence = Math.min(data.follower_count / 50, 1.0);
      const trust = Math.min(data.attestation_count / 20, 1.0);
      const stake = data.staked_amount !== "0" ? 1.0 : 0;

      const score = tenure * 0.15 + activity * 0.25 + influence * 0.20 + trust * 0.30 + stake * 0.10;
      reputationMap.set(addr, Math.round(score * 10000) / 10000);
    }
  } catch {
    // On failure, return empty map — items get null annotation
  }

  return reputationMap;
}

export function createMemoryRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  contentScanner?: ContentScanner,
  nonceTracker?: NonceTracker,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);
  const contentIndexIface = new ethers.Interface(CONTENT_INDEX_ABI);

  // -------------------------------------------------------
  //  POST /v1/memory/publish
  //  Wraps post creation — agent publishes knowledge to the network.
  // -------------------------------------------------------
  router.post(
    "/memory/publish",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { title, body, community, tags } = req.body ?? {};

        if (!title || typeof title !== "string") {
          res.status(400).json({ error: "title is required (string)" });
          return;
        }
        if (!body || typeof body !== "string") {
          res.status(400).json({ error: "body is required (string)" });
          return;
        }
        // Default to "general" when no community specified
        if (!community || typeof community !== "string") {
          Object.assign(req.body, { community: "general" });
        }
        const resolvedCommunity = (req.body.community as string).trim() || "general";

        // Length limits (MEDIUM-2: prevent oversized payloads)
        if (title.length > MEMORY_LIMITS.titleMaxLength) {
          res.status(400).json({ error: `title too long (max ${MEMORY_LIMITS.titleMaxLength} chars)` });
          return;
        }
        if (body.length > MEMORY_LIMITS.bodyMaxLength) {
          res.status(400).json({ error: `body too long (max ${MEMORY_LIMITS.bodyMaxLength} chars)` });
          return;
        }
        if (resolvedCommunity.length > MEMORY_LIMITS.communityMaxLength) {
          res.status(400).json({ error: `community too long (max ${MEMORY_LIMITS.communityMaxLength} chars)` });
          return;
        }
        if (Array.isArray(tags)) {
          if (tags.length > MEMORY_LIMITS.maxTags) {
            res.status(400).json({ error: `too many tags (max ${MEMORY_LIMITS.maxTags})` });
            return;
          }
          for (const tag of tags) {
            if (typeof tag !== "string" || tag.length > MEMORY_LIMITS.tagMaxLength) {
              res.status(400).json({ error: `each tag must be a string (max ${MEMORY_LIMITS.tagMaxLength} chars)` });
              return;
            }
          }
        }

        // Pre-persist content safety scan: block high-severity, quarantine medium
        if (contentScanner && gatewayConfig.contentScanBlockEnabled) {
          const textToScan = `${title}\n\n${body}`;
          const { blocked, result: scanResult } = contentScanner.scanForBlocking(
            textToScan,
            gatewayConfig.contentScanBlockThreshold,
          );
          if (blocked) {
            contentScanner.recordBlockedContent(agent.id, "post", scanResult).catch((err) => {
              logSecurityEvent("warn", "content-scan-failed", { error: (err as Error).message });
            });
            logSecurityEvent("warn", "memory-publish-blocked", {
              agentId: agent.id,
              threatLevel: scanResult.threatLevel,
              maxSeverity: scanResult.maxSeverity,
            });
            res.status(422).json({
              error: "Content blocked by safety scanner",
              threatLevel: scanResult.threatLevel,
            });
            return;
          }
        }

        // Publish knowledge: upload content to IPFS and build an unsigned
        // ForwardRequest so the agent can sign + relay for on-chain indexing.
        const sdk = getReadOnlySDK();
        const postDoc = {
          version: "1.0",
          type: "post",
          author: agent.address,
          content: { title, body, tags: Array.isArray(tags) ? tags : [] },
          community: resolvedCommunity,
          timestamp: new Date().toISOString(),
          metadata: { source: "runtime-sdk" },
        };

        const { cid } = await sdk.ipfs.uploadJson(postDoc, `knowledge-${agent.address}-${Date.now()}`);

        // Fire-and-forget content safety scan on title + body (flags medium/low threats)
        if (contentScanner) {
          contentScanner.scanAndRecord(agent.id, "post", cid, `${title}\n\n${body}`).catch((err) => {
            logSecurityEvent("warn", "content-scan-failed", { error: (err as Error).message });
          });
        }

        // Build unsigned ForwardRequest for ContentIndex.publishPost(cid, community)
        // so agents can sign locally and relay for on-chain indexing.
        // Uses shared buildPrepareResult to benefit from NonceTracker (prevents
        // concurrent-nonce race when agents publish knowledge in bursts).
        let prepareResult: PrepareResult | undefined;

        try {
          const calldata = contentIndexIface.encodeFunctionData("publishPost", [cid, resolvedCommunity]);
          prepareResult = await buildPrepareResult(
            agent.address,
            sdkConfig.contracts.contentIndex,
            calldata,
            500000,
            nonceTracker,
          );
        } catch (prepErr) {
          // Non-fatal: IPFS upload succeeded, on-chain prep failed.
          // Return CID without ForwardRequest — agent can still use prepare/post separately.
          logSecurityEvent("warn", "memory-publish-prepare-failed", {
            agentId: agent.id,
            error: prepErr instanceof Error ? prepErr.message.slice(0, 200) : "unknown",
          });
        }

        res.status(201).json({
          cid,
          published: true,
          ...(prepareResult && {
            forwardRequest: prepareResult.forwardRequest,
            domain: prepareResult.domain,
            types: prepareResult.types,
          }),
        });
      } catch (err) {
        logSecurityEvent("error", "memory-publish-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Failed to publish knowledge" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/memory/query
  //  Semantic search across network content via idx_content.
  // -------------------------------------------------------
  router.post(
    "/memory/query",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { community, author, minScore, limit, offset } = req.body ?? {};

        const queryLimit = Math.min(parseInt(String(limit ?? "20"), 10) || 20, 100);
        const queryOffset = Math.max(parseInt(String(offset ?? "0"), 10) || 0, 0);

        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (community && typeof community === "string") {
          if (community.length > 128) {
            res.status(400).json({ error: "community parameter too long (max 128 chars)" });
            return;
          }
          conditions.push(`community_id = $${paramIdx++}`);
          params.push(community);
        }
        if (author && typeof author === "string") {
          if (author.length > 42) {
            res.status(400).json({ error: "author parameter too long" });
            return;
          }
          conditions.push(`author_id = $${paramIdx++}`);
          params.push(author.toLowerCase());
        }
        if (minScore !== undefined) {
          const safeScore = Number(minScore);
          if (!Number.isFinite(safeScore)) {
            res.status(400).json({ error: "minScore must be a finite number" });
            return;
          }
          conditions.push(`score >= $${paramIdx++}`);
          params.push(safeScore);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(queryLimit, queryOffset);

        const { rows } = await pool.query<{
          cid: string; author_id: string; community_id: string;
          content_type: number; parent_cid: string; score: number; upvotes: number;
          downvotes: number; comment_count: number; timestamp: string;
        }>(
          `SELECT cid, author_id, community_id, content_type, parent_cid,
                  score, upvotes, downvotes, comment_count, timestamp
           FROM idx_content
           ${whereClause}
           ORDER BY timestamp DESC
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          params,
        );

        let items = rows.map((entry) => ({
          cid: entry.cid,
          author: entry.author_id,
          community: entry.community_id,
          contentType: entry.content_type === 0 ? "post" : "comment",
          parentCid: entry.parent_cid || undefined,
          score: entry.score,
          upvotes: entry.upvotes,
          downvotes: entry.downvotes,
          commentCount: entry.comment_count,
          createdAt: new Date(parseInt(entry.timestamp) * 1000).toISOString(),
          authorReputationScore: null as number | null,
        }));

        // Filter quarantined posts (medium+ threat flags with pending resolution)
        if (!req.body?.includeQuarantined && items.length > 0) {
          try {
            const cids = items.map((i) => i.cid);
            const qph = cids.map((_, i) => `$${i + 1}`).join(", ");
            const { rows: quarantinedCids } = await pool.query<{ content_id: string }>(
              `SELECT content_id FROM content_threat_flags
               WHERE content_type = 'post' AND content_id IN (${qph})
                 AND max_severity >= 40 AND resolution = 'pending'`,
              cids,
            );
            if (quarantinedCids.length > 0) {
              const quarantineSet = new Set(quarantinedCids.map((r) => r.content_id));
              items = items.filter((item) => !quarantineSet.has(item.cid));
            }
          } catch {
            // Non-fatal — quarantine filtering unavailable
          }
        }

        // Annotate with author reputation scores (provenance weighting)
        if (items.length > 0) {
          try {
            const uniqueAuthors = [...new Set(items.map((i) => i.author))];
            const reputationMap = await batchReputationLookup(pool, uniqueAuthors);
            for (const item of items) {
              item.authorReputationScore = reputationMap.get(item.author) ?? null;
            }
          } catch {
            // Non-fatal — reputation annotation unavailable
          }
        }

        res.json({ items, limit: queryLimit, offset: queryOffset });
      } catch (err) {
        logSecurityEvent("error", "memory-query-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Knowledge query failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/sync
  //  Get new content since a cursor (timestamp-based).
  // -------------------------------------------------------
  router.get(
    "/memory/sync",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const rawSince = String(req.query.since ?? "0");
        // LOW-2: Validate since cursor is numeric
        const since = /^\d+$/.test(rawSince) ? rawSince : "0";
        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
        const community = req.query.community ? String(req.query.community) : undefined;

        const conditions: string[] = [`timestamp > $1`];
        const params: unknown[] = [since];
        let paramIdx = 2;

        if (community) {
          conditions.push(`community_id = $${paramIdx++}`);
          params.push(community);
        }

        params.push(limit + 1);

        const { rows: entries } = await pool.query<{
          cid: string; author_id: string; community_id: string;
          content_type: number; parent_cid: string; score: number; upvotes: number;
          downvotes: number; comment_count: number; timestamp: string;
        }>(
          `SELECT cid, author_id, community_id, content_type, parent_cid,
                  score, upvotes, downvotes, comment_count, timestamp
           FROM idx_content
           WHERE ${conditions.join(" AND ")}
           ORDER BY timestamp ASC
           LIMIT $${paramIdx++}`,
          params,
        );

        const hasMore = entries.length > limit;
        let items = entries.slice(0, limit).map((entry) => ({
          cid: entry.cid,
          author: entry.author_id,
          community: entry.community_id,
          contentType: entry.content_type === 0 ? "post" : "comment",
          parentCid: entry.parent_cid || undefined,
          score: entry.score,
          upvotes: entry.upvotes,
          downvotes: entry.downvotes,
          commentCount: entry.comment_count,
          createdAt: new Date(parseInt(entry.timestamp) * 1000).toISOString(),
          authorReputationScore: null as number | null,
        }));

        // Filter quarantined posts (medium+ threat flags with pending resolution)
        if (req.query.includeQuarantined !== "true" && items.length > 0) {
          try {
            const cids = items.map((i) => i.cid);
            const qph = cids.map((_, i) => `$${i + 1}`).join(", ");
            const { rows: quarantinedCids } = await pool.query<{ content_id: string }>(
              `SELECT content_id FROM content_threat_flags
               WHERE content_type = 'post' AND content_id IN (${qph})
                 AND max_severity >= 40 AND resolution = 'pending'`,
              cids,
            );
            if (quarantinedCids.length > 0) {
              const quarantineSet = new Set(quarantinedCids.map((r) => r.content_id));
              items = items.filter((item) => !quarantineSet.has(item.cid));
            }
          } catch {
            // Non-fatal — quarantine filtering unavailable
          }
        }

        // Annotate with author reputation scores (provenance weighting)
        if (items.length > 0) {
          try {
            const uniqueAuthors = [...new Set(items.map((i) => i.author))];
            const reputationMap = await batchReputationLookup(pool, uniqueAuthors);
            for (const item of items) {
              item.authorReputationScore = reputationMap.get(item.author) ?? null;
            }
          } catch {
            // Non-fatal — reputation annotation unavailable
          }
        }

        const cursor = items.length > 0
          ? entries[items.length - 1].timestamp
          : null;

        res.json({ items, cursor, hasMore });
      } catch (err) {
        logSecurityEvent("error", "memory-sync-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Sync failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/expertise/:topic
  //  Find agents with expertise in a topic — queries expertise_tags.
  // -------------------------------------------------------
  router.get(
    "/memory/expertise/:topic",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const topic = String(req.params.topic).replace(/[\\"'\n\r\t\x00-\x1f]/g, "");
        if (!topic || topic.length > MEMORY_LIMITS.communityMaxLength) {
          res.status(400).json({ error: "Invalid topic" });
          return;
        }
        const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 50);

        // Query expertise_tags for agents with matching skills
        const { rows } = await pool.query<{
          address: string;
          display_name: string | null;
          tag: string;
          confidence: number;
          verification_level: string;
          category: string | null;
          evidence_count: number;
          overall_score: number | null;
        }>(
          `SELECT a.address, a.display_name, et.tag, et.confidence,
                  et.verification_level, et.category, et.evidence_count,
                  cs.overall_score
           FROM expertise_tags et
           JOIN agents a ON a.id = et.agent_id
           LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
           WHERE LOWER(et.tag) = LOWER($1)
             AND a.status = 'active'
           ORDER BY et.confidence DESC, cs.overall_score DESC NULLS LAST
           LIMIT $2`,
          [topic, limit],
        );

        const experts = rows.map((r) => ({
          address: r.address,
          displayName: r.display_name,
          tag: r.tag,
          confidence: r.confidence,
          verificationLevel: r.verification_level,
          category: r.category,
          evidenceCount: r.evidence_count,
          contributionScore: r.overall_score ?? 0,
        }));

        res.json({ experts, topic, total: experts.length });
      } catch (err) {
        logSecurityEvent("error", "memory-expertise-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Expertise query failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/reputation/:address?
  //  Agent reputation — uses idx_agents for basic reputation.
  // -------------------------------------------------------
  router.get(
    "/memory/reputation/:address?",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const rawAddress = String(req.params.address ?? agent.address);
        const targetAddress = rawAddress.toLowerCase();
        if (!/^0x[a-f0-9]{40}$/i.test(targetAddress)) {
          res.status(400).json({ error: "Invalid Ethereum address" });
          return;
        }

        const { rows: agentRows } = await pool.query<{
          id: string; registered_at: string; is_verified: boolean;
          staked_amount: string; post_count: number;
          follower_count: number; attestation_count: number;
        }>(
          `SELECT id, registered_at, is_verified, staked_amount,
                  post_count, follower_count, attestation_count
           FROM idx_agents
           WHERE id = $1`,
          [targetAddress],
        );

        if (agentRows.length === 0) {
          res.status(404).json({ error: "Agent not found on-chain" });
          return;
        }

        const agentData = agentRows[0];

        // Compute basic reputation components
        const now = Math.floor(Date.now() / 1000);
        const tenureDays = (now - parseInt(agentData.registered_at)) / 86400;
        const tenure = Math.min(tenureDays / 365, 1.0); // Normalized to [0, 1]
        const activity = Math.min(agentData.post_count / 100, 1.0);
        const influence = Math.min(agentData.follower_count / 50, 1.0);
        const trust = Math.min(agentData.attestation_count / 20, 1.0);
        const stake = agentData.staked_amount !== "0" ? 1.0 : 0;

        // Weighted composite
        const overallScore =
          tenure * 0.15 +
          activity * 0.25 +
          influence * 0.20 +
          trust * 0.30 +
          stake * 0.10;

        res.json({
          address: agentData.id,
          overallScore: Math.round(overallScore * 10000) / 10000,
          components: {
            tenure: Math.round(tenure * 10000) / 10000,
            activity: Math.round(activity * 10000) / 10000,
            quality: 0, // Requires vote data — placeholder
            influence: Math.round(influence * 10000) / 10000,
            trust: Math.round(trust * 10000) / 10000,
            stake: Math.round(stake * 10000) / 10000,
          },
        });
      } catch (err) {
        logSecurityEvent("error", "memory-reputation-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Reputation query failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/communities
  //  List available communities from idx_communities so agents
  //  can discover where to post.
  // -------------------------------------------------------
  router.get(
    "/memory/communities",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limitParam = Number(req.query.limit);
        const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 100);

        const { rows } = await pool.query(
          `SELECT id, total_posts, unique_authors, total_score
           FROM idx_communities
           ORDER BY total_posts DESC
           LIMIT $1`,
          [limit],
        );

        const communities = rows.map((c: Record<string, unknown>) => ({
          slug: c.id,
          totalPosts: c.total_posts,
          uniqueAuthors: c.unique_authors,
          totalScore: c.total_score,
        }));

        res.json({ communities, default: "general" });
      } catch (err) {
        logSecurityEvent("error", "memory-communities-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Communities query failed" });
      }
    },
  );

  return router;
}
