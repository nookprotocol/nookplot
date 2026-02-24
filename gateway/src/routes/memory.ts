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
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { getReadOnlySDK, getRelayer, getSdkConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { FORWARD_REQUEST_TYPES } from "@nookplot/sdk";
import { CONTENT_INDEX_ABI } from "@nookplot/sdk/dist/abis.js";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import { SubgraphBudgetExhaustedError } from "../services/subgraphGateway.js";
import type { ContentScanner } from "../services/contentScanner.js";
import { shouldQuarantine } from "../services/contentScanner.js";
import { gatewayConfig } from "../config.js";

// -------------------------------------------------------
//  Input sanitisation helpers for subgraph GraphQL queries
//  (The subgraph uses string interpolation — NOT parameterised)
// -------------------------------------------------------

/** Strip any characters that could break out of a GraphQL string literal. */
function sanitizeGraphQLString(value: string): string {
  // Remove double-quotes, backslashes, newlines, and control characters
  return value.replace(/[\\"'\n\r\t\x00-\x1f]/g, "");
}

/** Validate + clamp a numeric value for use in GraphQL queries. */
function sanitizeGraphQLNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

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
 * Uses a single subgraph query + single DB query for sybil scores.
 * Returns Map<address, score (0-1)>. On failure, returns empty map.
 */
async function batchReputationLookup(
  pool: pg.Pool,
  subgraphGateway: SubgraphGateway,
  authorAddresses: string[],
): Promise<Map<string, number>> {
  const reputationMap = new Map<string, number>();
  if (authorAddresses.length === 0) return reputationMap;

  try {
    const addrList = authorAddresses.map((a) => `"${sanitizeGraphQLString(a)}"`).join(", ");
    const sgResult = await subgraphGateway.query<{
      agents?: Array<{
        id: string;
        registeredAt: string;
        stakedAmount: string;
        authorPostCount: number;
        followerCount: number;
        attestationCount: number;
      }>;
    }>(`{ agents(where: { id_in: [${addrList}] }) { id registeredAt stakedAmount authorPostCount followerCount attestationCount } }`);

    const now = Math.floor(Date.now() / 1000);
    const agentMap = new Map((sgResult.data?.agents ?? []).map((a) => [a.id, a]));

    // Batch sybil scores
    let sybilMap = new Map<string, number>();
    try {
      const ph = authorAddresses.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await pool.query<{ address: string; suspicion_score: number }>(
        `SELECT LOWER(a.address) AS address, ss.suspicion_score
         FROM sybil_scores ss JOIN agents a ON a.id = ss.agent_id
         WHERE LOWER(a.address) IN (${ph})`,
        authorAddresses,
      );
      sybilMap = new Map(rows.map((r) => [r.address, r.suspicion_score]));
    } catch {
      // Non-fatal — sybil data unavailable
    }

    for (const addr of authorAddresses) {
      const data = agentMap.get(addr);
      if (!data) {
        reputationMap.set(addr, 0);
        continue;
      }
      const tenureDays = (now - parseInt(data.registeredAt)) / 86400;
      const tenure = Math.min(tenureDays / 365, 1.0);
      const activity = Math.min(data.authorPostCount / 100, 1.0);
      const influence = Math.min(data.followerCount / 50, 1.0);
      let trust = Math.min(data.attestationCount / 20, 1.0);
      const stake = data.stakedAmount !== "0" ? 1.0 : 0;

      const sybilPenalty = sybilMap.get(addr) ?? 0;
      trust *= 1 - sybilPenalty;

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
  subgraphGateway?: SubgraphGateway,
  contentScanner?: ContentScanner,
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
            contentScanner.recordBlockedContent(agent.id, "post", scanResult).catch(() => {});
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
          contentScanner.scanAndRecord(agent.id, "post", cid, `${title}\n\n${body}`).catch(() => {});
        }

        // Build unsigned ForwardRequest for ContentIndex.publishPost(cid, community)
        // so agents can sign locally and relay for on-chain indexing.
        let forwardRequest: Record<string, unknown> | undefined;
        let domain: Record<string, unknown> | undefined;
        let types: Record<string, unknown> | undefined;

        try {
          const calldata = contentIndexIface.encodeFunctionData("publishPost", [cid, resolvedCommunity]);
          const relayer = getRelayer();
          const nonce = await relayer.getNonce(agent.address);
          const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

          forwardRequest = {
            from: agent.address,
            to: sdkConfig.contracts.contentIndex,
            value: "0",
            gas: "500000",
            nonce: nonce.toString(),
            deadline,
            data: calldata,
          };
          domain = relayer.buildDomain();
          types = FORWARD_REQUEST_TYPES;
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
          ...(forwardRequest && { forwardRequest, domain, types }),
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
  //  Semantic search across network content via subgraph.
  // -------------------------------------------------------
  router.post(
    "/memory/query",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { community, author, tags, minScore, limit, offset } = req.body ?? {};

        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured. Memory queries require SUBGRAPH_URL." });
          return;
        }

        const queryLimit = Math.min(parseInt(String(limit ?? "20"), 10) || 20, 100);
        const queryOffset = Math.max(parseInt(String(offset ?? "0"), 10) || 0, 0);

        // Build subgraph query for posts
        // SECURITY: All user input is sanitized before interpolation
        let whereClause = "";
        const conditions: string[] = [];
        if (community && typeof community === "string") {
          if (community.length > 128) {
            res.status(400).json({ error: "community parameter too long (max 128 chars)" });
            return;
          }
          conditions.push(`community: "${sanitizeGraphQLString(community)}"`);
        }
        if (author && typeof author === "string") {
          if (author.length > 42) {
            res.status(400).json({ error: "author parameter too long" });
            return;
          }
          conditions.push(`author: "${sanitizeGraphQLString(author.toLowerCase())}"`);
        }
        if (minScore !== undefined) {
          const safeScore = sanitizeGraphQLNumber(minScore);
          if (safeScore === null) {
            res.status(400).json({ error: "minScore must be a finite number" });
            return;
          }
          conditions.push(`score_gte: ${safeScore}`);
        }
        if (conditions.length > 0) {
          whereClause = `where: { ${conditions.join(", ")} }`;
        }

        const query = `{
          contents(
            first: ${queryLimit}
            skip: ${queryOffset}
            orderBy: timestamp
            orderDirection: desc
            ${whereClause}
          ) {
            id
            cid
            author { id }
            community { id }
            contentType
            parentCid
            score
            upvotes
            downvotes
            commentCount
            timestamp
          }
        }`;

        const sgResult = await subgraphGateway.query<{ contents?: Array<{
          id: string; cid: string; author: { id: string }; community: { id: string };
          contentType: number; parentCid: string; score: number; upvotes: number;
          downvotes: number; commentCount: number; timestamp: string;
        }> }>(query);

        let items = (sgResult.data?.contents ?? []).map((entry) => ({
          cid: entry.cid,
          author: entry.author.id,
          community: entry.community.id,
          contentType: entry.contentType === 0 ? "post" : "comment",
          parentCid: entry.parentCid || undefined,
          score: entry.score,
          upvotes: entry.upvotes,
          downvotes: entry.downvotes,
          commentCount: entry.commentCount,
          createdAt: new Date(parseInt(entry.timestamp) * 1000).toISOString(),
          authorReputationScore: null as number | null,
        }));

        // Filter quarantined posts (medium+ threat flags with pending resolution)
        if (!req.body?.includeQuarantined && items.length > 0) {
          try {
            const cids = items.map((i) => i.cid);
            const ph = cids.map((_, i) => `$${i + 1}`).join(", ");
            const { rows: quarantinedCids } = await pool.query<{ content_id: string }>(
              `SELECT content_id FROM content_threat_flags
               WHERE content_type = 'post' AND content_id IN (${ph})
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
        if (subgraphGateway && items.length > 0) {
          try {
            const uniqueAuthors = [...new Set(items.map((i) => i.author))];
            const reputationMap = await batchReputationLookup(pool, subgraphGateway, uniqueAuthors);
            for (const item of items) {
              item.authorReputationScore = reputationMap.get(item.author) ?? null;
            }
          } catch {
            // Non-fatal — reputation annotation unavailable
          }
        }

        res.json({ items, limit: queryLimit, offset: queryOffset });
      } catch (err) {
        if (err instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted" });
          return;
        }
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
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured. Sync requires SUBGRAPH_URL." });
          return;
        }

        const rawSince = String(req.query.since ?? "0");
        // LOW-2: Validate since cursor is numeric
        const since = /^\d+$/.test(rawSince) ? rawSince : "0";
        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
        const community = req.query.community ? String(req.query.community) : undefined;

        // SECURITY: Sanitize all inputs before GraphQL interpolation
        let whereClause = `timestamp_gt: "${sanitizeGraphQLString(since)}"`;
        if (community) {
          whereClause += `, community: "${sanitizeGraphQLString(community)}"`;
        }

        const query = `{
          contents(
            first: ${limit + 1}
            orderBy: timestamp
            orderDirection: asc
            where: { ${whereClause} }
          ) {
            id
            cid
            author { id }
            community { id }
            contentType
            parentCid
            score
            upvotes
            downvotes
            commentCount
            timestamp
          }
        }`;

        const sgResult = await subgraphGateway.query<{ contents?: Array<{
          id: string; cid: string; author: { id: string }; community: { id: string };
          contentType: number; parentCid: string; score: number; upvotes: number;
          downvotes: number; commentCount: number; timestamp: string;
        }> }>(query);

        const entries = sgResult.data?.contents ?? [];
        const hasMore = entries.length > limit;
        let items = entries.slice(0, limit).map((entry) => ({
          cid: entry.cid,
          author: entry.author.id,
          community: entry.community.id,
          contentType: entry.contentType === 0 ? "post" : "comment",
          parentCid: entry.parentCid || undefined,
          score: entry.score,
          upvotes: entry.upvotes,
          downvotes: entry.downvotes,
          commentCount: entry.commentCount,
          createdAt: new Date(parseInt(entry.timestamp) * 1000).toISOString(),
          authorReputationScore: null as number | null,
        }));

        // Filter quarantined posts (medium+ threat flags with pending resolution)
        if (req.query.includeQuarantined !== "true" && items.length > 0) {
          try {
            const cids = items.map((i) => i.cid);
            const ph = cids.map((_, i) => `$${i + 1}`).join(", ");
            const { rows: quarantinedCids } = await pool.query<{ content_id: string }>(
              `SELECT content_id FROM content_threat_flags
               WHERE content_type = 'post' AND content_id IN (${ph})
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
        if (subgraphGateway && items.length > 0) {
          try {
            const uniqueAuthors = [...new Set(items.map((i) => i.author))];
            const reputationMap = await batchReputationLookup(pool, subgraphGateway, uniqueAuthors);
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
        if (err instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted" });
          return;
        }
        logSecurityEvent("error", "memory-sync-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Sync failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/expertise/:topic
  //  Find experts in a topic — wraps intelligence queries.
  // -------------------------------------------------------
  router.get(
    "/memory/expertise/:topic",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured" });
          return;
        }

        const topic = sanitizeGraphQLString(String(req.params.topic));
        if (!topic || topic.length > MEMORY_LIMITS.communityMaxLength) {
          res.status(400).json({ error: "Invalid topic" });
          return;
        }
        const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 50);

        // Query agents who post in the topic's community
        // SECURITY: topic is sanitized above
        const query = `{
          contents(
            first: 1000
            where: { community: "${topic}" }
          ) {
            author { id }
            score
          }
        }`;

        const sgResult = await subgraphGateway.query<{ contents?: Array<{
          author: { id: string }; score: number;
        }> }>(query);

        // Aggregate by author
        const authorStats = new Map<string, { totalScore: number; postCount: number }>();
        for (const entry of sgResult.data?.contents ?? []) {
          const existing = authorStats.get(entry.author.id) ?? { totalScore: 0, postCount: 0 };
          existing.totalScore += entry.score;
          existing.postCount += 1;
          authorStats.set(entry.author.id, existing);
        }

        // Sort by total score, take top N
        const experts = Array.from(authorStats.entries())
          .map(([address, stats]) => ({
            address,
            score: stats.totalScore,
            postCount: stats.postCount,
            community: topic,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        res.json({ experts, topic });
      } catch (err) {
        if (err instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted" });
          return;
        }
        logSecurityEvent("error", "memory-expertise-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Expertise query failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/reputation/:address?
  //  Agent reputation — uses subgraph data for basic reputation.
  // -------------------------------------------------------
  router.get(
    "/memory/reputation/:address?",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const rawAddress = String(req.params.address ?? agent.address);
        // SECURITY: Validate address is hex format before interpolation
        const targetAddress = sanitizeGraphQLString(rawAddress.toLowerCase());
        if (!/^0x[a-f0-9]{40}$/i.test(targetAddress)) {
          res.status(400).json({ error: "Invalid Ethereum address" });
          return;
        }

        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured" });
          return;
        }

        const query = `{
          agent(id: "${targetAddress}") {
            id
            registeredAt
            isVerified
            stakedAmount
            authorPostCount
            followerCount
            attestationCount
          }
        }`;

        const sgResult = await subgraphGateway.query<{ agent?: {
          id: string; registeredAt: string; isVerified: boolean;
          stakedAmount: string; authorPostCount: number;
          followerCount: number; attestationCount: number;
        } | null }>(query);

        const agentData = sgResult.data?.agent;
        if (!agentData) {
          res.status(404).json({ error: "Agent not found on-chain" });
          return;
        }

        // Compute basic reputation components
        const now = Math.floor(Date.now() / 1000);
        const tenureDays = (now - parseInt(agentData.registeredAt)) / 86400;
        const tenure = Math.min(tenureDays / 365, 1.0); // Normalized to [0, 1]
        const activity = Math.min(agentData.authorPostCount / 100, 1.0);
        const influence = Math.min(agentData.followerCount / 50, 1.0);
        let trust = Math.min(agentData.attestationCount / 20, 1.0);
        const stake = agentData.stakedAmount !== "0" ? 1.0 : 0;

        // Sybil penalty: reduce trust component based on suspicion score.
        // suspicion_score is 0.0-1.0; a score of 1.0 zeroes out trust entirely.
        let sybilPenalty = 0;
        try {
          const { rows: sybilRows } = await pool.query<{ suspicion_score: number }>(
            `SELECT ss.suspicion_score FROM sybil_scores ss
             JOIN agents a ON a.id = ss.agent_id
             WHERE LOWER(a.address) = LOWER($1)`,
            [targetAddress],
          );
          if (sybilRows.length > 0) {
            sybilPenalty = sybilRows[0].suspicion_score;
            trust *= (1 - sybilPenalty);
          }
        } catch {
          // Non-fatal — sybil data unavailable, trust stays unpenalized
        }

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
          ...(sybilPenalty > 0 ? { sybilPenalty: Math.round(sybilPenalty * 10000) / 10000 } : {}),
        });
      } catch (err) {
        if (err instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted" });
          return;
        }
        logSecurityEvent("error", "memory-reputation-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Reputation query failed" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/memory/communities
  //  List available communities from the subgraph so agents
  //  can discover where to post.
  // -------------------------------------------------------
  router.get(
    "/memory/communities",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured" });
          return;
        }

        const limitParam = sanitizeGraphQLNumber(req.query.limit);
        const limit = Math.min(Math.max(limitParam ?? 50, 1), 100);

        const query = `{
          communities(
            first: ${limit},
            orderBy: totalPosts,
            orderDirection: desc,
            where: { isRegistered: true }
          ) {
            id
            totalPosts
            uniqueAuthors
            totalScore
            lastPostAt
            creator { id }
            metadataCid
            postingPolicy
            isRegistryActive
            registryCreatedAt
          }
        }`;

        const sgResult = await subgraphGateway.query<{
          communities?: Array<{
            id: string;
            totalPosts: number;
            uniqueAuthors: number;
            totalScore: number;
            lastPostAt: string;
            creator: { id: string } | null;
            metadataCid: string;
            postingPolicy: number;
            isRegistryActive: boolean;
            registryCreatedAt: string;
          }>;
        }>(query);

        const communities = (sgResult.data?.communities ?? []).map((c) => ({
          slug: c.id,
          totalPosts: c.totalPosts,
          uniqueAuthors: c.uniqueAuthors,
          totalScore: c.totalScore,
          lastPostAt: c.lastPostAt,
          creator: c.creator?.id ?? null,
          metadataCid: c.metadataCid,
          postingPolicy: c.postingPolicy,
          isActive: c.isRegistryActive,
          createdAt: c.registryCreatedAt,
        }));

        res.json({ communities, default: "general" });
      } catch (err) {
        if (err instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted" });
          return;
        }
        logSecurityEvent("error", "memory-communities-failed", {
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
        res.status(500).json({ error: "Communities query failed" });
      }
    },
  );

  return router;
}
