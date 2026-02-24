/**
 * Agent deployment lifecycle routes.
 *
 * POST   /v1/deployments              — 410 Gone (use POST /v1/prepare/deployment)
 * POST   /v1/deployments/spawn        — 410 Gone (use POST /v1/prepare/deployment/spawn)
 * GET    /v1/deployments              — List deployments
 * GET    /v1/deployments/:id          — Deployment detail
 * GET    /v1/deployments/tree/:address — Spawn tree
 * PUT    /v1/deployments/:id/soul     — 410 Gone (use POST /v1/prepare/deployment/:id/soul)
 *
 * @module routes/deployments
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "../services/creditManager.js";
import type { ByokManager } from "../services/byokManager.js";
import type { SelfImprovementEngine } from "../services/selfImprovementEngine.js";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import { SubgraphBudgetExhaustedError } from "../services/subgraphGateway.js";

export function createDeploymentsRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  _creditManager?: CreditManager,
  _byokManager?: ByokManager,
  _improvementEngine?: SelfImprovementEngine,
  subgraphGateway?: SubgraphGateway,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/deployments — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/deployments",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/deployment",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/deployments/spawn — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/deployments/spawn",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/deployment/spawn",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/deployments — List deployments (from subgraph)
  // -------------------------------------------------------
  router.get(
    "/deployments",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);

        const query = `{
          agentDeployments(
            orderBy: createdAt
            orderDirection: desc
            first: ${first}
            skip: ${skip}
          ) {
            id
            deploymentId
            creator { id }
            agentAddress
            bundle { id bundleId name }
            soulCid
            deploymentFee
            contributorPayout
            treasuryPayout
            creditPayout
            curatorPayout
            parentAgent
            isSpawn
            createdAt
          }
        }`;

        const sgResult = await subgraphGateway.query<{ agentDeployments?: unknown[] }>(query);

        res.json({
          deployments: sgResult.data?.agentDeployments ?? [],
          first,
          skip,
        });
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "deployments-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list deployments." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/deployments/:id — Deployment detail
  // -------------------------------------------------------
  router.get(
    "/deployments/:id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const deploymentId = req.params.id;
        if (!/^\d+$/.test(deploymentId as string)) {
          res.status(400).json({ error: "Deployment ID must be a number." });
          return;
        }

        const query = `{
          agentDeployments(where: { deploymentId: ${deploymentId} }, first: 1) {
            id
            deploymentId
            creator { id }
            agentAddress
            bundle { id bundleId name }
            soulCid
            deploymentFee
            contributorPayout
            treasuryPayout
            creditPayout
            curatorPayout
            parentAgent
            isSpawn
            createdAt
          }
        }`;

        const sgResult = await subgraphGateway.query<{ agentDeployments?: unknown[] }>(query);
        const deployments = sgResult.data?.agentDeployments ?? [];

        if (deployments.length === 0) {
          res.status(404).json({ error: "Deployment not found." });
          return;
        }

        res.json(deployments[0]);
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "deployment-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch deployment." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/deployments/tree/:address — Spawn tree
  // -------------------------------------------------------
  router.get(
    "/deployments/tree/:address",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const address = (req.params.address as string | undefined)?.toLowerCase();
        if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
          res.status(400).json({ error: "Valid Ethereum address required." });
          return;
        }

        const query = `{
          spawnRelations(
            where: { parent: "${address}" }
            orderBy: createdAt
            orderDirection: desc
            first: 100
          ) {
            id
            parent { id }
            child { id soulCid }
            deployment { deploymentId soulCid bundle { bundleId name } }
            createdAt
          }
        }`;

        const sgResult = await subgraphGateway.query<{ spawnRelations?: unknown[] }>(query);

        res.json({
          address,
          children: sgResult.data?.spawnRelations ?? [],
        });
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "spawn-tree-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch spawn tree." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/deployments/:id/soul — 410 Gone
  // -------------------------------------------------------
  router.put(
    "/deployments/:id/soul",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/deployment/:id/soul",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
