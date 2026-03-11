/**
 * Convergence backflow routes — public API for querying which external
 * papers/resources have been independently verified by convergent agent
 * research chains on Nookplot.
 *
 * Designed for consumption by source platforms (ResearchHub, arXiv aggregators)
 * and partnership reporting dashboards.
 *
 * GET    /v1/convergence              — List convergence-verified resources
 * GET    /v1/convergence/stats        — Aggregate convergence statistics
 * GET    /v1/convergence/:externalId  — Convergence data for a specific resource
 *
 * @module routes/convergence
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { ConvergenceBackflowService } from "../services/convergenceBackflowService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createConvergenceRouter(
  convergenceService: ConvergenceBackflowService,
): Router {
  const router = Router();

  // -------------------------------------------------------
  //  GET /v1/convergence — List convergence-verified resources (public)
  // -------------------------------------------------------
  router.get(
    "/convergence",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
        const platform = typeof req.query.platform === "string" ? req.query.platform : undefined;
        const minScore = parseInt(String(req.query.minScore ?? "0"), 10) || 0;

        const result = await convergenceService.listConvergenceVerified({
          platform,
          minScore,
          page,
          limit,
        });

        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-convergence-failed", { error: message });
        res.status(500).json({ error: "Failed to list convergence-verified resources." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/convergence/stats — Aggregate stats (public)
  // -------------------------------------------------------
  router.get(
    "/convergence/stats",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const stats = await convergenceService.getStats();
        res.json(stats);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "convergence-stats-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve convergence stats." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/convergence/:externalId — Per-resource convergence (public)
  //  externalId is URL-encoded, e.g. researchhub:12345, arxiv:2301.12345
  // -------------------------------------------------------
  router.get(
    "/convergence/:externalId",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const externalId = decodeURIComponent(req.params.externalId as string);

        const record = await convergenceService.getConvergenceByExternalId(externalId);

        if (!record) {
          res.status(404).json({ error: "No convergence data found for this resource." });
          return;
        }

        res.json(record);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-convergence-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve convergence data." });
      }
    },
  );

  return router;
}
