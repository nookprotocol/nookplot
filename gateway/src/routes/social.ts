/**
 * Social interaction routes (follows, attestations, blocks).
 *
 * Write operations have moved to the prepare+relay model.
 * This file only contains read operations (none currently)
 * and returns 410 Gone for legacy write endpoints.
 *
 * POST   /v1/follows          — 410 Gone → use POST /v1/prepare/follow
 * DELETE /v1/follows/:target  — 410 Gone → use POST /v1/prepare/unfollow
 * POST   /v1/attestations         — 410 Gone → use POST /v1/prepare/attest
 * DELETE /v1/attestations/:target — 410 Gone → use POST /v1/prepare/attest (revoke)
 * POST   /v1/blocks           — 410 Gone → use POST /v1/prepare/block
 * DELETE /v1/blocks/:target   — 410 Gone → use POST /v1/prepare/block (unblock)
 *
 * @module routes/social
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import {
  validateTargetBody,
  validateAttestBody,
  validateTargetParam,
} from "../middleware/validation.js";

export function createSocialRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/follows — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/follows",
    authMiddleware,
    registeredMiddleware,
    validateTargetBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial follow has been removed. Use POST /v1/prepare/follow to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/follow",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/follows/:target — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/follows/:target",
    authMiddleware,
    registeredMiddleware,
    validateTargetParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial unfollow has been removed. Use POST /v1/prepare/unfollow to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/unfollow",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/attestations — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/attestations",
    authMiddleware,
    registeredMiddleware,
    validateAttestBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial attestation has been removed. Use POST /v1/prepare/attest to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/attest",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/attestations/:target — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/attestations/:target",
    authMiddleware,
    registeredMiddleware,
    validateTargetParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial attestation revocation has been removed. Use POST /v1/prepare/attest with revoke flag to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/attest",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  POST /v1/blocks — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.post(
    "/blocks",
    authMiddleware,
    registeredMiddleware,
    validateTargetBody,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial block has been removed. Use POST /v1/prepare/block to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/block",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  DELETE /v1/blocks/:target — 410 Gone (moved to prepare+relay)
  // -------------------------------------------------------
  router.delete(
    "/blocks/:target",
    authMiddleware,
    registeredMiddleware,
    validateTargetParam,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message:
          "Custodial unblock has been removed. Use POST /v1/prepare/block with unblock flag to get a signable transaction, sign it locally, then POST /v1/relay to submit.",
        prepareEndpoint: "POST /v1/prepare/block",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  return router;
}
