/**
 * Treasury operations routes — scheduled ops + budget earmarks.
 *
 * POST   /v1/treasury-ops               — Create scheduled operation
 * GET    /v1/treasury-ops               — List operations
 * PATCH  /v1/treasury-ops/:id           — Update operation
 * DELETE /v1/treasury-ops/:id           — Delete operation
 * POST   /v1/treasury-ops/:id/run       — Manual trigger
 * GET    /v1/treasury-ops/:id/history   — Execution history
 * POST   /v1/budgets                    — Create earmark
 * GET    /v1/budgets                    — List earmarks
 * PATCH  /v1/budgets/:id               — Update earmark
 * DELETE /v1/budgets/:id               — Delete earmark
 *
 * @module routes/treasury-ops
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { TreasuryOpsService, OpType } from "../services/treasuryOpsService.js";

const VALID_OP_TYPES: OpType[] = ["auto_sweep", "scheduled_transfer", "auto_distribute", "balance_alert"];

export function createTreasuryOpsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  treasuryOpsService: TreasuryOpsService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /* ---- Create scheduled operation ---- */
  router.post("/treasury-ops", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { opType, schedule, rules, guildId } = req.body;

      if (!opType || !VALID_OP_TYPES.includes(opType)) {
        res.status(400).json({ error: `Invalid opType. Must be one of: ${VALID_OP_TYPES.join(", ")}` });
        return;
      }
      if (!schedule || typeof schedule !== "object") {
        res.status(400).json({ error: "schedule is required and must be an object" });
        return;
      }
      if (!rules || typeof rules !== "object") {
        res.status(400).json({ error: "rules is required and must be an object" });
        return;
      }

      const op = await treasuryOpsService.createOp({
        agentId: agent.id,
        guildId,
        opType,
        schedule,
        rules,
      });

      res.status(201).json(op);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "treasury-op-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create treasury operation" });
    }
  });

  /* ---- List operations ---- */
  router.get("/treasury-ops", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const guildId = req.query.guildId as string | undefined;
      const ops = await treasuryOpsService.listOps(agent.id, { guildId });
      res.json({ operations: ops });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "treasury-op-list-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to list treasury operations" });
    }
  });

  /* ---- Update operation ---- */
  router.patch("/treasury-ops/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const existing = await treasuryOpsService.getOp(String(req.params.id));
      if (!existing) { res.status(404).json({ error: "Operation not found" }); return; }
      if (existing.agentId !== agent.id) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }

      const { schedule, rules, enabled } = req.body;
      const updated = await treasuryOpsService.updateOp(String(req.params.id), {
        schedule, rules, enabled,
      });

      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "treasury-op-update-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to update treasury operation" });
    }
  });

  /* ---- Delete operation ---- */
  router.delete("/treasury-ops/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const existing = await treasuryOpsService.getOp(String(req.params.id));
      if (!existing) { res.status(404).json({ error: "Operation not found" }); return; }
      if (existing.agentId !== agent.id) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }

      await treasuryOpsService.deleteOp(String(req.params.id));
      res.json({ deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "treasury-op-delete-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to delete treasury operation" });
    }
  });

  /* ---- Manual trigger ---- */
  router.post("/treasury-ops/:id/run", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const existing = await treasuryOpsService.getOp(String(req.params.id));
      if (!existing) { res.status(404).json({ error: "Operation not found" }); return; }
      if (existing.agentId !== agent.id) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }

      const result = await treasuryOpsService.runOpNow(String(req.params.id));
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "treasury-op-run-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to run treasury operation" });
    }
  });

  /* ---- Execution history ---- */
  router.get("/treasury-ops/:id/history", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const existing = await treasuryOpsService.getOp(String(req.params.id));
      if (!existing) { res.status(404).json({ error: "Operation not found" }); return; }
      if (existing.agentId !== agent.id) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }

      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const history = await treasuryOpsService.getOpHistory(String(req.params.id), { limit });
      res.json({ history });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "treasury-op-history-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to get operation history" });
    }
  });

  /* ---- Create earmark ---- */
  router.post("/budgets", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { label, allocated, description } = req.body;

      if (!label || typeof label !== "string") {
        res.status(400).json({ error: "label is required" });
        return;
      }
      if (!allocated || typeof allocated !== "number" || allocated <= 0) {
        res.status(400).json({ error: "allocated must be a positive number" });
        return;
      }

      const earmark = await treasuryOpsService.createEarmark({
        agentId: agent.id,
        label,
        allocated,
        description,
      });

      res.status(201).json(earmark);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        res.status(409).json({ error: "Earmark with this label already exists" });
        return;
      }
      logSecurityEvent("error", "earmark-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create earmark" });
    }
  });

  /* ---- List earmarks ---- */
  router.get("/budgets", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const earmarks = await treasuryOpsService.listEarmarks(agent.id);
      res.json({ earmarks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "earmark-list-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to list earmarks" });
    }
  });

  /* ---- Update earmark ---- */
  router.patch("/budgets/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { allocated, description } = req.body;
      const updated = await treasuryOpsService.updateEarmark(String(req.params.id), {
        allocated, description,
      });

      if (!updated) { res.status(404).json({ error: "Earmark not found" }); return; }
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "earmark-update-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to update earmark" });
    }
  });

  /* ---- Delete earmark ---- */
  router.delete("/budgets/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const deleted = await treasuryOpsService.deleteEarmark(String(req.params.id));
      if (!deleted) { res.status(404).json({ error: "Earmark not found" }); return; }
      res.json({ deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "earmark-delete-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to delete earmark" });
    }
  });

  return router;
}
