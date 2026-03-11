/**
 * Merkle reward routes.
 *
 * Public:
 *   GET /v1/rewards/merkle/claimable/:address — Claimable amounts across currencies
 *   GET /v1/rewards/merkle/proof/:address/:pool — Merkle proof for on-chain claim
 *   GET /v1/rewards/merkle/history/:address — Reward history
 *
 * @module routes/merkleRewards
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { MerkleRewardService, PoolType } from "../services/merkleRewardService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

const VALID_POOLS = new Set(["weth", "nook"]);

export function createMerkleRewardsRouter(
  merkleRewardService: MerkleRewardService,
): Router {
  const router = Router();

  // -------------------------------------------------------
  //  GET /v1/rewards/merkle/claimable/:address
  // -------------------------------------------------------
  router.get(
    "/rewards/merkle/claimable/:address",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const address = String(req.params.address);
        if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
          res.status(400).json({ error: "Invalid address" });
          return;
        }
        const result = await merkleRewardService.getClaimable(address);
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "merkle-rewards-claimable-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch claimable amounts" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/rewards/merkle/proof/:address/:pool
  // -------------------------------------------------------
  router.get(
    "/rewards/merkle/proof/:address/:pool",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const address = String(req.params.address);
        const pool = String(req.params.pool);
        if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
          res.status(400).json({ error: "Invalid address" });
          return;
        }
        if (!VALID_POOLS.has(pool)) {
          res.status(400).json({ error: "Invalid pool type. Must be 'weth' or 'nook'" });
          return;
        }
        const result = await merkleRewardService.getProof(address, pool as PoolType);
        if (!result) {
          res.status(404).json({ error: "No rewards found for this address and pool" });
          return;
        }
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "merkle-rewards-proof-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch proof" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/rewards/merkle/history/:address
  // -------------------------------------------------------
  router.get(
    "/rewards/merkle/history/:address",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const address = String(req.params.address);
        if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
          res.status(400).json({ error: "Invalid address" });
          return;
        }
        const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
        const history = await merkleRewardService.getHistory(address, limit);
        res.json({ rewards: history });
      } catch (err) {
        logSecurityEvent("warn", "merkle-rewards-history-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch history" });
      }
    },
  );

  return router;
}
