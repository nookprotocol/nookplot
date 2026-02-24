/**
 * Sybil detection admin routes.
 *
 * All endpoints are admin-only (require sync owner key address match).
 *
 * GET    /v1/sybil/scores           — Paginated suspicion scores
 * GET    /v1/sybil/scores/:address  — Per-agent score
 * GET    /v1/sybil/signals/:address — Fraud signals for an agent
 * POST   /v1/sybil/resolve/:signalId — Resolve a signal
 * POST   /v1/sybil/scan             — Trigger manual scan
 *
 * @module routes/sybil
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import type { SybilDetector } from "../services/sybilDetector.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createSybilRouter(
  pool: pg.Pool,
  hmacSecret: string,
  sybilDetector: SybilDetector,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // Admin-only middleware
  const adminOnly = (req: AuthenticatedRequest, res: Response, next: () => void) => {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };

  // -------------------------------------------------------
  //  GET /v1/sybil/scores — Paginated suspicion scores
  // -------------------------------------------------------
  router.get(
    "/sybil/scores",
    authMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 100);
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
        const result = await sybilDetector.getScores(limit, offset);
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "sybil-route-error", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/sybil/scores/:address — Per-agent score
  // -------------------------------------------------------
  router.get(
    "/sybil/scores/:address",
    authMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const score = await sybilDetector.getScoreByAddress(req.params.address as string);
        if (!score) {
          res.json({ suspicionScore: 0, signalCount: 0 });
          return;
        }
        res.json(score);
      } catch (err) {
        logSecurityEvent("error", "sybil-route-error", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/sybil/signals/:address — Fraud signals for an agent
  // -------------------------------------------------------
  router.get(
    "/sybil/signals/:address",
    authMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const signals = await sybilDetector.getSignalsByAddress(req.params.address as string);
        res.json({ signals });
      } catch (err) {
        logSecurityEvent("error", "sybil-route-error", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/sybil/resolve/:signalId — Resolve a signal
  // -------------------------------------------------------
  router.post(
    "/sybil/resolve/:signalId",
    authMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { resolution } = req.body;
        if (!resolution || !["resolved", "dismissed"].includes(resolution)) {
          res.status(400).json({ error: "resolution must be 'resolved' or 'dismissed'" });
          return;
        }
        const ok = await sybilDetector.resolveSignal(
          req.params.signalId as string,
          resolution,
          req.agent!.address,
        );
        if (!ok) {
          res.status(404).json({ error: "Signal not found or already resolved" });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        logSecurityEvent("error", "sybil-route-error", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/sybil/scan — Trigger manual scan
  // -------------------------------------------------------
  router.post(
    "/sybil/scan",
    authMiddleware,
    adminOnly,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const result = await sybilDetector.runScan();
        res.json(result);
      } catch (err) {
        logSecurityEvent("error", "sybil-route-error", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
}
