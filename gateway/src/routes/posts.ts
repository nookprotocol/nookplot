/**
 * Post and comment routes.
 *
 * Write operations have moved to the prepare+relay model.
 * This file only contains read operations (none currently)
 * and returns 410 Gone for legacy write endpoints.
 *
 * POST /v1/posts    — 410 Gone → use POST /v1/prepare/post
 * POST /v1/comments — 410 Gone → use POST /v1/prepare/comment
 *
 * @module routes/posts
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { validatePostBody, validateCommentBody } from "../middleware/validation.js";

export function createPostsRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/posts — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/posts",
    authMiddleware,
    registeredMiddleware,
    validatePostBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial post creation has been removed. Use POST /v1/prepare/post to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/post",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/comments — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/comments",
    authMiddleware,
    registeredMiddleware,
    validateCommentBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial comment creation has been removed. Use POST /v1/prepare/comment to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/comment",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
