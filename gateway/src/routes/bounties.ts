/**
 * Bounty lifecycle routes.
 *
 * POST   /v1/bounties              — 410 Gone (use POST /v1/prepare/bounty)
 * GET    /v1/bounties              — List bounties
 * GET    /v1/bounties/:id          — Get bounty detail
 * POST   /v1/bounties/:id/claim    — 410 Gone (use POST /v1/prepare/bounty/:id/claim)
 * POST   /v1/bounties/:id/unclaim  — 410 Gone (use POST /v1/prepare/bounty/:id/unclaim)
 * POST   /v1/bounties/:id/submit   — 410 Gone (use POST /v1/prepare/bounty/:id/submit)
 * POST   /v1/bounties/:id/approve  — 410 Gone (use POST /v1/prepare/bounty/:id/approve)
 * POST   /v1/bounties/:id/dispute  — 410 Gone (use POST /v1/prepare/bounty/:id/dispute)
 * POST   /v1/bounties/:id/cancel   — 410 Gone (use POST /v1/prepare/bounty/:id/cancel)
 *
 * @module routes/bounties
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { validateBountyBody, validateSubmissionBody } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "../services/creditManager.js";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import { SubgraphBudgetExhaustedError } from "../services/subgraphGateway.js";

export function createBountiesRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  _creditManager?: CreditManager,
  subgraphGateway?: SubgraphGateway,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/bounties — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties",
    authMiddleware,
    registeredMiddleware,
    validateBountyBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bounties — List bounties (from subgraph)
  // -------------------------------------------------------
  router.get(
    "/bounties",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);
        const status = req.query.status !== undefined ? parseInt(String(req.query.status), 10) : null;
        const community = typeof req.query.community === "string" ? req.query.community : null;

        // Build GraphQL query with inline filters (parameterized via variables where possible)
        let whereClause = "";
        const conditions: string[] = [];
        if (status !== null && !isNaN(status)) {
          if (status < 0 || status > 6 || !Number.isInteger(status)) {
            res.status(400).json({ error: "status must be an integer between 0 and 6." });
            return;
          }
          conditions.push(`status: ${status}`);
        }
        if (community) {
          if (community.length > 128) {
            res.status(400).json({ error: "community parameter too long (max 128 chars)" });
            return;
          }
          // Sanitize: only allow valid community chars
          const safeCommunity = community.replace(/[^a-zA-Z0-9_-]/g, "");
          conditions.push(`community: "${safeCommunity}"`);
        }
        if (conditions.length > 0) {
          whereClause = `where: { ${conditions.join(", ")} }`;
        }

        const query = `{
          bounties(
            ${whereClause}
            orderBy: createdAt
            orderDirection: desc
            first: ${first}
            skip: ${skip}
          ) {
            id
            creator
            metadataCid
            community
            rewardAmount
            escrowType
            status
            claimer
            deadline
            createdAt
          }
        }`;

        const sgResult = await subgraphGateway.query<{ bounties?: unknown[] }>(query);

        res.json({
          bounties: sgResult.data?.bounties ?? [],
          first,
          skip,
        });
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounties-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list bounties." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bounties/:id — Bounty detail
  // -------------------------------------------------------
  router.get(
    "/bounties/:id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const bountyId = req.params.id;
        if (!/^\d+$/.test(bountyId as string)) {
          res.status(400).json({ error: "Bounty ID must be a number." });
          return;
        }

        const query = `{
          bounty(id: "${bountyId}") {
            id
            creator
            metadataCid
            community
            rewardAmount
            escrowType
            status
            claimer
            submissionCid
            deadline
            createdAt
            claimedAt
            submittedAt
          }
        }`;

        const sgResult = await subgraphGateway.query<{ bounty?: unknown }>(query);

        if (!sgResult.data?.bounty) {
          res.status(404).json({ error: "Bounty not found." });
          return;
        }

        res.json(sgResult.data.bounty);
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bounty-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch bounty." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/claim — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/claim",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty/:id/claim",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/unclaim — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/unclaim",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty/:id/unclaim",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/submit — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/submit",
    authMiddleware,
    registeredMiddleware,
    validateSubmissionBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty/:id/submit",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/approve — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty/:id/approve",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/dispute — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/dispute",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty/:id/dispute",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bounties/:id/cancel — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bounties/:id/cancel",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bounty/:id/cancel",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
