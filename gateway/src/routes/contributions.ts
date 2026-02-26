/**
 * Contribution score and expertise routes.
 *
 * GET  /v1/contributions/:address    — Get agent contribution data
 * GET  /v1/contributions/leaderboard — Paginated leaderboard
 * POST /v1/contributions/sync        — Trigger manual sync cycle (admin only)
 *
 * @module routes/contributions
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { validateAddressParam } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { ContributionScorer } from "../services/contributionScorer.js";
import { ExpertiseProfiler } from "../services/expertiseProfiler.js";
import { OnChainSync, type SyncCycleResult } from "../services/onChainSync.js";

export function createContributionsRouter(
  pool: pg.Pool,
  scorer: ContributionScorer,
  profiler: ExpertiseProfiler,
  onChainSync: OnChainSync | null,
  hmacSecret: string,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/contributions/leaderboard — Top contributors
  // -------------------------------------------------------
  // Must be defined BEFORE /:address to avoid route conflict
  router.get(
    "/contributions/leaderboard",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 100);
        const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
        const community = typeof req.query.community === "string" ? req.query.community : undefined;

        // For now, community filtering is not available at DB level.
        // All scores are global. community param is reserved for future use.
        void community;

        const result = await pool.query(
          `SELECT cs.address, cs.overall_score, cs.commits_score, cs.exec_score,
                  cs.projects_score, cs.lines_score, cs.collab_score,
                  cs.breakdown_cid, cs.computed_at,
                  a.display_name
           FROM contribution_scores cs
           JOIN agents a ON a.id = cs.agent_id
           WHERE a.status IN ('active', 'exported') AND a.did_cid IS NOT NULL
             AND cs.commits_score > 0
           ORDER BY cs.overall_score DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );

        const countResult = await pool.query(
          `SELECT COUNT(*) as total FROM contribution_scores cs
           JOIN agents a ON a.id = cs.agent_id
           WHERE a.status IN ('active', 'exported') AND a.did_cid IS NOT NULL
             AND cs.commits_score > 0`,
        );

        res.json({
          entries: result.rows.map((row, i) => ({
            rank: offset + i + 1,
            address: row.address,
            displayName: row.display_name,
            score: row.overall_score,
            breakdown: {
              commits: row.commits_score,
              exec: row.exec_score,
              projects: row.projects_score,
              lines: row.lines_score,
              collab: row.collab_score,
            },
            breakdownCid: row.breakdown_cid,
            computedAt: row.computed_at?.toISOString(),
          })),
          total: parseInt(countResult.rows[0]?.total ?? "0", 10),
          limit,
          offset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "contributions-leaderboard-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch leaderboard." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/contributions/:address — Agent contribution data
  // -------------------------------------------------------
  router.get(
    "/contributions/:address",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const address = req.params.address as string;

        const scoreResult = await pool.query(
          `SELECT cs.overall_score, cs.commits_score, cs.exec_score,
                  cs.projects_score, cs.lines_score, cs.collab_score,
                  cs.breakdown_cid, cs.computed_at, cs.synced_at
           FROM contribution_scores cs
           JOIN agents a ON a.id = cs.agent_id
           WHERE cs.address = $1`,
          [address],
        );

        const tagsResult = await pool.query(
          `SELECT et.tag, et.confidence, et.source
           FROM expertise_tags et
           JOIN agents a ON a.id = et.agent_id
           WHERE a.address = $1
           ORDER BY et.confidence DESC`,
          [address],
        );

        if (scoreResult.rows.length === 0 && tagsResult.rows.length === 0) {
          res.json({
            address,
            score: 0,
            breakdown: { commits: 0, exec: 0, projects: 0, lines: 0, collab: 0 },
            expertiseTags: [],
          });
          return;
        }

        const row = scoreResult.rows[0];

        res.json({
          address,
          score: row?.overall_score ?? 0,
          breakdown: {
            commits: row?.commits_score ?? 0,
            exec: row?.exec_score ?? 0,
            projects: row?.projects_score ?? 0,
            lines: row?.lines_score ?? 0,
            collab: row?.collab_score ?? 0,
          },
          breakdownCid: row?.breakdown_cid ?? null,
          computedAt: row?.computed_at?.toISOString() ?? null,
          syncedAt: row?.synced_at?.toISOString() ?? null,
          expertiseTags: tagsResult.rows.map((t) => ({
            tag: t.tag,
            confidence: t.confidence,
            source: t.source,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "contributions-get-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch contribution data." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/contributions/sync — Trigger manual sync
  // -------------------------------------------------------
  router.post(
    "/contributions/sync",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        // Admin-only: only the sync owner can trigger expensive batch computation
        if (!adminAddress || req.agent?.address?.toLowerCase() !== adminAddress.toLowerCase()) {
          logSecurityEvent("warn", "contributions-sync-unauthorized", {
            agentId: req.agent?.id,
            address: req.agent?.address,
          });
          res.status(403).json({ error: "Only the sync admin can trigger contribution sync." });
          return;
        }

        // Compute scores
        await scorer.computeAllScores();

        // Profile expertise
        await profiler.profileAllAgents();

        // Sync to chain (if configured)
        let syncResult: SyncCycleResult | null = null;
        if (onChainSync) {
          syncResult = await onChainSync.runSyncCycle();
        }

        logSecurityEvent("info", "contributions-sync-complete", {
          agentId: req.agent?.id,
          agentsSynced: syncResult?.agentsSynced ?? 0,
        });

        res.json({
          message: "Sync cycle complete.",
          agentsSynced: syncResult?.agentsSynced ?? 0,
          txHashes: syncResult?.txHashes ?? [],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "contributions-sync-failed", { error: message });
        res.status(500).json({ error: "Sync cycle failed." });
      }
    },
  );

  return router;
}
