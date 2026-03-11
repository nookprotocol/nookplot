/**
 * Knowledge Bundle lifecycle routes.
 *
 * POST   /v1/bundles              — 410 Gone (use POST /v1/prepare/bundle)
 * GET    /v1/bundles              — List bundles
 * GET    /v1/bundles/:id          — Get bundle detail
 * POST   /v1/bundles/discover     — Discover relevant bundles
 * GET    /v1/bundles/:id/citations — Messages that cited this bundle
 * POST   /v1/bundles/:id/content  — 410 Gone (use POST /v1/prepare/bundle/:id/content)
 * POST   /v1/bundles/:id/content/remove — 410 Gone
 * POST   /v1/bundles/:id/contributors   — 410 Gone
 * DELETE /v1/bundles/:id          — 410 Gone
 *
 * @module routes/bundles
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { getProvider } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { BundleDiscoveryService } from "../services/bundleDiscoveryService.js";

/** Minimal ABI for KnowledgeBundle.getBundleContent(uint256) → string[] */
const BUNDLE_CONTENT_ABI = [
  "function getBundleContent(uint256 bundleId) external view returns (string[] memory)",
];

/**
 * One-time backfill: populate content_cids from chain for bundles the indexer
 * hasn't processed yet.  Runs fire-and-forget at router creation; with only a
 * handful of bundles, the chain cost is negligible.
 */
