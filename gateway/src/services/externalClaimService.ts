/**
 * External credit claims service ("Proof of Prior Work").
 *
 * Core service for managing claims of external identity and work:
 * - Submit claims (link agent to GitHub, Twitter, arXiv, email)
 * - Verify claims via platform-specific verifiers
 * - Sweep unclaimed credits after verification
 * - Compute reputation boosts from verified claims
 *
 * @module services/externalClaimService
 */

import type { Pool } from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { CreditManager } from "./creditManager.js";

// ============================================================
//  Types
// ============================================================

export type ClaimPlatform = "github" | "twitter" | "arxiv" | "email" | "instagram" | "linkedin" | "orcid";
export type ClaimType = "identity" | "authorship" | "contribution";
export type ClaimStatus = "pending" | "verified" | "rejected" | "expired";

export interface ExternalClaim {
  id: string;
  agentId: string | null;
  platform: ClaimPlatform;
  externalId: string;
  claimType: ClaimType;
  status: ClaimStatus;
  verificationMethod: string | null;
  verificationData: Record<string, unknown>;
  reputationBoost: Record<string, number>;
  createdAt: string;
  verifiedAt: string | null;
}

export interface UnclaimedCredit {
  id: string;
  platform: ClaimPlatform;
  externalId: string;
  attributionType: string;
  source: string;
  reputationValue: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ReputationBoostResult {
  activity: number;
  quality: number;
  influence: number;
  breadth: number;
}

// ============================================================
//  ExternalClaimService
// ============================================================

export class ExternalClaimService {
  private readonly pool: Pool;
  private readonly creditManager: CreditManager | null;

  constructor(pool: Pool, creditManager?: CreditManager) {
    this.pool = pool;
    this.creditManager = creditManager ?? null;
  }

  // -------------------------------------------------------
  //  Submit + Query Claims
  // -------------------------------------------------------

  /**
   * Submit a new external claim.
   */
  async submitClaim(
    agentId: string,
    platform: ClaimPlatform,
    externalId: string,
    claimType: ClaimType,
    evidence?: Record<string, unknown>,
  ): Promise<ExternalClaim> {
    const { rows } = await this.pool.query<{
      id: string;
      agent_id: string;
      platform: ClaimPlatform;
      external_id: string;
      claim_type: ClaimType;
      status: ClaimStatus;
      verification_method: string | null;
      verification_data: Record<string, unknown>;
      reputation_boost: Record<string, number>;
      created_at: Date;
      verified_at: Date | null;
    }>(
      `INSERT INTO external_claims (agent_id, platform, external_id, claim_type, verification_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, external_id, claim_type) DO UPDATE SET
         agent_id = COALESCE(external_claims.agent_id, EXCLUDED.agent_id),
         updated_at = NOW()
       RETURNING *`,
      [agentId, platform, externalId, claimType, JSON.stringify(evidence ?? {})],
    );

    const r = rows[0];
    logSecurityEvent("info", "external-claim-submitted", {
      agentId,
      platform,
      externalId,
      claimType,
    });

    return this.mapClaim(r);
  }

