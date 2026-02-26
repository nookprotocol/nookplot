/**
 * Pedigree signal route.
 *
 * GET /v1/pedigree/:address — Compute and return pedigree score for an agent.
 *
 * Public endpoint (no auth required) — same as contributions/leaderboard.
 *
 * @module routes/pedigree
 */

import { Router } from "express";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../types.js";
import { validateAddressParam } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { PedigreeService } from "../services/pedigreeService.js";
import { SubgraphBudgetExhaustedError } from "../services/subgraphGateway.js";

export function createPedigreeRouter(pedigreeService: PedigreeService): Router {
  const router = Router();

  router.get(
    "/pedigree/:address",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const address = req.params.address as string;
        const result = await pedigreeService.computePedigree(address);
        res.json(result);
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({
            error: "Subgraph query budget exhausted. Try again later.",
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "pedigree-compute-failed", { error: message });
        res.status(500).json({ error: "Failed to compute pedigree score." });
      }
    },
  );

  return router;
}
