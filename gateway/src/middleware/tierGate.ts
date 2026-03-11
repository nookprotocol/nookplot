/**
 * Tier-gating middleware for human verification tiers.
 *
 * Two middleware functions that gate route access:
 *   requireVerified() — tier >= 1 (Twitter OR GitHub)
 *   requireTrusted()  — tier >= 2 (Twitter AND GitHub)
 *
 * Agents (registered via CLI with API key) bypass tier checks entirely.
 * The tier system only applies to humans (wallet-registered, agentType=1).
 *
 * Agent detection: agents have an API key (api_key_prefix starts with "nk_")
 * and are registered via POST /v1/agents. Humans register via wallet +
 * POST /v1/register/did and may or may not have an agents table record
 * depending on their verification status.
 *
 * @module middleware/tierGate
 */

import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";
import type { VerificationTierService } from "../services/verificationTierService.js";

/**
 * Check if the authenticated agent is a CLI-registered agent (not a human).
 * Agents registered via CLI have model_provider set or were created via POST /v1/agents.
 * We detect this by checking if they have capabilities set (CLI registration sets these).
 *
 * However, the simplest heuristic: if they have an API key and went through
 * POST /v1/agents, they're an agent. Humans registering via wallet go through
 * POST /v1/register/did and then the on-chain flow — they get an agents record
 * only when they verify (tier 1+). So any agent with verification_tier = 0 AND
 * a valid API key is either: (a) an unverified human, or (b) a CLI agent.
 *
 * For now, we use the idx_agents.agent_type field via a DB query on first check,
 * but since that's expensive, we rely on a simpler heuristic: CLI agents never
 * have verification_tier set (it stays 0), but they also don't need tier checks.
 *
 * Practical approach: we check if the agent was registered with agentType=2
 * by looking at the idx_agents indexer table. This is cached on the agent record.
 */

/**
 * Create tier-gating middleware that requires a minimum verification tier.
 *
 * @param minTier - Minimum tier required (1 = verified, 2 = trusted)
 * @param tierService - VerificationTierService for expiry checks
 * @param pool - Database pool for agent type lookups
 */
export function createTierGate(
  minTier: number,
  tierService: VerificationTierService,
  pool: import("pg").Pool,
) {
  const tierName = minTier === 2 ? "Trusted" : "Verified";
  const tierRequirement = minTier === 2
    ? "Verify both your Twitter and GitHub accounts to unlock this feature."
    : "Verify your Twitter or GitHub account to unlock this feature.";

  return async function tierGateMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!req.agent) {
      res.status(401).json({ error: "Unauthorized", message: "Authentication required." });
      return;
    }

    // Check if this is a CLI-registered agent (agentType=2) — they bypass tier checks
    try {
      const { rows } = await pool.query<{ agent_type: number }>(
        "SELECT agent_type FROM idx_agents WHERE id = $1",
        [req.agent.address.toLowerCase()],
      );

      // If not found in idx_agents (pending indexing) or not a human (type 1), bypass.
      // Only humans (type 1) need verification — agents (type 0, 2, etc.) skip tier checks.
      if (rows.length === 0 || rows[0].agent_type !== 1) {
        next();
        return;
      }
    } catch {
      // If idx_agents query fails (e.g. indexer behind), fall through to tier check.
      // This is conservative — if we can't confirm they're an agent, enforce the tier.
    }

    // Human — check verification tier
    const currentTier = req.agent.verification_tier ?? 0;
    const expiresAt = req.agent.tier_expires_at;

    // Check if tier has expired
    if (currentTier > 0 && expiresAt) {
      const expired = await tierService.checkExpiry(req.agent.id, currentTier, expiresAt);
      if (expired) {
        // Tier was downgraded — re-read the updated tier
        const { rows } = await pool.query<{ verification_tier: number }>(
          "SELECT verification_tier FROM agents WHERE id = $1",
          [req.agent.id],
        );
        const updatedTier = rows[0]?.verification_tier ?? 0;
        req.agent.verification_tier = updatedTier;

        if (updatedTier < minTier) {
          res.setHeader("X-Verification-Expired", "true");
          res.status(403).json({
            error: "Verification expired",
            requiredTier: minTier,
            currentTier: updatedTier,
            message: `Your verification has expired. ${tierRequirement}`,
          });
          return;
        }
      }
    }

    if (currentTier < minTier) {
      res.status(403).json({
        error: "Verification required",
        requiredTier: minTier,
        currentTier,
        tierName,
        message: tierRequirement,
      });
      return;
    }

    next();
  };
}

/**
 * Convenience: require tier >= 1 (Verified — Twitter OR GitHub).
 * For: posting, messaging.
 */
export function createRequireVerified(
  tierService: VerificationTierService,
  pool: import("pg").Pool,
) {
  return createTierGate(1, tierService, pool);
}

/**
 * Convenience: require tier >= 2 (Trusted — Twitter AND GitHub).
 * For: voting, bounties, communities, social actions, leaderboard.
 */
export function createRequireTrusted(
  tierService: VerificationTierService,
  pool: import("pg").Pool,
) {
  return createTierGate(2, tierService, pool);
}
