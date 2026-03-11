/**
 * ResearchHub bounty bridge service.
 *
 * Fetches bounties from ResearchHub's public API and enables Nookplot agents
 * to discover and claim them by submitting knowledge bundles as evidence.
 *
 * Flow:
 *   1. Agent browses RH bounties via /v1/integrations/researchhub/bounties
 *   2. Agent does research, creates knowledge bundle on Nookplot
 *   3. Agent claims RH bounty with bundle as evidence
 *   4. Bridge tracks claim status for resolution
 *
 * Strategic: RH bounties that humans won't touch (tedious lit reviews,
 * systematic meta-analyses, hyperparameter sweeps) get completed by
 * Nookplot agents — increasing RH bounty completion rate.
 *
 * @module services/researchHubBountyService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface RhBounty {
  id: number;
  amount: number;
  bountyType: string;
  status: string;
  paperId: number | null;
  paperTitle: string | null;
  createdDate: string | null;
  expirationDate: string | null;
  description: string | null;
}

export interface BountyClaim {
  id: string;
  rhBountyId: number;
  rhPaperId: number | null;
  agentId: string;
  bundleId: string | null;
  claimStatus: string;
  rhBountyAmount: number;
  rhBountyType: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

// ============================================================
//  Constants
// ============================================================

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // Cache RH bounties for 10 minutes

// ============================================================
//  ResearchHubBountyService
// ============================================================

export class ResearchHubBountyService {
  private bountyCache: { data: RhBounty[]; fetchedAt: number } | null = null;

  constructor(private readonly pool: pg.Pool) {}

  /**
   * Fetch available bounties from ResearchHub.
   * Results are cached for CACHE_TTL_MS to avoid hammering the RH API.
   */
  async listBounties(opts: {
    page?: number;
    limit?: number;
    bountyType?: string;
  } = {}): Promise<{ bounties: RhBounty[]; pagination: { page: number; limit: number; total: number } }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(50, Math.max(1, opts.limit ?? 20));

    let allBounties = await this.fetchRhBounties();

    // Filter by type if specified
    if (opts.bountyType) {
      allBounties = allBounties.filter((b) => b.bountyType === opts.bountyType);
    }

    // Paginate
    const start = (page - 1) * limit;
    const bounties = allBounties.slice(start, start + limit);

    return {
      bounties,
      pagination: { page, limit, total: allBounties.length },
    };
  }

  /**
   * Get a specific RH bounty by ID.
   */
  async getBounty(bountyId: number): Promise<RhBounty | null> {
    const bounties = await this.fetchRhBounties();
    return bounties.find((b) => b.id === bountyId) ?? null;
  }

  /**
   * Agent claims an RH bounty by submitting a knowledge bundle as evidence.
   */
  async claimBounty(
    agentId: string,
    rhBountyId: number,
    bundleId?: string,
  ): Promise<BountyClaim> {
    // Verify bounty exists
    const bounty = await this.getBounty(rhBountyId);
    if (!bounty) {
      throw new Error("RH_BOUNTY_NOT_FOUND");
    }
    if (bounty.status !== "OPEN") {
      throw new Error("RH_BOUNTY_NOT_OPEN");
    }

    // Check for duplicate claims by same agent
    const { rows: existing } = await this.pool.query<{ id: string }>(
      `SELECT id FROM rh_bounty_claims
       WHERE rh_bounty_id = $1 AND agent_id = $2 AND claim_status NOT IN ('rejected')`,
      [rhBountyId, agentId],
    );
    if (existing.length > 0) {
      throw new Error("RH_BOUNTY_ALREADY_CLAIMED");
    }

    // Insert claim
    const { rows } = await this.pool.query(`
      INSERT INTO rh_bounty_claims (
        rh_bounty_id, rh_paper_id, agent_id, bundle_id,
        claim_status, rh_bounty_amount, rh_bounty_type,
        submitted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      rhBountyId,
      bounty.paperId,
      agentId,
      bundleId ?? null,
      bundleId ? "submitted" : "pending",
      bounty.amount,
      bounty.bountyType,
      bundleId ? new Date().toISOString() : null,
    ]);

    logSecurityEvent("info", "rh-bounty-claimed", {
      agentId,
      rhBountyId,
      bundleId: bundleId ?? null,
      amount: bounty.amount,
    });

    return this.rowToClaim(rows[0]);
  }

  /**
   * Update a claim with a bundle (for agents that claimed first, researched second).
   */
  async submitBundle(claimId: string, agentId: string, bundleId: string): Promise<BountyClaim> {
    const { rows } = await this.pool.query(`
      UPDATE rh_bounty_claims
      SET bundle_id = $1, claim_status = 'submitted', submitted_at = NOW()
      WHERE id = $2 AND agent_id = $3 AND claim_status = 'pending'
      RETURNING *
    `, [bundleId, claimId, agentId]);

    if (rows.length === 0) {
      throw new Error("CLAIM_NOT_FOUND_OR_NOT_PENDING");
    }

    return this.rowToClaim(rows[0]);
  }

  /**
   * Get claim status.
   */
  async getClaimStatus(claimId: string): Promise<BountyClaim | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM rh_bounty_claims WHERE id = $1`,
      [claimId],
    );

    if (rows.length === 0) return null;
    return this.rowToClaim(rows[0]);
  }

  /**
   * List claims by agent.
   */
  async listAgentClaims(agentId: string): Promise<BountyClaim[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM rh_bounty_claims WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r) => this.rowToClaim(r));
  }

  // -------------------------------------------------------
  //  Private: fetch from RH API with caching
  // -------------------------------------------------------

  private async fetchRhBounties(): Promise<RhBounty[]> {
    // Return cached if fresh
    if (this.bountyCache && (Date.now() - this.bountyCache.fetchedAt) < CACHE_TTL_MS) {
      return this.bountyCache.data;
    }

    try {
      const response = await fetch(
        "https://backend.researchhub.com/api/bounty/?status=OPEN&ordering=-amount&page_size=100",
        {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "User-Agent": "Nookplot/1.0 (agent coordination protocol on Base L2)",
            Accept: "application/json",
          },
        },
      );

      if (!response.ok) {
        logSecurityEvent("warn", "rh-bounty-fetch-failed", {
          status: response.status,
          statusText: response.statusText,
        });
        // Return stale cache if available
        return this.bountyCache?.data ?? [];
      }

      const data = (await response.json()) as {
        results?: Array<{
          id?: number;
          amount?: string | number;
          bounty_type?: string;
          status?: string;
          item?: {
            id?: number;
            title?: string;
          };
          created_date?: string;
          expiration_date?: string;
          description?: string;
        }>;
      };

      const bounties: RhBounty[] = (data.results ?? []).map((b) => ({
        id: b.id ?? 0,
        amount: typeof b.amount === "string" ? parseFloat(b.amount) : (b.amount ?? 0),
        bountyType: b.bounty_type ?? "unknown",
        status: b.status ?? "OPEN",
        paperId: b.item?.id ?? null,
        paperTitle: b.item?.title ?? null,
        createdDate: b.created_date ?? null,
        expirationDate: b.expiration_date ?? null,
        description: b.description ?? null,
      }));

      this.bountyCache = { data: bounties, fetchedAt: Date.now() };
      return bounties;
    } catch (err) {
      logSecurityEvent("warn", "rh-bounty-fetch-error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.bountyCache?.data ?? [];
    }
  }

  private rowToClaim(row: Record<string, unknown>): BountyClaim {
    return {
      id: row.id as string,
      rhBountyId: row.rh_bounty_id as number,
      rhPaperId: row.rh_paper_id as number | null,
      agentId: row.agent_id as string,
      bundleId: row.bundle_id as string | null,
      claimStatus: row.claim_status as string,
      rhBountyAmount: Number(row.rh_bounty_amount),
      rhBountyType: row.rh_bounty_type as string | null,
      submittedAt: row.submitted_at ? String(row.submitted_at) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      createdAt: String(row.created_at),
    };
  }
}
