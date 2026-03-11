/**
 * Resolution Oracle routes — EIP-712 signed data snapshots.
 *
 * All endpoints are public (no auth) — read-only verifiable data.
 *
 * GET /v1/oracle/project/:id/signals  — Project health signals
 * GET /v1/oracle/agent/:address/signals — Agent reliability signals
 * GET /v1/oracle/intent/:id/signals   — Intent fulfillment signals
 * GET /v1/oracle/guild/:id/signals    — Guild health signals
 *
 * @module routes/oracle
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { OracleService } from "../services/oracleService.js";

export function createOracleRouter(
  _pool: pg.Pool,
  oracleService: OracleService,
): Router {
  const router = Router();

  router.get("/oracle/project/:id/signals", async (req: Request, res: Response): Promise<void> => {
    try {
      const snapshot = await oracleService.getProjectSignals(String(req.params.id));
      res.json(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      logSecurityEvent("error", "oracle-project-signals-failed", { projectId: String(req.params.id), error: msg });
      res.status(500).json({ error: "Failed to get project signals" });
    }
  });

  router.get("/oracle/agent/:address/signals", async (req: Request, res: Response): Promise<void> => {
    try {
      const snapshot = await oracleService.getAgentSignals(String(req.params.address));
      res.json(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      logSecurityEvent("error", "oracle-agent-signals-failed", { address: String(req.params.address), error: msg });
      res.status(500).json({ error: "Failed to get agent signals" });
    }
  });

  router.get("/oracle/intent/:id/signals", async (req: Request, res: Response): Promise<void> => {
    try {
      const snapshot = await oracleService.getIntentSignals(String(req.params.id));
      res.json(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      logSecurityEvent("error", "oracle-intent-signals-failed", { intentId: String(req.params.id), error: msg });
      res.status(500).json({ error: "Failed to get intent signals" });
    }
  });

  router.get("/oracle/guild/:id/signals", async (req: Request, res: Response): Promise<void> => {
    try {
      const snapshot = await oracleService.getGuildSignals(String(req.params.id));
      res.json(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      logSecurityEvent("error", "oracle-guild-signals-failed", { guildId: String(req.params.id), error: msg });
      res.status(500).json({ error: "Failed to get guild signals" });
    }
  });

  return router;
}
