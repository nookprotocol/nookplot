/**
 * Treasury REST routes — guild economics: deposit, withdraw, fund bounty, distribute revenue.
 *
 * All routes nested under /v1/guilds/:guildId/treasury.
 *
 * POST   /guilds/:guildId/treasury/deposit       — Deposit credits (member)
 * POST   /guilds/:guildId/treasury/withdraw      — Withdraw credits (admin)
 * POST   /guilds/:guildId/treasury/fund-bounty   — Fund a bounty (admin or proposal)
 * POST   /guilds/:guildId/treasury/distribute     — Distribute revenue to members (admin)
 * GET    /guilds/:guildId/treasury                — Get treasury balance + stats
 * GET    /guilds/:guildId/treasury/transactions   — Transaction history
 * GET    /guilds/:guildId/treasury/distributions  — Distribution history
 * PUT    /guilds/:guildId/treasury/config         — Set revenue config (admin)
 * GET    /guilds/:guildId/treasury/config         — Get revenue config
 *
 * @module routes/treasury
 */

import { Router } from "express";
import type pg from "pg";
import type { TreasuryService } from "../services/treasuryService.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createKeyRateLimiter, createReadKeyRateLimiter, createMethodAwareRateLimiter } from "../middleware/rateLimit.js";

interface AuthState {
  user: { id: string; address: string };
  agent: { id: string; address: string; tier?: number };
}

export function createTreasuryRouter(
  pool: pg.Pool,
  hmacSecret: string,
  treasuryService: TreasuryService,
): Router {
  const router = Router({ mergeParams: true });
  router.use(createMethodAwareRateLimiter(createReadKeyRateLimiter(60_000, 120), createKeyRateLimiter(60_000, 30)));
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  const getAuth = (req: any): AuthState | null => {
    const agent = req.agent;
    return agent?.id ? { user: { id: agent.id, address: agent.address }, agent } : null;
  };

  // -------------------------------------------------------
  //  POST /guilds/:guildId/treasury/deposit
  // -------------------------------------------------------
  router.post(
    "/guilds/:guildId/treasury/deposit",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { amount, memo } = req.body;
        if (!amount || typeof amount !== "number" || amount <= 0) {
          res.status(400).json({ error: "amount must be a positive number" }); return;
        }

        const result = await treasuryService.deposit(s.agent.id, String(req.params.guildId), amount, memo);
        res.json({ data: result });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:guildId/treasury/withdraw
  // -------------------------------------------------------
  router.post(
    "/guilds/:guildId/treasury/withdraw",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { amount, memo } = req.body;
        if (!amount || typeof amount !== "number" || amount <= 0) {
          res.status(400).json({ error: "amount must be a positive number" }); return;
        }

        const result = await treasuryService.withdraw(s.agent.id, String(req.params.guildId), amount, memo);
        res.json({ data: result });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:guildId/treasury/fund-bounty
  // -------------------------------------------------------
  router.post(
    "/guilds/:guildId/treasury/fund-bounty",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { bountyId, amount, proposalId } = req.body;
        if (!bountyId || typeof bountyId !== "string") {
          res.status(400).json({ error: "bountyId is required" }); return;
        }
        if (!amount || typeof amount !== "number" || amount <= 0) {
          res.status(400).json({ error: "amount must be a positive number" }); return;
        }

        const result = await treasuryService.fundBounty(s.agent.id, String(req.params.guildId), bountyId, amount, proposalId);
        res.json({ data: result });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  POST /guilds/:guildId/treasury/distribute
  // -------------------------------------------------------
  router.post(
    "/guilds/:guildId/treasury/distribute",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { amount } = req.body;
        const result = await treasuryService.distributeRevenue(
          s.agent.id,
          String(req.params.guildId),
          amount ? Number(amount) : undefined,
        );
        res.json({ data: result });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/:guildId/treasury — Balance + stats
  // -------------------------------------------------------
  router.get(
    "/guilds/:guildId/treasury",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await treasuryService.getTreasury(String(req.params.guildId));
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "treasury-get-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/:guildId/treasury/transactions
  // -------------------------------------------------------
  router.get(
    "/guilds/:guildId/treasury/transactions",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const offset = req.query.offset ? Number(req.query.offset) : undefined;
        const txType = req.query.txType as string | undefined;

        const data = await treasuryService.getTransactions(String(req.params.guildId), { limit, offset, txType });
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "treasury-txns-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/:guildId/treasury/distributions
  // -------------------------------------------------------
  router.get(
    "/guilds/:guildId/treasury/distributions",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const distributionId = req.query.distributionId as string | undefined;

        const data = await treasuryService.getDistributions(String(req.params.guildId), { limit, distributionId });
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "treasury-dist-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /guilds/:guildId/treasury/config — Set revenue config
  // -------------------------------------------------------
  router.put(
    "/guilds/:guildId/treasury/config",
    authMiddleware,
    registeredMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const { treasuryPct, memberPct, distributionMode, minDistribution, autoDistribute } = req.body;
        const data = await treasuryService.setRevenueConfig(s.agent.id, String(req.params.guildId), {
          treasuryPct,
          memberPct,
          distributionMode,
          minDistribution,
          autoDistribute,
        });
        res.json({ data });
      } catch (err: any) {
        mapError(res, err);
      }
    },
  );

  // -------------------------------------------------------
  //  GET /guilds/:guildId/treasury/config
  // -------------------------------------------------------
  router.get(
    "/guilds/:guildId/treasury/config",
    authMiddleware,
    async (req, res): Promise<void> => {
      try {
        const s = getAuth(req);
        if (!s) { res.status(401).json({ error: "Unauthorized" }); return; }

        const data = await treasuryService.getRevenueConfig(String(req.params.guildId));
        res.json({ data });
      } catch (err: any) {
        logSecurityEvent("warn", "treasury-config-get-error", { error: err.message });
        res.status(500).json({ error: "Internal error" });
      }
    },
  );

  return router;
}

// ── Error Mapping ─────────────────────────────────────────────────────────────

function mapError(res: any, err: any): void {
  const code = err.code as string | undefined;
  switch (code) {
    case "INSUFFICIENT_CREDITS":
      res.status(402).json({ error: err.message });
      break;
    case "INSUFFICIENT_TREASURY":
      res.status(400).json({ error: err.message });
      break;
    case "FORBIDDEN":
      res.status(403).json({ error: err.message });
      break;
    case "NOT_FOUND":
      res.status(404).json({ error: err.message });
      break;
    case "INVALID_AMOUNT":
    case "INVALID_CONFIG":
    case "NO_MEMBERS":
      res.status(400).json({ error: err.message });
      break;
    default:
      logSecurityEvent("warn", "treasury-route-error", { error: err.message, code });
      res.status(500).json({ error: "Internal error" });
  }
}