  /**
   * Get all claims for an agent.
   */
  async getClaimsForAgent(agentId: string): Promise<ExternalClaim[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM external_claims WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r: any) => this.mapClaim(r));
  }

  /**
   * Get a specific claim by ID.
   */
  async getClaim(claimId: string): Promise<ExternalClaim | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM external_claims WHERE id = $1`,
      [claimId],
    );
    if (rows.length === 0) return null;
    return this.mapClaim(rows[0]);
  }

  /**
   * Get unclaimed credits for a platform/external_id.
   */
  async getUnclaimedCredits(platform: ClaimPlatform, externalId: string): Promise<UnclaimedCredit[]> {
    const { rows } = await this.pool.query<{
      id: string;
      platform: ClaimPlatform;
      external_id: string;
      attribution_type: string;
      source: string;
      reputation_value: number;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT * FROM unclaimed_credits
       WHERE platform = $1 AND external_id = $2 AND claimed_by IS NULL
       ORDER BY created_at DESC`,
      [platform, externalId],
    );

    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      externalId: r.external_id,
      attributionType: r.attribution_type,
      source: r.source,
      reputationValue: r.reputation_value,
      details: r.details,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // -------------------------------------------------------
  //  Verification
  // -------------------------------------------------------

  /**
   * Mark a claim as verified after successful platform verification.
   */
  async markVerified(
    claimId: string,
    verificationMethod: string,
    verificationData: Record<string, unknown>,
    reputationBoost: Record<string, number>,
  ): Promise<ExternalClaim | null> {
    const { rows } = await this.pool.query(
      `UPDATE external_claims
       SET status = 'verified',
           verification_method = $1,
           verification_data = $2,
           reputation_boost = $3,
           verified_at = NOW(),
           updated_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING *`,
      [verificationMethod, JSON.stringify(verificationData), JSON.stringify(reputationBoost), claimId],
    );

    if (rows.length === 0) return null;

    logSecurityEvent("info", "external-claim-verified", {
      claimId,
      verificationMethod,
      reputationBoost,
    });

    return this.mapClaim(rows[0]);
  }

  /**
   * Reject a claim.
   */
  async rejectClaim(claimId: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE external_claims
       SET status = 'rejected',
           verification_data = verification_data || $1,
           updated_at = NOW()
       WHERE id = $2 AND status = 'pending'`,
      [JSON.stringify({ rejectionReason: reason }), claimId],
    );
    return (rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------
  //  Sweep Unclaimed Credits
  // -------------------------------------------------------

  /**
   * After verification, sweep all unclaimed credits for this platform/external_id
   * and assign them to the verified agent.
   */
  async sweepUnclaimedCredits(agentId: string, platform: ClaimPlatform, externalId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE unclaimed_credits
       SET claimed_by = $1, claimed_at = NOW()
       WHERE platform = $2 AND external_id = $3 AND claimed_by IS NULL`,
      [agentId, platform, externalId],
    );

    const swept = rowCount ?? 0;

    if (swept > 0) {
      logSecurityEvent("info", "unclaimed-credits-swept", {
        agentId,
        platform,
        externalId,
        count: swept,
      });

      // Award centricredits for claimed work
      if (this.creditManager) {
        const bonusCredits = swept * 50; // 50 centricredits per claimed item
        try {
          await this.creditManager.addCredits(
            agentId,
            bonusCredits,
            `claim-sweep-${platform}-${externalId}`,
            "claim_sweep",
          );
        } catch {
          // Non-fatal — log and continue
          logSecurityEvent("warn", "claim-sweep-credit-failed", { agentId, bonusCredits });
        }
      }
    }

    return swept;
  }

  // -------------------------------------------------------
  //  Reputation Boost Computation
  // -------------------------------------------------------

  /**
   * Compute aggregate reputation boosts from all verified claims for an agent.
   */
  async computeReputationBoosts(agentId: string): Promise<ReputationBoostResult> {
    const { rows } = await this.pool.query<{
      reputation_boost: Record<string, number>;
      platform: ClaimPlatform;
      verification_data: Record<string, unknown>;
    }>(
      `SELECT reputation_boost, platform, verification_data
       FROM external_claims
       WHERE agent_id = $1 AND status = 'verified'`,
      [agentId],
    );

    const boosts: ReputationBoostResult = { activity: 0, quality: 0, influence: 0, breadth: 0 };

    for (const row of rows) {
      // Use stored boosts if available
      if (row.reputation_boost) {
        for (const [key, value] of Object.entries(row.reputation_boost)) {
          if (key in boosts) {
            boosts[key as keyof ReputationBoostResult] += value;
          }
        }
      } else {
        // Default boosts by platform
        switch (row.platform) {
          case "github": {
            const repos = (row.verification_data?.publicRepos as number) ?? 0;
            boosts.activity += Math.min(15, repos);
            boosts.breadth += Math.min(10, Math.floor(repos / 5));
            break;
          }
          case "arxiv":
            boosts.quality += 20;
            break;
          case "twitter": {
            const followers = (row.verification_data?.followersCount as number) ?? 0;
            boosts.influence += Math.min(20, Math.floor(followers / 100));
            break;
          }
          case "email":
            boosts.breadth += 5;
            break;
          case "orcid":
            boosts.quality += 15;
            boosts.breadth += 10;
            break;
        }
      }
    }

    // Cap all boosts at 30 (don't let external claims dominate)
    boosts.activity = Math.min(30, boosts.activity);
    boosts.quality = Math.min(30, boosts.quality);
    boosts.influence = Math.min(30, boosts.influence);
    boosts.breadth = Math.min(30, boosts.breadth);

    return boosts;
  }

  // -------------------------------------------------------
  //  Attribution (for other services to call)
  // -------------------------------------------------------

  /**
   * Create an unclaimed credit entry.
   * Called by other services when they discover external work that should
   * be credited to someone (e.g., a paper cited in a knowledge bundle).
   */
  async createUnclaimedCredit(
    platform: ClaimPlatform,
    externalId: string,
    attributionType: string,
    source: string,
    reputationValue: number,
    details?: Record<string, unknown>,
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO unclaimed_credits (platform, external_id, attribution_type, source, reputation_value, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [platform, externalId, attributionType, source, reputationValue, JSON.stringify(details ?? {})],
    );
    return rows[0].id;
  }

  // -------------------------------------------------------
  //  Private helpers
  // -------------------------------------------------------

  private mapClaim(r: any): ExternalClaim {
    return {
      id: r.id,
      agentId: r.agent_id,
      platform: r.platform,
      externalId: r.external_id,
      claimType: r.claim_type,
      status: r.status,
      verificationMethod: r.verification_method,
      verificationData: r.verification_data ?? {},
      reputationBoost: r.reputation_boost ?? {},
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      verifiedAt: r.verified_at instanceof Date ? r.verified_at.toISOString() : r.verified_at,
    };
  }
}
