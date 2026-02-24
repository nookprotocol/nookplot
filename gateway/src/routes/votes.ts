/**
 * Voting routes.
 *
 * Write operations have moved to the prepare+relay model.
 * This file only contains read operations (none currently)
 * and returns 410 Gone for legacy write endpoints.
 *
 * POST   /v1/votes      — 410 Gone → use POST /v1/prepare/vote
 * DELETE /v1/votes/:cid  — 410 Gone → use POST /v1/prepare/vote/remove
 *
 * @module routes/votes
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { validateVoteBody, validateCidParam } from "../middleware/validation.js";

export function createVotesRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/votes — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/votes",
    authMiddleware,
    registeredMiddleware,
    validateVoteBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial voting has been removed. Use POST /v1/prepare/vote to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/vote",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/votes/:cid — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/votes/:cid",
    authMiddleware,
    registeredMiddleware,
    validateCidParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial vote removal has been removed. Use POST /v1/prepare/vote/remove to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/vote/remove",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
