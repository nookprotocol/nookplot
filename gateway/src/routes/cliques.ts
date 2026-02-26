/**
 * Clique lifecycle routes.
 *
 * POST   /v1/cliques              — 410 Gone (use POST /v1/prepare/clique)
 * GET    /v1/cliques              — List cliques
 * GET    /v1/cliques/suggest      — AI-suggested cliques
 * GET    /v1/cliques/agent/:addr  — Cliques for an agent
 * GET    /v1/cliques/:id          — Clique detail
 * POST   /v1/cliques/:id/approve  — 410 Gone (use POST /v1/prepare/clique/:id/approve)
 * POST   /v1/cliques/:id/reject   — 410 Gone (use POST /v1/prepare/clique/:id/reject)
 * POST   /v1/cliques/:id/leave    — 410 Gone (use POST /v1/prepare/clique/:id/leave)
 * POST   /v1/cliques/:id/spawn    — 410 Gone (use POST /v1/prepare/clique/:id/spawn)
 *
 * @module routes/cliques
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CliqueDetector } from "../services/cliqueDetector.js";
import type { CreditManager } from "../services/creditManager.js";

export function createCliquesRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  cliqueDetector?: CliqueDetector,
  _creditManager?: CreditManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/cliques — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/cliques",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/clique",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/cliques — List cliques (from on-chain)
  // -------------------------------------------------------
  router.get(
    "/cliques",
    authMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const sdk = getReadOnlySDK();
        const count = await sdk.contracts.getCliqueCount();

        // Return basic count info — detailed queries use subgraph
        res.json({ totalCliques: count });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "list-cliques-failed", { error: message });
        res.status(500).json({ error: "Failed to list cliques." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/cliques/suggest — AI-suggested cliques
  // -------------------------------------------------------
  router.get(
    "/cliques/suggest",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      if (!cliqueDetector) {
        res.status(501).json({ error: "Clique detection not configured (no subgraph endpoint)." });
        return;
      }

      const agent = req.agent!;
      const limit = parseInt(String(req.query.limit ?? "3"), 10);

      try {
        const suggestions = await cliqueDetector.suggestCliques(agent.address, limit);
        res.json({ suggestions });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "suggest-cliques-failed", { error: message });
        res.status(500).json({ error: "Failed to suggest cliques." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/cliques/agent/:address — Cliques for an agent
  // -------------------------------------------------------
  router.get(
    "/cliques/agent/:address",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const targetAddress = req.params.address as string;

      try {
        const sdk = getReadOnlySDK();
        const cliqueIds = await sdk.contracts.getAgentCliques(targetAddress);
        res.json({ address: targetAddress, cliqueIds });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-agent-cliques-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve agent cliques." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/cliques/:id — Clique detail
  // -------------------------------------------------------
  router.get(
    "/cliques/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const cliqueId = parseInt(req.params.id as string, 10);

      if (isNaN(cliqueId) || cliqueId < 0) {
        res.status(400).json({ error: "Invalid clique ID." });
        return;
      }

      try {
        const sdk = getReadOnlySDK();
        const [info, members] = await Promise.all([
          sdk.contracts.getClique(cliqueId),
          sdk.contracts.getCliqueMembers(cliqueId),
        ]);
        res.json({ ...info, members });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSecurityEvent("error", "get-clique-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to retrieve clique." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/cliques/:id/approve — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/cliques/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/clique/:id/approve",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/cliques/:id/reject — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/cliques/:id/reject",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/clique/:id/reject",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/cliques/:id/leave — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/cliques/:id/leave",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/clique/:id/leave",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/cliques/:id/spawn — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/cliques/:id/spawn",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/clique/:id/spawn",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
