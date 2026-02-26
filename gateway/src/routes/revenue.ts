/**
 * Revenue Router lifecycle routes.
 *
 * POST   /v1/revenue/distribute   — 410 Gone (use POST /v1/prepare/revenue/distribute)
 * GET    /v1/revenue/chain/:agent — Receipt chain query
 * GET    /v1/revenue/config/:agent — Share config
 * POST   /v1/revenue/config       — 410 Gone (use POST /v1/prepare/revenue/config)
 * GET    /v1/revenue/balance      — Caller's claimable balance
 * POST   /v1/revenue/claim        — 410 Gone (use POST /v1/prepare/revenue/claim)
 * GET    /v1/revenue/history/:agent — Distribution history
 * GET    /v1/revenue/earnings/:address — Earnings summary
 *
 * @module routes/revenue
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createRevenueRouter(
  pool: pg.Pool,
  _sdkConfig: SdkFactoryConfig,
  hmacSecret: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/revenue/distribute — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/revenue/distribute",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/revenue/distribute",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/revenue/chain/:agent — Receipt chain query
  // -------------------------------------------------------
  router.get(
    "/revenue/chain/:agent",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const targetAgent = req.params.agent as string;

      try {
        const sdk = getReadOnlySDK();
        const chain = await sdk.contracts.getReceiptChain(targetAgent);
        const config = await sdk.contracts.getRevenueShareConfig(targetAgent);
        const totalDistributed = await sdk.contracts.getAgentTotalDistributed(targetAgent);

        res.json({
          agent: targetAgent,
          chain,
          config,
          totalDistributed: totalDistributed.toString(),
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to get receipt chain." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/revenue/config/:agent — Share config
  // -------------------------------------------------------
  router.get(
    "/revenue/config/:agent",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const targetAgent = req.params.agent as string;

      try {
        const sdk = getReadOnlySDK();
        const config = await sdk.contracts.getRevenueShareConfig(targetAgent);
        res.json(config);
      } catch (err) {
        res.status(500).json({ error: "Failed to get share config." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/revenue/config — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/revenue/config",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/revenue/config",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/revenue/balance — Caller's claimable balance
  // -------------------------------------------------------
  router.get(
    "/revenue/balance",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const sdk = getReadOnlySDK();
        const [tokenBalance, ethBalance, totalClaimed] = await Promise.all([
          sdk.contracts.getClaimableBalance(agent.address),
          sdk.contracts.getClaimableEthBalance(agent.address),
          sdk.contracts.getAddressTotalClaimed(agent.address),
        ]);

        res.json({
          address: agent.address,
          claimableTokens: tokenBalance.toString(),
          claimableEth: ethBalance.toString(),
          totalClaimed: totalClaimed.toString(),
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to get balance." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/revenue/claim — 410 Gone
  // -------------------------------------------------------
  router.post(
    "/revenue/claim",
    authMiddleware,
    registeredMiddleware,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      res.status(410).json({
        error: "Gone",
        message: "Custodial write operations have been removed. Use the prepare+relay flow instead.",
        prepareEndpoint: "POST /v1/prepare/revenue/claim",
        relayEndpoint: "POST /v1/relay",
      });
    },
  );

  // -------------------------------------------------------
  //  GET /v1/revenue/history/:agent — Distribution history
  // -------------------------------------------------------
  router.get(
    "/revenue/history/:agent",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const targetAgent = req.params.agent as string;

      try {
        const sdk = getReadOnlySDK();
        const eventIds = await sdk.contracts.getRevenueHistory(targetAgent);
        const events = await Promise.all(
          eventIds.slice(0, 50).map((id) => sdk.contracts.getRevenueEvent(id)),
        );

        res.json({
          agent: targetAgent,
          events: events.map((e) => ({
            ...e,
            amount: e.amount.toString(),
            ownerAmount: e.ownerAmount.toString(),
            receiptChainAmount: e.receiptChainAmount.toString(),
            treasuryAmount: e.treasuryAmount.toString(),
          })),
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to get revenue history." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/revenue/earnings/:address — Earnings summary
  // -------------------------------------------------------
  router.get(
    "/revenue/earnings/:address",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const targetAddress = req.params.address as string;

      try {
        const sdk = getReadOnlySDK();
        const [claimableTokens, claimableEth, totalClaimed] = await Promise.all([
          sdk.contracts.getClaimableBalance(targetAddress),
          sdk.contracts.getClaimableEthBalance(targetAddress),
          sdk.contracts.getAddressTotalClaimed(targetAddress),
        ]);

        res.json({
          address: targetAddress,
          claimableTokens: claimableTokens.toString(),
          claimableEth: claimableEth.toString(),
          totalClaimed: totalClaimed.toString(),
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to get earnings." });
      }
    },
  );

  return router;
}
