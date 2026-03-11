/**
 * Weekly rewards routes.
 *
 * Public:
 *   GET /v1/rewards/weekly/current     — Current epoch info + countdown
 *   GET /v1/rewards/weekly/leaderboard — Tier-grouped results for completed epoch
 *   GET /v1/rewards/weekly/history     — Paginated past epochs
 *
 * Authenticated:
 *   GET  /v1/rewards/weekly/me    — Agent's score/tier/reward across epochs
 *   POST /v1/rewards/weekly/claim — Mark rewards as claimed
 *
 * Admin:
 *   POST /v1/admin/rewards/trigger — Manually trigger epoch computation
 *   GET  /v1/admin/rewards/config  — Read scoring config from system_settings
 *   PUT  /v1/admin/rewards/config  — Update scoring config
 *
 * @module routes/rewards
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import type { WeeklyRewardService } from "../services/weeklyRewardService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createRewardsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  weeklyRewardService: WeeklyRewardService,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  const adminOnly = (req: AuthenticatedRequest, res: Response, next: () => void) => {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };

  // -------------------------------------------------------
  //  GET /v1/rewards/weekly/current — Public epoch info + countdown
  // -------------------------------------------------------
  let currentCache: { data: unknown; expiresAt: number } | null = null;

  router.get(
    "/rewards/weekly/current",
    async (_req: Request, res: Response): Promise<void> => {
      if (currentCache && Date.now() < currentCache.expiresAt) {
        res.json(currentCache.data);
        return;
      }

      try {
        const info = await weeklyRewardService.getCurrentEpochInfo();
        const data = {
          epochNumber: info.epochNumber,
          periodStart: info.periodStart.toISOString(),
          periodEnd: info.periodEnd.toISOString(),
          poolCredits: info.poolCredits,
          poolDisplay: (info.poolCredits / 100).toFixed(2),
          timeRemainingMs: info.timeRemaining,
          timeRemainingHuman: formatDuration(info.timeRemaining),
        };
        currentCache = { data, expiresAt: Date.now() + 60_000 };
        res.json(data);
      } catch (err) {
        logSecurityEvent("warn", "rewards-current-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch current epoch" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/rewards/weekly/leaderboard — Tier-grouped results
  // -------------------------------------------------------
  router.get(
    "/rewards/weekly/leaderboard",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const epochNumber = req.query.epoch ? parseInt(String(req.query.epoch), 10) : undefined;
        const result = await weeklyRewardService.getLeaderboard(epochNumber);

        if (!result.epoch) {
          res.json({ epoch: null, tiers: {} });
          return;
        }

        // Resolve agent names for display
        const agentIds = result.scores.map((s) => s.agentId);
        const names = await resolveAgentNames(pool, agentIds);

        // Group by tier
        const tiers: Record<string, Array<{
          agentId: string;
          address: string;
          name: string | null;
          score: number;
          rank: number;
          rewardCredits: number;
          rewardDisplay: string;
          dimensions: Record<string, number>;
        }>> = { diamond: [], gold: [], silver: [], bronze: [] };

        for (const s of result.scores) {
          const info = names.get(s.agentId);
          tiers[s.tier]?.push({
            agentId: s.agentId,
            address: info?.address ?? "",
            name: info?.name ?? null,
            score: s.score,
            rank: s.rank,
            rewardCredits: s.rewardCredits,
            rewardDisplay: (s.rewardCredits / 100).toFixed(2),
            dimensions: s.dimensions,
          });
        }

        res.json({
          epoch: {
            ...result.epoch,
            poolDisplay: (result.epoch.poolCredits / 100).toFixed(2),
            distributedDisplay: (result.epoch.totalDistributed / 100).toFixed(2),
          },
          tiers,
        });
      } catch (err) {
        logSecurityEvent("warn", "rewards-leaderboard-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch leaderboard" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/rewards/weekly/history — Paginated past epochs
  // -------------------------------------------------------
  router.get(
    "/rewards/weekly/history",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 50);
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
        const history = await weeklyRewardService.getEpochHistory(limit, offset);
        res.json({
          epochs: history.map((e) => ({
            ...e,
            poolDisplay: (e.poolCredits / 100).toFixed(2),
            distributedDisplay: (e.totalDistributed / 100).toFixed(2),
          })),
        });
      } catch (err) {
        logSecurityEvent("warn", "rewards-history-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch history" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/rewards/weekly/me — Agent's rewards across epochs (authenticated)
  // -------------------------------------------------------
  router.get(
    "/rewards/weekly/me",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agentId = req.agent!.id;
        const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 50);
        const rewards = await weeklyRewardService.getAgentRewards(agentId, limit);
        res.json({
          rewards: rewards.map((r) => ({
            ...r,
            rewardDisplay: (r.rewardCredits / 100).toFixed(2),
          })),
        });
      } catch (err) {
        logSecurityEvent("warn", "rewards-me-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to fetch your rewards" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/rewards/weekly/claim — Mark rewards as claimed (authenticated)
  // -------------------------------------------------------
  router.post(
    "/rewards/weekly/claim",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agentId = req.agent!.id;
        const result = await weeklyRewardService.claimReward(agentId);
        res.json({
          claimed: result.claimed,
          claimedDisplay: (result.claimed / 100).toFixed(2),
        });
      } catch (err) {
        logSecurityEvent("warn", "rewards-claim-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to claim rewards" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/admin/rewards/trigger — Manual epoch trigger (admin)
  // -------------------------------------------------------
  router.post(
    "/admin/rewards/trigger",
    authMiddleware,
    adminOnly,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const result = await weeklyRewardService.triggerEpoch();
        res.json(result);
      } catch (err) {
        logSecurityEvent("warn", "rewards-trigger-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to trigger epoch" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/admin/rewards/config — Read scoring config (admin)
  // -------------------------------------------------------
  router.get(
    "/admin/rewards/config",
    authMiddleware,
    adminOnly,
    async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const weights = await weeklyRewardService.loadWeights();
        // Redact jitter secret
        res.json({ ...weights, jitter_secret: "[redacted]" });
      } catch (err) {
        res.status(500).json({ error: "Failed to read config" });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/admin/rewards/config — Update scoring config (admin)
  // -------------------------------------------------------
  router.put(
    "/admin/rewards/config",
    authMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const updates = req.body as Record<string, string | number>;
        if (!updates || typeof updates !== "object") {
          res.status(400).json({ error: "Body must be an object of key-value pairs" });
          return;
        }

        const allowedKeys = [
          "bounty_provider", "bounty_creator", "marketplace_provider", "marketplace_buyer",
          "credit_purchase", "revenue_distribution", "relay_activity",
          "weth_usd_price", "nook_usd_price", "pool_credits", "min_score_threshold",
          "min_account_age_days", "velocity_spike_factor",
          "diamond_cooldown_weeks", "jitter_secret",
        ];

        let updated = 0;
        for (const [key, value] of Object.entries(updates)) {
          if (!allowedKeys.includes(key)) continue;
          await pool.query(
            `INSERT INTO system_settings (key, value, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [`weekly_reward_${key}`, String(value)],
          );
          updated++;
        }

        logSecurityEvent("info", "rewards-config-updated", {
          admin: req.agent!.address,
          keys: Object.keys(updates).filter((k) => allowedKeys.includes(k)),
        });

        res.json({ updated });
      } catch (err) {
        res.status(500).json({ error: "Failed to update config" });
      }
    },
  );

  return router;
}

// ── Helpers ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

async function resolveAgentNames(
  pool: pg.Pool,
  agentIds: string[],
): Promise<Map<string, { name: string | null; address: string }>> {
  const result = new Map<string, { name: string | null; address: string }>();
  if (agentIds.length === 0) return result;

  try {
    const { rows } = await pool.query<{ id: string; display_name: string | null; address: string }>(
      `SELECT id, display_name, address FROM agents WHERE id = ANY($1)`,
      [agentIds],
    );
    for (const row of rows) {
      result.set(row.id, { name: row.display_name, address: row.address });
    }
  } catch { /* graceful degradation */ }

  return result;
}
