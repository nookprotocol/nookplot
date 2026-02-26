/**
 * Knowledge Bundle lifecycle routes.
 *
 * POST   /v1/bundles              — 410 Gone (use POST /v1/prepare/bundle)
 * GET    /v1/bundles              — List bundles
 * GET    /v1/bundles/:id          — Get bundle detail
 * POST   /v1/bundles/:id/content  — 410 Gone (use POST /v1/prepare/bundle/:id/content)
 * POST   /v1/bundles/:id/content/remove — 410 Gone
 * POST   /v1/bundles/:id/contributors   — 410 Gone
 * DELETE /v1/bundles/:id          — 410 Gone
 *
 * @module routes/bundles
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SubgraphGateway } from "../services/subgraphGateway.js";
import { SubgraphBudgetExhaustedError } from "../services/subgraphGateway.js";

export function createBundlesRouter(
  pool: pg.Pool,
  sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
  subgraphGateway?: SubgraphGateway,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/bundles — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bundles — List bundles (from subgraph)
  // -------------------------------------------------------
  router.get(
    "/bundles",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const first = Math.min(Math.max(parseInt(String(req.query.first ?? "20"), 10) || 20, 1), 100);
        const skip = Math.max(parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);
        const activeOnly = req.query.active !== "false";

        let whereClause = "";
        const conditions: string[] = [];
        if (activeOnly) {
          conditions.push("isActive: true");
        }
        if (conditions.length > 0) {
          whereClause = `where: { ${conditions.join(", ")} }`;
        }

        const query = `{
          knowledgeBundles(
            ${whereClause}
            orderBy: createdAt
            orderDirection: desc
            first: ${first}
            skip: ${skip}
          ) {
            id
            bundleId
            creator { id }
            name
            descriptionCid
            contentCids
            contributorCount
            cidCount
            createdAt
            isActive
          }
        }`;

        const sgResult = await subgraphGateway.query<{ knowledgeBundles?: unknown[] }>(query);

        res.json({
          bundles: sgResult.data?.knowledgeBundles ?? [],
          first,
          skip,
        });
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bundles-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list bundles." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/bundles/:id — Bundle detail
  // -------------------------------------------------------
  router.get(
    "/bundles/:id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        if (!subgraphGateway) {
          res.status(503).json({ error: "Subgraph not configured." });
          return;
        }

        const bundleId = req.params.id;
        if (!/^\d+$/.test(bundleId as string)) {
          res.status(400).json({ error: "Bundle ID must be a number." });
          return;
        }

        // Use bundleId field for lookup — entity id is bytes
        const query = `{
          knowledgeBundles(where: { bundleId: ${bundleId} }, first: 1) {
            id
            bundleId
            creator { id }
            name
            descriptionCid
            contentCids
            cidCount
            contributorCount
            createdAt
            isActive
            contributors {
              id
              contributor { id }
              weightBps
            }
          }
        }`;

        const sgResult = await subgraphGateway.query<{ knowledgeBundles?: unknown[] }>(query);
        const bundles = sgResult.data?.knowledgeBundles ?? [];

        if (bundles.length === 0) {
          res.status(404).json({ error: "Bundle not found." });
          return;
        }

        res.json(bundles[0]);
      } catch (error) {
        if (error instanceof SubgraphBudgetExhaustedError) {
          res.status(503).json({ error: "Subgraph query budget exhausted." });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "bundle-detail-failed", { error: message });
        res.status(500).json({ error: "Failed to fetch bundle." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/:id/content — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles/:id/content",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/content",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/:id/content/remove — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles/:id/content/remove",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/content/remove",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/bundles/:id/contributors — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/bundles/:id/contributors",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/contributors",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/bundles/:id — 410 Gone
  // -------------------------------------------------------
  router.delete(
    "/bundles/:id",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/bundle/:id/deactivate",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
