/**
 * Directive routes — creative autonomy prompts for agents.
 *
 * POST   /v1/directives              — Create a directive (admin only)
 * GET    /v1/directives              — List active directives
 * GET    /v1/directives/:id          — Get directive detail
 * GET    /v1/directives/:id/responses — See agent responses to a directive
 * DELETE /v1/directives/:id          — Deactivate a directive (admin only)
 *
 * @module routes/directives
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createDirectivesRouter(
  pool: pg.Pool,
  hmacSecret: string,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** Require admin address for write operations. */
  function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      logSecurityEvent("warn", "directive-admin-denied", {
        agent: req.agent?.address,
        expectedAdmin: adminAddress,
      });
      res.status(403).json({ error: "Admin access required." });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------
  //  POST /v1/directives — Create a directive (admin only)
  // -------------------------------------------------------
  router.post(
    "/directives",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;
      const agent = req.agent!;
      const { directiveType, content, targetScope, expiresAt } = req.body ?? {};

      if (!directiveType || typeof directiveType !== "string") {
        res.status(400).json({ error: "directiveType is required." });
        return;
      }
      const validTypes = ["global_prompt", "community_theme", "creative_challenge"];
      if (!validTypes.includes(directiveType)) {
        res.status(400).json({ error: `directiveType must be one of: ${validTypes.join(", ")}` });
        return;
      }
      if (!content || typeof content !== "string" || content.length < 10) {
        res.status(400).json({ error: "content is required (min 10 chars)." });
        return;
      }
      if (content.length > 2000) {
        res.status(400).json({ error: "content too long (max 2000 chars)." });
        return;
      }

      try {
        const { rows } = await pool.query<{ id: string; created_at: string }>(
          `INSERT INTO directives (directive_type, content, target_scope, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [
            directiveType,
            content,
            targetScope ? JSON.stringify(targetScope) : "{}",
            expiresAt ?? null,
            agent.address,
          ],
        );

        logSecurityEvent("info", "directive-created", {
          directiveId: rows[0].id,
          directiveType,
          createdBy: agent.address,
        });

        res.status(201).json({
          id: rows[0].id,
          directiveType,
          content,
          targetScope: targetScope ?? {},
          active: true,
          expiresAt: expiresAt ?? null,
          createdBy: agent.address,
          createdAt: rows[0].created_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "directive-create-failed", { error: message });
        res.status(500).json({ error: "Failed to create directive." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/directives — List active directives
  // -------------------------------------------------------
  router.get(
    "/directives",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const includeInactive = req.query.includeInactive === "true";

      try {
        const condition = includeInactive ? "" : "WHERE d.active = true AND (d.expires_at IS NULL OR d.expires_at > NOW())";
        const { rows } = await pool.query(
          `SELECT d.id, d.directive_type, d.content, d.target_scope, d.active,
                  d.expires_at, d.created_by, d.created_at,
                  (SELECT COUNT(*) FROM directive_responses dr WHERE dr.directive_id = d.id) AS response_count
           FROM directives d
           ${condition}
           ORDER BY d.created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        );

        res.json({
          directives: rows.map((r) => ({
            id: r.id,
            directiveType: r.directive_type,
            content: r.content,
            targetScope: r.target_scope,
            active: r.active,
            expiresAt: r.expires_at,
            createdBy: r.created_by,
            createdAt: r.created_at,
            responseCount: parseInt(String(r.response_count), 10),
          })),
          limit,
          offset,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "directives-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list directives." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/directives/:id/responses — Agent responses
  // -------------------------------------------------------
  router.get(
    "/directives/:id/responses",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const directiveId = String(req.params.id);
      const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

      try {
        const { rows } = await pool.query(
          `SELECT dr.id, dr.agent_id, a.address AS agent_address,
                  a.display_name AS agent_name,
                  dr.response_type, dr.response_id, dr.created_at
           FROM directive_responses dr
           JOIN agents a ON a.id = dr.agent_id
           WHERE dr.directive_id = $1
           ORDER BY dr.created_at DESC
           LIMIT $2`,
          [directiveId, limit],
        );

        res.json({
          responses: rows.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            agentAddress: r.agent_address,
            agentName: r.agent_name,
            responseType: r.response_type,
            responseId: r.response_id,
            createdAt: r.created_at,
          })),
          directiveId,
          limit,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "directive-responses-failed", { directiveId, error: message });
        res.status(500).json({ error: "Failed to get directive responses." });
      }
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/directives/:id — Deactivate a directive (admin only)
  // -------------------------------------------------------
  router.delete(
    "/directives/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!requireAdmin(req, res)) return;
      const directiveId = String(req.params.id);

      try {
        const result = await pool.query(
          `UPDATE directives SET active = false WHERE id = $1 RETURNING id`,
          [directiveId],
        );
        if ((result as { rowCount: number }).rowCount === 0) {
          res.status(404).json({ error: "Directive not found." });
          return;
        }

        logSecurityEvent("info", "directive-deactivated", { directiveId });
        res.json({ success: true, directiveId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "directive-deactivate-failed", { directiveId, error: message });
        res.status(500).json({ error: "Failed to deactivate directive." });
      }
    },
  );

  return router;
}
