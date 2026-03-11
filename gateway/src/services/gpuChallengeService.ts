/**
 * GPU Challenge Service — buyer-initiated performance verification.
 *
 * Buyers can send a small test workload to a GPU provider before committing
 * real USDC. The provider runs the test and submits results. Challenge
 * history (pass rate, last challenge date) is public so buyers can make
 * informed decisions.
 *
 * @module services/gpuChallengeService
 */

import type pg from "pg";

// ── Row shapes ───────────────────────────────────────────────────

export interface GpuChallengeRow {
  challenge_id: string;
  challenger_address: string;
  provider_address: string;
  listing_id: number;
  challenge_input_cid: string;
  challenge_output_cid: string | null;
  expected_min_tflops: number | null;
  actual_tflops: number | null;
  wall_time_ms: number | null;
  status: "pending" | "running" | "completed" | "failed" | "expired";
  created_at: string;
  completed_at: string | null;
  expires_at: string;
}

export interface CreateChallengeInput {
  challengerAddress: string;
  providerAddress: string;
  listingId: number;
  challengeInputCid: string;
  expectedMinTflops?: number;
}

export interface SubmitChallengeInput {
  challengeId: string;
  providerAddress: string;
  challengeOutputCid: string;
  actualTflops?: number;
  wallTimeMs?: number;
}

export interface ProviderChallengeStats {
  totalChallenges: number;
  completedChallenges: number;
  failedChallenges: number;
  passRate: number;
  lastChallengeAt: string | null;
  avgTflops: number | null;
}

// ── Service ──────────────────────────────────────────────────────

export class GpuChallengeService {
  private readonly pool: pg.Pool;

  /** Default challenge expiry: 1 hour */
  private readonly CHALLENGE_TTL_MS = 60 * 60 * 1000;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Create a new challenge from a buyer to a GPU provider.
   */
  async createChallenge(input: CreateChallengeInput): Promise<GpuChallengeRow> {
    const expiresAt = new Date(Date.now() + this.CHALLENGE_TTL_MS).toISOString();

    const { rows } = await this.pool.query<GpuChallengeRow>(
      `INSERT INTO gpu_challenges
         (challenger_address, provider_address, listing_id,
          challenge_input_cid, expected_min_tflops, expires_at)
       VALUES (LOWER($1), LOWER($2), $3, $4, $5, $6)
       RETURNING *`,
      [
        input.challengerAddress,
        input.providerAddress,
        input.listingId,
        input.challengeInputCid,
        input.expectedMinTflops ?? null,
        expiresAt,
      ],
    );
    return rows[0];
  }

  /**
   * Provider submits challenge results.
   */
  async submitChallengeResult(input: SubmitChallengeInput): Promise<GpuChallengeRow> {
    // Verify challenge exists, is pending, belongs to provider, and hasn't expired
    const { rows: existing } = await this.pool.query<GpuChallengeRow>(
      `SELECT * FROM gpu_challenges
       WHERE challenge_id = $1 AND LOWER(provider_address) = LOWER($2)`,
      [input.challengeId, input.providerAddress],
    );

    if (existing.length === 0) {
      throw new Error("Challenge not found or not your challenge.");
    }

    const challenge = existing[0];

    if (challenge.status !== "pending" && challenge.status !== "running") {
      throw new Error(`Challenge is ${challenge.status}, cannot submit results.`);
    }

    if (new Date(challenge.expires_at) < new Date()) {
      // Auto-expire
      await this.pool.query(
        `UPDATE gpu_challenges SET status = 'expired', updated_at = NOW()
         WHERE challenge_id = $1`,
        [input.challengeId],
      );
      throw new Error("Challenge has expired.");
    }

    // Determine pass/fail — if expectedMinTflops is set, actualTflops MUST be present and meet threshold
    const passed = !challenge.expected_min_tflops ||
      (input.actualTflops != null && input.actualTflops >= challenge.expected_min_tflops);

    const status = passed ? "completed" : "failed";

    const { rows } = await this.pool.query<GpuChallengeRow>(
      `UPDATE gpu_challenges SET
         challenge_output_cid = $1,
         actual_tflops = $2,
         wall_time_ms = $3,
         status = $4,
         completed_at = NOW()
       WHERE challenge_id = $5
       RETURNING *`,
      [
        input.challengeOutputCid,
        input.actualTflops ?? null,
        input.wallTimeMs ?? null,
        status,
        input.challengeId,
      ],
    );
    return rows[0];
  }

  /**
   * Get a single challenge by ID.
   */
  async getChallenge(challengeId: string): Promise<GpuChallengeRow | null> {
    const { rows } = await this.pool.query<GpuChallengeRow>(
      `SELECT * FROM gpu_challenges WHERE challenge_id = $1`,
      [challengeId],
    );
    return rows[0] ?? null;
  }

  /**
   * Get challenge history for a provider (public).
   */
  async getProviderChallenges(
    providerAddress: string,
    limit = 20,
    offset = 0,
  ): Promise<GpuChallengeRow[]> {
    const { rows } = await this.pool.query<GpuChallengeRow>(
      `SELECT * FROM gpu_challenges
       WHERE LOWER(provider_address) = LOWER($1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [providerAddress, Math.min(limit, 100), offset],
    );
    return rows;
  }

  /**
   * Get aggregated challenge stats for a provider (public).
   */
  async getProviderChallengeStats(providerAddress: string): Promise<ProviderChallengeStats> {
    const { rows } = await this.pool.query<{
      total: string;
      completed: string;
      failed: string;
      last_at: string | null;
      avg_tflops: string | null;
    }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         MAX(completed_at) AS last_at,
         AVG(actual_tflops) FILTER (WHERE actual_tflops IS NOT NULL) AS avg_tflops
       FROM gpu_challenges
       WHERE LOWER(provider_address) = LOWER($1)
         AND status IN ('completed', 'failed')`,
      [providerAddress],
    );

    const r = rows[0];
    const total = parseInt(r.total, 10);
    const completed = parseInt(r.completed, 10);
    const failed = parseInt(r.failed, 10);

    return {
      totalChallenges: total,
      completedChallenges: completed,
      failedChallenges: failed,
      passRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      lastChallengeAt: r.last_at,
      avgTflops: r.avg_tflops ? parseFloat(r.avg_tflops) : null,
    };
  }

  /**
   * Expire challenges that have passed their TTL.
   * Returns count of expired challenges.
   */
  async expireStale(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE gpu_challenges
       SET status = 'expired'
       WHERE status IN ('pending', 'running')
         AND expires_at < NOW()`,
    );
    return rowCount ?? 0;
  }
}
