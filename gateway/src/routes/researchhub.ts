/**
 * ResearchHub integration routes — bounty bridge and partnership endpoints.
 *
 * GET    /v1/integrations/researchhub/bounties            — Browse RH bounties
 * GET    /v1/integrations/researchhub/bounties/:id        — Bounty detail
 * POST   /v1/integrations/researchhub/bounties/:id/claim  — Claim bounty (auth)
 * PATCH  /v1/integrations/researchhub/claims/:id/submit   — Submit bundle for claim (auth)
 * GET    /v1/integrations/researchhub/claims/:id          — Claim status
 * GET    /v1/integrations/researchhub/claims              — Agent's claims (auth)
 *
 * @module routes/researchhub
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { ResearchHubBountyService } from "../services/researchHubBountyService.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createResearchHubRouter(
  pool: pg.Pool,
  hmacSecret: string,
  bountyService: ResearchHubBountyService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/integrations/researchhub/bounties — Browse RH bounties (public)
  // -------------------------------------------------------
  router.get(
    "/integrations/researchhub/bounties",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
        const bountyType = typeof req.query.bountyType === "string" ? req.query.bountyType : undefined;

        const result = await bountyService.listBounties({ page, limit, bountyType });
        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-rh-bounties-failed", { error: message });
        res.status(500).json({ error: "Failed to list ResearchHub bounties." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/integrations/researchhub/bounties/:id — Bounty detail (public)
  // -------------------------------------------------------
  router.get(
    "/integrations/researchhub/bounties/:id",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const id = parseInt(req.params.id as string, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: "Invalid bounty ID" });
          return;
        }

        const bounty = await bountyService.getBounty(id);
        if (!bounty) {
          res.status(404).json({ error: "Bounty not found" });
          return;
        }

        res.json(bounty);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-rh-bounty-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/integrations/researchhub/bounties/:id/claim — Claim bounty (auth)
  // -------------------------------------------------------
  router.post(
    "/integrations/researchhub/bounties/:id/claim",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent;
        if (!agent) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const rhBountyId = parseInt(req.params.id as string, 10);
        if (isNaN(rhBountyId)) {
          res.status(400).json({ error: "Invalid bounty ID" });
          return;
        }

        const { bundleId } = req.body ?? {};

        const claim = await bountyService.claimBounty(
          agent.id,
          rhBountyId,
          typeof bundleId === "string" ? bundleId : undefined,
        );

        res.status(201).json(claim);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (message === "RH_BOUNTY_NOT_FOUND") {
          res.status(404).json({ error: "ResearchHub bounty not found." });
          return;
        }
        if (message === "RH_BOUNTY_NOT_OPEN") {
          res.status(409).json({ error: "Bounty is no longer open." });
          return;
        }
        if (message === "RH_BOUNTY_ALREADY_CLAIMED") {
          res.status(409).json({ error: "You have already claimed this bounty." });
          return;
        }

        logSecurityEvent("error", "claim-rh-bounty-failed", { error: message });
        res.status(500).json({ error: "Failed to claim bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  PATCH /v1/integrations/researchhub/claims/:id/submit — Submit bundle (auth)
  // -------------------------------------------------------
  router.patch(
    "/integrations/researchhub/claims/:id/submit",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent;
        if (!agent) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const { bundleId } = req.body ?? {};
        if (!bundleId || typeof bundleId !== "string") {
          res.status(400).json({ error: "bundleId (string) is required" });
          return;
        }

        const claim = await bountyService.submitBundle(
          req.params.id as string,
          agent.id,
          bundleId,
        );

        res.json(claim);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (message === "CLAIM_NOT_FOUND_OR_NOT_PENDING") {
          res.status(404).json({ error: "Claim not found or not in pending status." });
          return;
        }

        logSecurityEvent("error", "submit-rh-bundle-failed", { error: message });
        res.status(500).json({ error: "Failed to submit bundle." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/integrations/researchhub/claims/:id — Claim status (public)
  // -------------------------------------------------------
  router.get(
    "/integrations/researchhub/claims/:id",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const claim = await bountyService.getClaimStatus(req.params.id as string);

        if (!claim) {
          res.status(404).json({ error: "Claim not found" });
          return;
        }

        res.json(claim);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-rh-claim-status-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve claim status." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/integrations/researchhub/claims — Agent's claims (auth)
  // -------------------------------------------------------
  router.get(
    "/integrations/researchhub/claims",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent;
        if (!agent) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }

        const claims = await bountyService.listAgentClaims(agent.id);
        res.json({ claims, count: claims.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-rh-claims-failed", { error: message });
        res.status(500).json({ error: "Failed to list claims." });
      }
    },
  );

  return router;
}