async function backfillBundleContentCids(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
): Promise<void> {
  const contractAddr = sdkConfig.contracts.knowledgeBundle;
  if (!contractAddr) return;

  try {
    const { rows } = await pool.query(
      `SELECT id, bundle_id AS "bundleId"
       FROM idx_knowledge_bundles
       WHERE content_cids IS NULL OR content_cids = '{}'`,
    );
    if (rows.length === 0) return;

    const provider = getProvider();
    const contract = new ethers.Contract(contractAddr, BUNDLE_CONTENT_ABI, provider);

    for (const row of rows) {
      try {
        const cids: string[] = await contract.getBundleContent(BigInt(row.bundleId));
        if (cids.length > 0) {
          await pool.query(
            `UPDATE idx_knowledge_bundles
             SET content_cids = $1, cid_count = $2
             WHERE id = $3`,
            [cids, cids.length, row.id],
          );
        }
      } catch (err) {
        logSecurityEvent("warn", "bundle-backfill-cid-failed", {
          bundleId: row.bundleId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logSecurityEvent("info", "bundle-backfill-complete", { count: rows.length });
  } catch (err) {
    logSecurityEvent("warn", "bundle-backfill-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createBundlesRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  bundleDiscoveryService?: BundleDiscoveryService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Fire-and-forget: backfill content_cids from chain for bundles the indexer missed
  backfillBundleContentCids(pool, sdkConfig).catch(() => {});

  // -------------------------------------------------------
  //  POST /v1/bundles — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bundles — List bundles (from idx_knowledge_bundles)
  // -------------------------------------------------------

  /** Allowlisted sort options — values are raw SQL, never from user input. */
  const SORT_MAP: Record<string, string> = {
    newest: "kb.created_at DESC",
    score: `"bundleScore" DESC, kb.created_at DESC`,
  };

  router.get(
    "/bundles",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);
        const activeOnly = req.query.active !== "false";
        const sortKey = typeof req.query.sort === "string" ? req.query.sort : "newest";
        const orderBy = SORT_MAP[sortKey] ?? SORT_MAP.newest;

        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (activeOnly) {
          conditions.push(`kb.is_active = true`);
        }

        // Optional metadata filters
        const bundleTypeFilter = req.query.bundleType ? String(req.query.bundleType) : undefined;
        const tagsFilter = req.query.tags ? String(req.query.tags) : undefined;
        const domainFilter = req.query.domain ? String(req.query.domain) : undefined;

        if (bundleTypeFilter) {
          conditions.push(`kb.bundle_type = $${paramIdx++}`);
          params.push(bundleTypeFilter);
        }
        if (tagsFilter) {
          const tagArr = tagsFilter.split(",").map((t) => t.trim()).filter(Boolean);
          conditions.push(`kb.tags && $${paramIdx++}`);
          params.push(tagArr);
        }
        if (domainFilter) {
          conditions.push(`kb.domain = $${paramIdx++}`);
          params.push(domainFilter);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(first, skip);

        const { rows } = await pool.query(
          `SELECT kb.id, kb.bundle_id AS "bundleId",
                  kb.creator_id AS "creator", kb.name,
                  kb.description_cid AS "descriptionCid",
                  kb.contributor_count AS "contributorCount",
                  GREATEST(kb.cid_count, COALESCE(array_length(kb.content_cids, 1), 0)) AS "cidCount",
                  kb.created_at AS "createdAt",
                  kb.is_active AS "isActive",
                  kb.bundle_type AS "bundleType",
                  kb.tags,
                  kb.summary,
                  kb.domain,
                  kb.bundle_metadata AS "bundleMetadata",
                  kb.citation_count AS "citationCount",
                  (GREATEST(kb.cid_count, COALESCE(array_length(kb.content_cids, 1), 0)) * 1
                   + kb.citation_count * 5
                   + kb.contributor_count * 3)::int AS "bundleScore"
           FROM idx_knowledge_bundles kb
           ${whereClause}
           ORDER BY ${orderBy}
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          params,
        );

        // Shape creator to match previous { id } format
        const bundles = rows.map((r: Record<string, unknown>) => ({
          ...r,
          creator: { id: r.creator },
        }));

        res.json({
          bundles,
          first,
          skip,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bundles-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list bundles." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bundles/:id — Bundle detail
  // -------------------------------------------------------
  router.get(
    "/bundles/:id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const bundleId = req.params.id;
        if (!/^\d+$/.test(bundleId as string)) {
          res.status(400).json({ error: "Bundle ID must be a number." });
          return;
        }

        // Use bundle_id (bigint) field for lookup — the id column is hex encoded
        const { rows: bundleRows } = await pool.query(
          `SELECT id, bundle_id AS "bundleId",
                  creator_id AS "creator", name,
                  description_cid AS "descriptionCid",
                  content_cids AS "contentCids",
                  cid_count AS "cidCount",
                  contributor_count AS "contributorCount",
                  created_at AS "createdAt",
                  is_active AS "isActive",
                  bundle_type AS "bundleType",
                  tags,
                  summary,
                  domain,
                  bundle_metadata AS "bundleMetadata"
           FROM idx_knowledge_bundles
           WHERE bundle_id = $1
           LIMIT 1`,
          [bundleId],
        );

        if (bundleRows.length === 0) {
          res.status(404).json({ error: "Bundle not found." });
          return;
        }

        const bundle = bundleRows[0] as Record<string, unknown>;

        // If contentCids is empty but cidCount > 0, fetch from chain
        const contentCids = bundle.contentCids as string[] | null;
        const cidCount = bundle.cidCount as number;
        if ((!contentCids || contentCids.length === 0) && cidCount > 0 && sdkConfig.contracts.knowledgeBundle) {
          try {
            const provider = getProvider();
            const contract = new ethers.Contract(
              sdkConfig.contracts.knowledgeBundle,
              BUNDLE_CONTENT_ABI,
              provider,
            );
            const cids: string[] = await contract.getBundleContent(BigInt(bundleId as string));
            bundle.contentCids = cids;
          } catch (chainErr) {
            // Non-fatal — return empty CIDs rather than failing the whole request
            logSecurityEvent("warn", "bundle-content-chain-fetch-failed", {
              bundleId,
              error: chainErr instanceof Error ? chainErr.message : String(chainErr),
            });
          }
        }

        // Fetch contributors for this bundle
        const { rows: contribRows } = await pool.query(
          `SELECT id, contributor_id AS "contributor", weight_bps AS "weightBps"
           FROM idx_bundle_contributors
           WHERE bundle_id = $1`,
          [bundle.id],
        );

        // Shape to match previous subgraph format
        const contributors = contribRows.map((c: Record<string, unknown>) => ({
          id: c.id,
          contributor: { id: c.contributor },
          weightBps: c.weightBps,
        }));

        res.json({
          ...bundle,
          creator: { id: bundle.creator },
          contributors,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bundle-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch bundle." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/discover — Discover relevant bundles
  // -------------------------------------------------------
  router.post(
    "/bundles/discover",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        if (!bundleDiscoveryService) {
          res.status(503).json({ error: "Bundle discovery not available" });
          return;
        }

        const { channelId, projectId, guildId, keywords, faculty, limit } = req.body ?? {};
        const bundles = await bundleDiscoveryService.discover({
          channelId: typeof channelId === "string" ? channelId : undefined,
          projectId: typeof projectId === "string" ? projectId : undefined,
          guildId: typeof guildId === "string" ? guildId : undefined,
          keywords: typeof keywords === "string" ? keywords : undefined,
          faculty: typeof faculty === "string" ? faculty : undefined,
          agentId: agent.id,
          limit: typeof limit === "number" ? limit : undefined,
        });

        // Fire-and-forget: record discovery impressions
        if (bundles.length > 0) {
          const contextType = channelId ? "channel_suggestion" : projectId ? "project_context" : guildId ? "guild_context" : "keyword_search";
          const contextId = channelId ?? projectId ?? guildId ?? undefined;
          (async () => {
            for (const b of bundles) {
              await pool.query(
                `INSERT INTO bundle_discovery_impressions (agent_id, bundle_id, context_type, context_id)
                 VALUES ($1, $2, $3, $4)`,
                [agent.id, b.bundleId, contextType, contextId],
              ).catch(() => { /* best-effort */ });
            }
          })().catch(() => { /* best-effort */ });
        }

        res.json({ bundles });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bundles-discover-failed", { error: message, agentId: agent.id });
        res.status(500).json({ error: "Failed to discover bundles." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bundles/:id/citations — Messages that cited this bundle
  // -------------------------------------------------------
  router.get(
    "/bundles/:id/citations",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const bundleId = req.params.id;
        if (!/^\d+$/.test(bundleId as string)) {
          res.status(400).json({ error: "Bundle ID must be a number." });
          return;
        }

        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
        const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

        const { rows } = await pool.query(
          `SELECT bc.id, bc.message_id, bc.citing_agent_id, bc.citation_type, bc.created_at,
                  cm.content AS message_content,
                  c.name AS channel_name, c.id AS channel_id,
                  a.address AS citing_address, a.display_name AS citing_name
           FROM bundle_citations bc
           JOIN channel_messages cm ON cm.id = bc.message_id
           JOIN channels c ON c.id = bc.channel_id
           LEFT JOIN agents a ON a.id = bc.citing_agent_id
           WHERE bc.bundle_id = $1
           ORDER BY bc.created_at DESC
           LIMIT $2 OFFSET $3`,
          [bundleId, limit, offset],
        );

        const citations = rows.map((r: Record<string, unknown>) => ({
          id: r.id,
          messageId: r.message_id,
          citationType: r.citation_type,
          createdAt: r.created_at,
          messageContent: typeof r.message_content === "string" ? r.message_content.slice(0, 500) : null,
          channelId: r.channel_id,
          channelName: r.channel_name,
          citingAddress: r.citing_address,
          citingName: r.citing_name,
        }));

        res.json({ citations, bundleId: parseInt(bundleId as string, 10), limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bundle-citations-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch citations." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/:id/content — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles/:id/content",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/content",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/:id/content/remove — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles/:id/content/remove",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/content/remove",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/:id/contributors — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles/:id/contributors",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/contributors",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/bundles/:id — 410 Gone
  // -------------------------------------------------------
  router.delete(
    "/bundles/:id",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/deactivate",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
