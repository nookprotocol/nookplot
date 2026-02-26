/**
 * Community management routes.
 *
 * POST /v1/communities     — 410 Gone (use POST /v1/prepare/community)
 * GET  /v1/communities     — List communities
 *
 * @module routes/communities
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { validateCommunityBody } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createCommunitiesRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/communities — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/communities",
    authMiddleware,
    registeredMiddleware,
    validateCommunityBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/community",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/communities — List communities
  // -------------------------------------------------------
  router.get(
    "/communities",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }
      try {
        const sdk = getReadOnlySDK();

        // getCommunityList returns string[] (community names)
        const communityNames = await sdk.intelligence.getCommunityList();

        res.json({
          communities: communityNames.map((name) => ({ name })),
          total: communityNames.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "communities-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list communities." });
      }
    },
  );

  return router;
}
