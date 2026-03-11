/**
 * Human verification tier service.
 *
 * Computes and manages verification tiers for humans:
 *   Tier 0 (Unverified): wallet only, read-only access
 *   Tier 1 (Verified):   wallet + Twitter OR GitHub verified claim
 *   Tier 2 (Trusted):    wallet + Twitter AND GitHub verified claims
 *
 * Agents (agentType=2, registered via CLI) are unaffected — tier system
 * only applies to humans (agentType=1, registered via wallet).
 *
 * Re-verification required every VERIFICATION_WINDOW_DAYS (default 14).
 *
 * @module services/verificationTierService
 */

import type pg from "pg";
import { gatewayConfig } from "../config.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "./creditManager.js";

/** Platforms that count toward human verification tiers. */
const TIER_PLATFORMS = ["twitter", "github"] as const;

export interface VerificationStatus {
  tier: number;
  tierName: "unverified" | "verified" | "trusted";
  verifiedPlatforms: string[];
  expiresAt: Date | null;
  daysUntilExpiry: number | null;
}

export class VerificationTierService {
  constructor(
    private pool: pg.Pool,
    private creditManager?: CreditManager,
  ) {}

  /**
   * Compute the tier a human should have based on their current verified claims.
   * Only counts Twitter and GitHub claims that are verified and not expired.
   */
  async computeTier(agentId: string): Promise<{ tier: number; platforms: string[] }> {
    const windowDays = gatewayConfig.verificationWindowDays;
    const now = new Date();

    // Find verified Twitter/GitHub claims that haven't expired
    const { rows } = await this.pool.query<{ platform: string }>(
      `SELECT DISTINCT platform FROM external_claims
       WHERE agent_id = $1
         AND platform IN ('twitter', 'github')
         AND status = 'verified'
         AND (reverification_expires_at IS NULL OR reverification_expires_at > $2)`,
      [agentId, now.toISOString()],
    );

    const platforms = rows.map((r) => r.platform);
    const hasTwitter = platforms.includes("twitter");
    const hasGithub = platforms.includes("github");

    if (hasTwitter && hasGithub) return { tier: 2, platforms };
    if (hasTwitter || hasGithub) return { tier: 1, platforms };
    return { tier: 0, platforms: [] };
  }

  /**
   * Recompute and persist the verification tier for an agent.
   * Called after claim verification, re-verification, or expiry check.
   *
   * If the agent reaches tier 1 for the first time, creates their credit account.
   */
  async refreshTier(agentId: string): Promise<VerificationStatus> {
    const { tier, platforms } = await this.computeTier(agentId);
    const windowDays = gatewayConfig.verificationWindowDays;
    const now = new Date();
    const expiresAt = tier > 0
      ? new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000)
      : null;

    // Check previous tier to detect first-time verification
    const { rows: prevRows } = await this.pool.query<{ verification_tier: number }>(
      "SELECT verification_tier FROM agents WHERE id = $1",
      [agentId],
    );
    const previousTier = prevRows[0]?.verification_tier ?? 0;

    // Update tier in agents table
    await this.pool.query(
      `UPDATE agents
       SET verification_tier = $1,
           tier_verified_at = $2,
           tier_expires_at = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [tier, tier > 0 ? now.toISOString() : null, expiresAt?.toISOString() ?? null, agentId],
    );

    // First time reaching tier 1+ → create credit account with initial credits
    if (previousTier === 0 && tier > 0 && this.creditManager) {
      try {
        await this.creditManager.createAccount(agentId);
        logSecurityEvent("info", "human-verified-credits-granted", {
          agentId,
          tier,
          platforms,
          credits: gatewayConfig.creditInitialAmount,
        });
      } catch (err) {
        // Non-fatal — account may already exist (ON CONFLICT DO NOTHING)
        logSecurityEvent("warn", "human-verified-credits-failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logSecurityEvent("info", "verification-tier-updated", {
      agentId,
      previousTier,
      newTier: tier,
      platforms,
      expiresAt: expiresAt?.toISOString() ?? null,
    });

    const tierName = tier === 2 ? "trusted" : tier === 1 ? "verified" : "unverified";
    const daysUntilExpiry = expiresAt
      ? Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    return { tier, tierName, verifiedPlatforms: platforms, expiresAt, daysUntilExpiry };
  }

  /**
   * Check if an agent's tier has expired and downgrade if needed.
   * Called from auth middleware on every authenticated request.
   *
   * Returns true if the tier was downgraded.
   */
  async checkExpiry(agentId: string, currentTier: number, expiresAt: Date | null): Promise<boolean> {
    if (currentTier === 0 || !expiresAt) return false;

    const now = new Date();
    if (expiresAt > now) return false;

    // Tier has expired — recompute based on current valid claims
    const { tier: newTier } = await this.computeTier(agentId);

    if (newTier < currentTier) {
      // Downgrade
      const windowDays = gatewayConfig.verificationWindowDays;
      const newExpiresAt = newTier > 0
        ? new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000)
        : null;

      await this.pool.query(
        `UPDATE agents
         SET verification_tier = $1,
             tier_verified_at = CASE WHEN $1 > 0 THEN NOW() ELSE NULL END,
             tier_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [newTier, newExpiresAt?.toISOString() ?? null, agentId],
      );

      logSecurityEvent("warn", "verification-tier-expired", {
        agentId,
        previousTier: currentTier,
        newTier,
      });

      return true;
    }

    return false;
  }

  /**
   * Get the verification status for an agent (public, used by API endpoint).
   */
  async getStatus(agentId: string): Promise<VerificationStatus> {
    const { rows } = await this.pool.query<{
      verification_tier: number;
      tier_expires_at: Date | null;
    }>(
      "SELECT verification_tier, tier_expires_at FROM agents WHERE id = $1",
      [agentId],
    );

    if (rows.length === 0) {
      return { tier: 0, tierName: "unverified", verifiedPlatforms: [], expiresAt: null, daysUntilExpiry: null };
    }

    const { verification_tier: tier, tier_expires_at: expiresAt } = rows[0];

    // Get verified platforms
    const { rows: claimRows } = await this.pool.query<{ platform: string }>(
      `SELECT DISTINCT platform FROM external_claims
       WHERE agent_id = $1
         AND platform IN ('twitter', 'github')
         AND status = 'verified'
         AND (reverification_expires_at IS NULL OR reverification_expires_at > NOW())`,
      [agentId],
    );

    const platforms = claimRows.map((r) => r.platform);
    const tierName = tier === 2 ? "trusted" : tier === 1 ? "verified" : "unverified";
    const now = new Date();
    const daysUntilExpiry = expiresAt
      ? Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    return { tier, tierName, verifiedPlatforms: platforms, expiresAt, daysUntilExpiry };
  }

  /**
   * Update re-verification expiry on a specific claim after successful re-OAuth.
   */
  async markClaimReverified(claimId: string): Promise<void> {
    const windowDays = gatewayConfig.verificationWindowDays;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

    await this.pool.query(
      `UPDATE external_claims
       SET last_reverified_at = $1,
           reverification_expires_at = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [now.toISOString(), expiresAt.toISOString(), claimId],
    );
  }
}
