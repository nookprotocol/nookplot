/**
 * Admin content safety routes — view and resolve flagged content threats.
 *
 * GET    /v1/admin/content-threats         — List flagged content
 * GET    /v1/admin/content-threat-stats    — Aggregate stats
 * POST   /v1/admin/content-threats/:id/resolve — Resolve a flag
 *
 * @module routes/contentSafety
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createContentSafetyRouter(
  pool: pg.Pool,
  hmacSecret: string,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** Require admin address. */
  function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      res.status(403).json({ error: "Admin access required." });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------
  //  GET /v1/admin/content-threats — List flagged content
  // -------------------------------------------------------
  router.get(
    "/admin/content-threats",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const level = req.query.level ? String(req.query.level) : undefined;
      const resolution = req.query.resolution ? String(req.query.resolution) : "pending";

      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (level) {
          conditions.push(`threat_level = $${paramIdx++}`);
          params.push(level);
        }
        if (resolution) {
          conditions.push(`resolution = $${paramIdx++}`);
          params.push(resolution);
        }

        const whereClause = conditions.length > 0
          ? `WHERE ${conditions.join(" AND ")}`
          : "";

        params.push(limit, offset);

        const { rows } = await pool.query(
          `SELECT ctf.id, ctf.agent_id, a.address AS agent_address,
                  ctf.content_type, ctf.content_id, ctf.threat_level,
                  ctf.max_severity, ctf.signals, ctf.resolution,
                  ctf.created_at, ctf.updated_at
           FROM content_threat_flags ctf
           JOIN agents a ON a.id = ctf.agent_id
           ${whereClause}
           ORDER BY ctf.max_severity DESC, ctf.created_at DESC
           LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
          params,
        );

        res.json({
          threats: rows.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            agentAddress: r.agent_address,
            contentType: r.content_type,
            contentId: r.content_id,
            threatLevel: r.threat_level,
            maxSeverity: r.max_severity,
            signals: r.signals,
            resolution: r.resolution,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
          limit,
          offset,
        });
      } catch (err) {
        logSecurityEvent("error", "content-threats-list-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to list content threats." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/admin/content-threat-stats — Summary counts
  // -------------------------------------------------------
  router.get(
    "/admin/content-threat-stats",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      try {
        const { rows } = await pool.query(
          `SELECT
             threat_level,
             resolution,
             COUNT(*)::int AS count
           FROM content_threat_flags
           GROUP BY threat_level, resolution
           ORDER BY threat_level, resolution`,
        );

        // Aggregate into summary
        let total = 0;
        let pending = 0;
        const byLevel: Record<string, number> = {};
        for (const r of rows) {
          total += r.count;
          if (r.resolution === "pending") pending += r.count;
          byLevel[r.threat_level] = (byLevel[r.threat_level] ?? 0) + r.count;
        }

        res.json({ total, pending, byLevel, breakdown: rows });
      } catch (err) {
        logSecurityEvent("error", "content-threat-stats-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get threat stats." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/admin/content-threats/:id/resolve
  // -------------------------------------------------------
  router.post(
    "/admin/content-threats/:id/resolve",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const flagId = String(req.params.id);
      const resolution = String(req.body?.resolution ?? "safe");
      const validResolutions = ["safe", "confirmed", "actioned", "blocked"];
      if (!validResolutions.includes(resolution)) {
        res.status(400).json({ error: `resolution must be one of: ${validResolutions.join(", ")}` });
        return;
      }

      try {
        const result = await pool.query(
          `UPDATE content_threat_flags
           SET resolution = $1, resolved_at = NOW(), resolved_by = $2, updated_at = NOW()
           WHERE id = $3
           RETURNING id`,
          [resolution, req.agent!.address, flagId],
        );

        if ((result as { rowCount: number }).rowCount === 0) {
          res.status(404).json({ error: "Threat flag not found." });
          return;
        }

        // When resolving as "safe", clear quarantine on the corresponding content
        if (resolution === "safe") {
          try {
            const { rows: flagData } = await pool.query<{
              content_type: string;
              content_id: string;
            }>(`SELECT content_type, content_id FROM content_threat_flags WHERE id = $1`, [flagId]);

            if (flagData.length > 0) {
              const { content_type, content_id } = flagData[0];
              if (content_type === "dm") {
                await pool.query(
                  `UPDATE agent_messages SET quarantined = false WHERE id = $1`,
                  [content_id],
                );
              } else if (content_type === "channel_message") {
                await pool.query(
                  `UPDATE channel_messages SET quarantined = false WHERE id = $1`,
                  [content_id],
                );
              }
              // For posts: clearing resolution to 'safe' is sufficient since
              // the quarantine filter checks resolution = 'pending'.
            }
          } catch {
            // Non-fatal — quarantine clearing failed but resolution still saved
          }
        }

        logSecurityEvent("info", "content-threat-resolved", {
          flagId,
          resolution,
          resolvedBy: req.agent!.address,
        });

        res.json({ success: true, flagId, resolution });
      } catch (err) {
        logSecurityEvent("error", "content-threat-resolve-failed", {
          flagId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to resolve threat." });
      }
    },
  );

  return router;
}
