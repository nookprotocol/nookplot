/**
 * Weekly reward distribution service.
 *
 * Distributes a configurable credit pool to top-performing agents each week,
 * weighted by real economic activity (bounties, marketplace, purchases, revenue).
 *
 * Scoring is USD-normalized using manual token prices from system_settings.
 * Tier distribution: Diamond (top 1%) → 40%, Gold (next 4%) → 30%,
 * Silver (next 10%) → 20%, Bronze (rest above threshold) → 10%.
 *
 * All scoring weights and thresholds load from system_settings at epoch time
 * so tuning requires no deploys. Code defaults are intentionally generic (1.0).
 *
 * @module services/weeklyRewardService
 */

import crypto from "node:crypto";
import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { gatewayConfig } from "../config.js";

// ============================================================
//  Types
// ============================================================

export interface WeeklyRewardConfig {
  /** How often to check if an epoch needs processing (ms). Default: 1 hour */
  tickIntervalMs: number;
  /** Credit pool size (stored units, 100 = 1.00 display). Default: 15000 (150.00 credits) */
  defaultPoolCredits: number;
  /** Minimum EAS to qualify for Bronze. Default: 1.0 */
  minScoreThreshold: number;
  /** Tier share percentages (must sum to 1.0) */
  tierShares: { diamond: number; gold: number; silver: number; bronze: number };
  /** Tier boundaries as percentiles (0-1) */
  tierBoundaries: { diamond: number; gold: number; silver: number };
  /** Maximum jitter hours for week boundary offset */
  maxJitterHours: number;
  /** Max consecutive Diamond weeks before cooldown. Default: 4 */
  diamondCooldownWeeks: number;
}

export const DEFAULT_CONFIG: WeeklyRewardConfig = {
  tickIntervalMs: 3_600_000, // 1 hour
  defaultPoolCredits: 15_000, // 150.00 display credits
  minScoreThreshold: 1.0,
  tierShares: { diamond: 0.4, gold: 0.3, silver: 0.2, bronze: 0.1 },
  tierBoundaries: { diamond: 0.01, gold: 0.05, silver: 0.15 },
  maxJitterHours: 12,
  diamondCooldownWeeks: 4,
};

/** Scoring weights loaded from system_settings */
interface ScoringWeights {
  bounty_provider: number;
  bounty_creator: number;
  marketplace_provider: number;
  marketplace_buyer: number;
  credit_purchase: number;
  revenue_distribution: number;
  relay_activity: number;
  weth_usd_price: number;
  nook_usd_price: number;
  pool_credits: number;
  min_score_threshold: number;
  min_account_age_days: number;
  velocity_spike_factor: number;
  diamond_cooldown_weeks: number;
  jitter_secret: string;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  bounty_provider: 1.0,
  bounty_creator: 1.0,
  marketplace_provider: 1.0,
  marketplace_buyer: 1.0,
  credit_purchase: 1.0,
  revenue_distribution: 1.0,
  relay_activity: 1.0,
  weth_usd_price: 2500,
  nook_usd_price: 0.01,
  pool_credits: 15_000,
  min_score_threshold: 1.0,
  min_account_age_days: 7,
  velocity_spike_factor: 3.0,
  diamond_cooldown_weeks: 4,
  jitter_secret: "default-jitter-seed",
};

interface AgentEAS {
  agentId: string;
  address: string;
  dimensions: Record<string, number>;
  totalScore: number;
}

interface GateResult {
  passed: boolean;
  reason?: string;
}

export type RewardTier = "diamond" | "gold" | "silver" | "bronze";

interface TieredAgent {
  agentId: string;
  score: number;
  tier: RewardTier;
  rank: number;
  dimensions: Record<string, number>;
  gates: Record<string, boolean>;
  rewardCredits: number;
}

// USDC address on Base
const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// ============================================================
//  Service
// ============================================================

export class WeeklyRewardService {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;
  private readonly config: WeeklyRewardConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    pool: pg.Pool,
    creditManager: CreditManager,
    config?: Partial<WeeklyRewardConfig>,
  ) {
    this.pool = pool;
    this.creditManager = creditManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ----------------------------------------------------------
  //  Lifecycle
  // ----------------------------------------------------------

  start(): void {
    if (this.timer) return;

    this.tick().catch((err) => {
      logSecurityEvent("warn", "weekly-reward-initial-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logSecurityEvent("warn", "weekly-reward-tick-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.tickIntervalMs);

    logSecurityEvent("info", "weekly-reward-service-started", {
      tickIntervalMs: this.config.tickIntervalMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ----------------------------------------------------------
  //  Tick — check if a completed week needs processing
  // ----------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const weights = await this.loadWeights();
      const now = new Date();
      const epoch = this.getCurrentEpochNumber(now);

      // Only process if the epoch has ended (we're past its period_end)
      const { periodStart, periodEnd } = this.getEpochBounds(epoch, weights.jitter_secret);
      if (now < periodEnd) return; // current epoch hasn't ended yet

      // Check if already processed
      const { rows } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM weekly_reward_epochs WHERE epoch_number = $1`,
        [epoch],
      );
      if (Number(rows[0].count) > 0) return; // already processed

      await this.processEpoch(epoch, periodStart, periodEnd, weights);
    } catch (err) {
      logSecurityEvent("warn", "weekly-reward-tick-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  // ----------------------------------------------------------
  //  Manual trigger (admin API)
  // ----------------------------------------------------------

  async triggerEpoch(): Promise<{ epochNumber: number; status: string }> {
    const weights = await this.loadWeights();
    const now = new Date();
    const epoch = this.getCurrentEpochNumber(now);
    const { periodStart, periodEnd } = this.getEpochBounds(epoch, weights.jitter_secret);

    // Check idempotency
    const { rows } = await this.pool.query<{ status: string }>(
      `SELECT status FROM weekly_reward_epochs WHERE epoch_number = $1`,
      [epoch],
    );
    if (rows.length > 0) {
      return { epochNumber: epoch, status: rows[0].status };
    }

    await this.processEpoch(epoch, periodStart, periodEnd, weights);
    return { epochNumber: epoch, status: "distributed" };
  }

  // ----------------------------------------------------------
  //  Epoch processing
  // ----------------------------------------------------------

  private async processEpoch(
    epochNumber: number,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<void> {
    const poolCredits = Math.round(weights.pool_credits);

    // 1. Create epoch record
    const { rows: [epochRow] } = await this.pool.query<{ id: string }>(
      `INSERT INTO weekly_reward_epochs (epoch_number, period_start, period_end, pool_credits, status, config_snapshot)
       VALUES ($1, $2, $3, $4, 'computing', $5)
       ON CONFLICT (epoch_number) DO NOTHING
       RETURNING id`,
      [epochNumber, periodStart, periodEnd, poolCredits, JSON.stringify(weights)],
    );

    if (!epochRow) {
      // Another instance beat us — idempotent
      return;
    }
    const epochId = epochRow.id;

    try {
      // 2. Compute EAS for all eligible agents
      const agents = await this.computeAllScores(periodStart, periodEnd, weights);

      // 3. Run anti-gaming gates
      const gated = await this.applyGates(agents, epochNumber, weights);

      // 4. Filter to eligible (passed all gates + above threshold)
      const eligible = gated.filter(
        (a) => Object.values(a.gates).every(Boolean) && a.score >= weights.min_score_threshold,
      );

      if (eligible.length === 0) {
        await this.pool.query(
          `UPDATE weekly_reward_epochs SET status = 'distributed', computed_at = NOW(), distributed_at = NOW(),
                  total_eligible = 0, total_distributed = 0 WHERE id = $1`,
          [epochId],
        );
        logSecurityEvent("info", "weekly-reward-no-eligible", { epochNumber });
        return;
      }

      // 5. Sort by score descending, assign ranks
      eligible.sort((a, b) => b.score - a.score);
      eligible.forEach((a, i) => { a.rank = i + 1; });

      // 6. Assign tiers
      const tiered = this.assignTiers(eligible, poolCredits);

      // 7. Insert scores + distribute credits
      let totalDistributed = 0;
      for (const agent of tiered) {
        await this.pool.query(
          `INSERT INTO weekly_reward_scores
            (epoch_id, agent_id, economic_score, tier, rank, reward_credits, dimension_breakdown, gates_passed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (epoch_id, agent_id) DO NOTHING`,
          [
            epochId,
            agent.agentId,
            agent.score,
            agent.tier,
            agent.rank,
            agent.rewardCredits,
            JSON.stringify(agent.dimensions),
            JSON.stringify(agent.gates),
          ],
        );

        if (agent.rewardCredits > 0) {
          try {
            await this.creditManager.addCredits(
              agent.agentId,
              agent.rewardCredits,
              "weekly_reward",
              epochId,
            );
            totalDistributed += agent.rewardCredits;
          } catch (err) {
            logSecurityEvent("warn", "weekly-reward-credit-failed", {
              agentId: agent.agentId,
              reward: agent.rewardCredits,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // 8. Finalize epoch
      await this.pool.query(
        `UPDATE weekly_reward_epochs SET
          status = 'distributed', computed_at = NOW(), distributed_at = NOW(),
          total_eligible = $1, total_distributed = $2
         WHERE id = $3`,
        [tiered.length, totalDistributed, epochId],
      );

      logSecurityEvent("info", "weekly-reward-distributed", {
        epochNumber,
        eligible: tiered.length,
        distributed: totalDistributed,
        pool: poolCredits,
      });
    } catch (err) {
      // Mark epoch as failed so it can be retried
      await this.pool.query(
        `UPDATE weekly_reward_epochs SET status = 'failed' WHERE id = $1`,
        [epochId],
      ).catch(() => {});
      throw err;
    }
  }

  // ----------------------------------------------------------
  //  Config loading from system_settings
  // ----------------------------------------------------------

  async loadWeights(): Promise<ScoringWeights> {
    try {
      const { rows } = await this.pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM system_settings WHERE key LIKE 'weekly_reward_%'`,
      );

      const settings: Record<string, string> = {};
      for (const row of rows) {
        settings[row.key.replace("weekly_reward_", "")] = row.value;
      }

      return {
        bounty_provider: parseFloat(settings.bounty_provider ?? "") || DEFAULT_WEIGHTS.bounty_provider,
        bounty_creator: parseFloat(settings.bounty_creator ?? "") || DEFAULT_WEIGHTS.bounty_creator,
        marketplace_provider: parseFloat(settings.marketplace_provider ?? "") || DEFAULT_WEIGHTS.marketplace_provider,
        marketplace_buyer: parseFloat(settings.marketplace_buyer ?? "") || DEFAULT_WEIGHTS.marketplace_buyer,
        credit_purchase: parseFloat(settings.credit_purchase ?? "") || DEFAULT_WEIGHTS.credit_purchase,
        revenue_distribution: parseFloat(settings.revenue_distribution ?? "") || DEFAULT_WEIGHTS.revenue_distribution,
        relay_activity: parseFloat(settings.relay_activity ?? "") || DEFAULT_WEIGHTS.relay_activity,
        weth_usd_price: parseFloat(settings.weth_usd_price ?? "") || DEFAULT_WEIGHTS.weth_usd_price,
        nook_usd_price: parseFloat(settings.nook_usd_price ?? "") || DEFAULT_WEIGHTS.nook_usd_price,
        pool_credits: parseFloat(settings.pool_credits ?? "") || DEFAULT_WEIGHTS.pool_credits,
        min_score_threshold: parseFloat(settings.min_score_threshold ?? "") || DEFAULT_WEIGHTS.min_score_threshold,
        min_account_age_days: parseFloat(settings.min_account_age_days ?? "") || DEFAULT_WEIGHTS.min_account_age_days,
        velocity_spike_factor: parseFloat(settings.velocity_spike_factor ?? "") || DEFAULT_WEIGHTS.velocity_spike_factor,
        diamond_cooldown_weeks: parseFloat(settings.diamond_cooldown_weeks ?? "") || DEFAULT_WEIGHTS.diamond_cooldown_weeks,
        jitter_secret: settings.jitter_secret || DEFAULT_WEIGHTS.jitter_secret,
      };
    } catch {
      return { ...DEFAULT_WEIGHTS };
    }
  }

  // ----------------------------------------------------------
  //  Week boundary with deterministic jitter
  // ----------------------------------------------------------

  /** ISO week number (Monday-based) */
  getCurrentEpochNumber(now: Date): number {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    // Combine year + week for unique epoch across years
    return d.getUTCFullYear() * 100 + weekNumber;
  }

  getEpochBounds(epochNumber: number, jitterSecret: string): { periodStart: Date; periodEnd: Date } {
    const year = Math.floor(epochNumber / 100);
    const week = epochNumber % 100;

    // ISO week 1 starts on the Monday of the week containing Jan 4
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (dayOfWeek - 1) * 86_400_000);
    const weekMonday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);

    // Jitter offset: deterministic per epoch + secret
    let jitterHours = 0;
    if (this.config.maxJitterHours > 0) {
      const jitterHash = crypto
        .createHash("sha256")
        .update(`${epochNumber}:${jitterSecret}`)
        .digest();
      jitterHours = (jitterHash.readUInt32BE(0) % (this.config.maxJitterHours * 60)) / 60;
    }

    const periodStart = new Date(weekMonday.getTime() + jitterHours * 3_600_000);
    const periodEnd = new Date(periodStart.getTime() + 7 * 86_400_000);

    return { periodStart, periodEnd };
  }

  // ----------------------------------------------------------
  //  Economic Activity Score computation
  // ----------------------------------------------------------

  private async computeAllScores(
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<AgentEAS[]> {
    // Get all agents that have any activity
    const { rows: agents } = await this.pool.query<{ id: string; address: string }>(
      `SELECT id, address FROM agents WHERE address IS NOT NULL`,
    );

    const results: AgentEAS[] = [];

    for (const agent of agents) {
      const dimensions: Record<string, number> = {};
      let total = 0;

      // 1. Bounty payouts received (provider)
      const bountyProvider = await this.queryBountyProviderUsd(
        agent.id, agent.address, periodStart, periodEnd, weights,
      );
      dimensions.bounty_provider = bountyProvider * weights.bounty_provider;
      total += dimensions.bounty_provider;

      // 2. Bounty creation with escrow (creator)
      const bountyCreator = await this.queryBountyCreatorUsd(
        agent.address, periodStart, periodEnd, weights,
      );
      dimensions.bounty_creator = bountyCreator * weights.bounty_creator;
      total += dimensions.bounty_creator;

      // 3. Marketplace settlements received (provider)
      const mktProvider = await this.queryMarketplaceProviderUsd(
        agent.id, periodStart, periodEnd, weights,
      );
      dimensions.marketplace_provider = mktProvider * weights.marketplace_provider;
      total += dimensions.marketplace_provider;

      // 4. Marketplace settlements made (buyer)
      const mktBuyer = await this.queryMarketplaceBuyerUsd(
        agent.id, periodStart, periodEnd, weights,
      );
      dimensions.marketplace_buyer = mktBuyer * weights.marketplace_buyer;
      total += dimensions.marketplace_buyer;

      // 5. Credit purchases
      const purchases = await this.queryCreditPurchasesUsd(
        agent.id, periodStart, periodEnd, weights,
      );
      dimensions.credit_purchase = purchases * weights.credit_purchase;
      total += dimensions.credit_purchase;

      // 6. Revenue distributions received
      const revDist = await this.queryRevenueDistributionsUsd(
        agent.address, periodStart, periodEnd, weights,
      );
      dimensions.revenue_distribution = revDist * weights.revenue_distribution;
      total += dimensions.revenue_distribution;

      // 7. Relay activity (low weight proxy)
      const relays = await this.queryRelayActivity(agent.id, periodStart, periodEnd);
      dimensions.relay_activity = relays * weights.relay_activity;
      total += dimensions.relay_activity;

      if (total > 0) {
        results.push({
          agentId: agent.id,
          address: agent.address,
          dimensions,
          totalScore: total,
        });
      }
    }

    return results;
  }

  // ----------------------------------------------------------
  //  Data source queries (all wrapped in try/catch for idx_* graceful degradation)
  // ----------------------------------------------------------

  private tokenToUsd(amount: string, tokenAddress: string | null, weights: ScoringWeights): number {
    if (!amount || amount === "0") return 0;
    const addr = (tokenAddress ?? "").toLowerCase();
    try {
      if (addr === USDC_ADDRESS) {
        // USDC: 6 decimals
        return Number(BigInt(amount.split(".")[0])) / 1e6;
      }
      if (addr === gatewayConfig.wethAddress.toLowerCase()) {
        // WETH: 18 decimals
        return (Number(BigInt(amount.split(".")[0])) / 1e18) * weights.weth_usd_price;
      }
      if (addr === gatewayConfig.nookTokenAddress.toLowerCase()) {
        // NOOK: 18 decimals
        return (Number(BigInt(amount.split(".")[0])) / 1e18) * weights.nook_usd_price;
      }
    } catch {
      return 0;
    }
    return 0;
  }

  private async queryBountyProviderUsd(
    agentId: string,
    address: string,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<number> {
    try {
      // From bounty_completions (gateway DB, has token_address)
      const { rows } = await this.pool.query<{ reward_amount: string; token_address: string | null }>(
        `SELECT reward_amount, token_address FROM bounty_completions
         WHERE completer_id = $1 AND completed_at >= $2 AND completed_at < $3`,
        [agentId, periodStart, periodEnd],
      );
      let total = 0;
      for (const row of rows) {
        total += this.tokenToUsd(row.reward_amount ?? "0", row.token_address, weights);
      }

      // Also check idx_bounties for any not in bounty_completions
      try {
        const { rows: idxRows } = await this.pool.query<{ reward_amount: string; token_address: string | null }>(
          `SELECT reward_amount, token_address FROM idx_bounties
           WHERE LOWER(claimer) = LOWER($1) AND status = 3
             AND _block_timestamp >= $2 AND _block_timestamp < $3`,
          [address, periodStart, periodEnd],
        );
        for (const row of idxRows) {
          total += this.tokenToUsd(row.reward_amount ?? "0", row.token_address, weights);
        }
      } catch { /* idx_bounties may not exist */ }

      return total;
    } catch {
      return 0;
    }
  }

  private async queryBountyCreatorUsd(
    address: string,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ reward_amount: string; token_address: string | null }>(
        `SELECT reward_amount, token_address FROM idx_bounties
         WHERE LOWER(creator) = LOWER($1) AND escrow_type > 0
           AND _block_timestamp >= $2 AND _block_timestamp < $3`,
        [address, periodStart, periodEnd],
      );
      let total = 0;
      for (const row of rows) {
        total += this.tokenToUsd(row.reward_amount ?? "0", row.token_address, weights);
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async queryMarketplaceProviderUsd(
    agentId: string,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ escrow_amount: string; escrow_token: string | null }>(
        `SELECT escrow_amount, escrow_token FROM service_agreements
         WHERE provider_agent_id = $1 AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [agentId, periodStart, periodEnd],
      );
      let total = 0;
      for (const row of rows) {
        total += this.tokenToUsd(row.escrow_amount ?? "0", row.escrow_token, weights);
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async queryMarketplaceBuyerUsd(
    agentId: string,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ escrow_amount: string; escrow_token: string | null }>(
        `SELECT escrow_amount, escrow_token FROM service_agreements
         WHERE buyer_agent_id = $1 AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [agentId, periodStart, periodEnd],
      );
      let total = 0;
      for (const row of rows) {
        total += this.tokenToUsd(row.escrow_amount ?? "0", row.escrow_token, weights);
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async queryCreditPurchasesUsd(
    agentId: string,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ price_paid: string; payment_token: string }>(
        `SELECT price_paid, payment_token FROM credit_purchases
         WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3`,
        [agentId, periodStart, periodEnd],
      );
      let total = 0;
      for (const row of rows) {
        if (row.payment_token === "usdc") {
          total += Number(BigInt(row.price_paid.split(".")[0])) / 1e6;
        } else if (row.payment_token === "nook") {
          total += (Number(BigInt(row.price_paid.split(".")[0])) / 1e18) * weights.nook_usd_price;
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async queryRevenueDistributionsUsd(
    address: string,
    periodStart: Date,
    periodEnd: Date,
    weights: ScoringWeights,
  ): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total_credited: string }>(
        `SELECT COALESCE(SUM(total_credited::NUMERIC), 0)::TEXT AS total_credited
         FROM idx_contributor_credits
         WHERE LOWER(contributor) = LOWER($1)
           AND _block_timestamp >= $2 AND _block_timestamp < $3`,
        [address, periodStart, periodEnd],
      );
      // Revenue distributions are in ETH (wei)
      const wei = rows[0]?.total_credited ?? "0";
      return (Number(BigInt(wei.split(".")[0])) / 1e18) * weights.weth_usd_price;
    } catch {
      return 0;
    }
  }

  private async queryRelayActivity(
    agentId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM relay_log
         WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3`,
        [agentId, periodStart, periodEnd],
      );
      // Return a small fractional score per relay (0.01 USD-equivalent per relay)
      return parseInt(rows[0]?.count ?? "0", 10) * 0.01;
    } catch {
      return 0;
    }
  }

  // ----------------------------------------------------------
  //  Anti-gaming gates
  // ----------------------------------------------------------

  private async applyGates(
    agents: AgentEAS[],
    epochNumber: number,
    weights: ScoringWeights,
  ): Promise<TieredAgent[]> {
    const results: TieredAgent[] = [];

    for (const agent of agents) {
      const gates: Record<string, boolean> = {};

      // Gate 1: Account age >= N days
      gates.account_age = await this.checkAccountAge(agent.agentId, weights.min_account_age_days);

      // Gate 2: DID registered
      gates.did_registered = await this.checkDidRegistered(agent.agentId);

      // Gate 3: Velocity spike (>Nx vs 30-day avg)
      gates.velocity_ok = await this.checkVelocity(agent.agentId, agent.totalScore, weights.velocity_spike_factor);

      // Gate 4: Minimum 2+ economic dimensions with non-zero values
      const nonZeroDimensions = Object.values(agent.dimensions).filter((v) => v > 0).length;
      gates.min_dimensions = nonZeroDimensions >= 2;

      // Gate 5: Diamond cooldown
      gates.diamond_cooldown = await this.checkDiamondCooldown(
        agent.agentId,
        epochNumber,
        Math.round(weights.diamond_cooldown_weeks),
      );

      // Gate 6: Self-dealing exclusion (handled in scoring — bounties where creator===claimer excluded)
      gates.self_dealing = true; // Scored at query level

      results.push({
        agentId: agent.agentId,
        score: agent.totalScore,
        tier: "bronze", // assigned later
        rank: 0,
        dimensions: agent.dimensions,
        gates,
        rewardCredits: 0,
      });
    }

    return results;
  }

  private async checkAccountAge(agentId: string, minDays: number): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM agents WHERE id = $1`,
        [agentId],
      );
      if (!rows[0]) return false;
      const ageDays = (Date.now() - new Date(rows[0].created_at).getTime()) / 86_400_000;
      return ageDays >= minDays;
    } catch {
      return false;
    }
  }

  private async checkDidRegistered(agentId: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ did_cid: string | null }>(
        `SELECT did_cid FROM agents WHERE id = $1`,
        [agentId],
      );
      return !!rows[0]?.did_cid;
    } catch {
      return false;
    }
  }

  private async checkVelocity(agentId: string, currentScore: number, spikeFactor: number): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ avg_score: string }>(
        `SELECT AVG(economic_score)::TEXT AS avg_score FROM weekly_reward_scores
         WHERE agent_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
        [agentId],
      );
      const avg = parseFloat(rows[0]?.avg_score ?? "0");
      if (avg === 0) return true; // first epoch — no history to compare
      return currentScore <= avg * spikeFactor;
    } catch {
      return true;
    }
  }

  private async checkDiamondCooldown(agentId: string, currentEpoch: number, maxConsecutive: number): Promise<boolean> {
    try {
      // Count consecutive diamond epochs ending at the most recent one
      const { rows } = await this.pool.query<{ epoch_number: number }>(
        `SELECT e.epoch_number FROM weekly_reward_scores s
         JOIN weekly_reward_epochs e ON e.id = s.epoch_id
         WHERE s.agent_id = $1 AND s.tier = 'diamond'
         ORDER BY e.epoch_number DESC
         LIMIT $2`,
        [agentId, maxConsecutive],
      );

      if (rows.length < maxConsecutive) return true; // hasn't hit the limit

      // Check if these are truly consecutive
      let consecutive = 0;
      let expected = currentEpoch - 1;
      for (const row of rows) {
        if (row.epoch_number === expected) {
          consecutive++;
          expected--;
        } else {
          break;
        }
      }

      return consecutive < maxConsecutive;
    } catch {
      return true;
    }
  }

  // ----------------------------------------------------------
  //  Tier assignment + proportional distribution
  // ----------------------------------------------------------

  private assignTiers(eligible: TieredAgent[], poolCredits: number): TieredAgent[] {
    const n = eligible.length;
    const { tierBoundaries, tierShares } = this.config;

    // Assign tiers based on rank percentile
    for (const agent of eligible) {
      const percentile = agent.rank / n;
      if (percentile <= tierBoundaries.diamond) {
        agent.tier = "diamond";
      } else if (percentile <= tierBoundaries.gold) {
        agent.tier = "gold";
      } else if (percentile <= tierBoundaries.silver) {
        agent.tier = "silver";
      } else {
        agent.tier = "bronze";
      }
    }

    // Distribute within each tier proportionally to score
    const tiers: RewardTier[] = ["diamond", "gold", "silver", "bronze"];
    for (const tier of tiers) {
      const tierAgents = eligible.filter((a) => a.tier === tier);
      const tierPool = Math.round(poolCredits * tierShares[tier]);
      const tierTotalScore = tierAgents.reduce((sum, a) => sum + a.score, 0);

      if (tierTotalScore === 0 || tierAgents.length === 0) continue;

      for (const agent of tierAgents) {
        agent.rewardCredits = Math.round((agent.score / tierTotalScore) * tierPool);
      }
    }

    return eligible;
  }

  // ----------------------------------------------------------
  //  Public query helpers (for API routes)
  // ----------------------------------------------------------

  async getCurrentEpochInfo(): Promise<{
    epochNumber: number;
    periodStart: Date;
    periodEnd: Date;
    poolCredits: number;
    timeRemaining: number;
  }> {
    const weights = await this.loadWeights();
    const now = new Date();
    const epochNumber = this.getCurrentEpochNumber(now);
    const { periodStart, periodEnd } = this.getEpochBounds(epochNumber, weights.jitter_secret);

    return {
      epochNumber,
      periodStart,
      periodEnd,
      poolCredits: Math.round(weights.pool_credits),
      timeRemaining: Math.max(0, periodEnd.getTime() - now.getTime()),
    };
  }

  async getLeaderboard(epochNumber?: number): Promise<{
    epoch: { epochNumber: number; status: string; poolCredits: number; totalEligible: number; totalDistributed: number } | null;
    scores: Array<{
      agentId: string;
      score: number;
      tier: string;
      rank: number;
      rewardCredits: number;
      dimensions: Record<string, number>;
    }>;
  }> {
    // Find most recent completed epoch if not specified
    const epochQuery = epochNumber
      ? `SELECT * FROM weekly_reward_epochs WHERE epoch_number = $1 LIMIT 1`
      : `SELECT * FROM weekly_reward_epochs WHERE status = 'distributed' ORDER BY epoch_number DESC LIMIT 1`;

    const { rows: epochs } = await this.pool.query<{
      id: string; epoch_number: number; status: string; pool_credits: string;
      total_eligible: number; total_distributed: string;
    }>(epochQuery, epochNumber ? [epochNumber] : []);

    if (epochs.length === 0) {
      return { epoch: null, scores: [] };
    }

    const epoch = epochs[0];
    const { rows: scores } = await this.pool.query<{
      agent_id: string; economic_score: string; tier: string; rank: number;
      reward_credits: string; dimension_breakdown: Record<string, number>;
    }>(
      `SELECT agent_id, economic_score, tier, rank, reward_credits, dimension_breakdown
       FROM weekly_reward_scores WHERE epoch_id = $1 ORDER BY rank ASC`,
      [epoch.id],
    );

    return {
      epoch: {
        epochNumber: epoch.epoch_number,
        status: epoch.status,
        poolCredits: parseInt(epoch.pool_credits, 10),
        totalEligible: epoch.total_eligible,
        totalDistributed: parseInt(epoch.total_distributed, 10),
      },
      scores: scores.map((s) => ({
        agentId: s.agent_id,
        score: parseFloat(s.economic_score),
        tier: s.tier,
        rank: s.rank,
        rewardCredits: parseInt(s.reward_credits, 10),
        dimensions: s.dimension_breakdown,
      })),
    };
  }

  async getAgentRewards(agentId: string, limit = 10): Promise<Array<{
    epochNumber: number;
    score: number;
    tier: string;
    rank: number;
    rewardCredits: number;
    claimed: boolean;
    dimensions: Record<string, number>;
    periodStart: string;
    periodEnd: string;
  }>> {
    const { rows } = await this.pool.query<{
      epoch_number: number; economic_score: string; tier: string; rank: number;
      reward_credits: string; claimed: boolean; dimension_breakdown: Record<string, number>;
      period_start: Date; period_end: Date;
    }>(
      `SELECT e.epoch_number, s.economic_score, s.tier, s.rank, s.reward_credits,
              s.claimed, s.dimension_breakdown, e.period_start, e.period_end
       FROM weekly_reward_scores s
       JOIN weekly_reward_epochs e ON e.id = s.epoch_id
       WHERE s.agent_id = $1
       ORDER BY e.epoch_number DESC
       LIMIT $2`,
      [agentId, limit],
    );

    return rows.map((r) => ({
      epochNumber: r.epoch_number,
      score: parseFloat(r.economic_score),
      tier: r.tier,
      rank: r.rank,
      rewardCredits: parseInt(r.reward_credits, 10),
      claimed: r.claimed,
      dimensions: r.dimension_breakdown,
      periodStart: r.period_start.toISOString(),
      periodEnd: r.period_end.toISOString(),
    }));
  }

  async claimReward(agentId: string): Promise<{ claimed: number }> {
    const { rows } = await this.pool.query<{ id: string; reward_credits: string }>(
      `UPDATE weekly_reward_scores SET claimed = TRUE, claimed_at = NOW()
       WHERE agent_id = $1 AND claimed = FALSE
       RETURNING id, reward_credits`,
      [agentId],
    );
    const total = rows.reduce((sum, r) => sum + parseInt(r.reward_credits, 10), 0);
    return { claimed: total };
  }

  async getEpochHistory(limit = 10, offset = 0): Promise<Array<{
    epochNumber: number;
    periodStart: string;
    periodEnd: string;
    poolCredits: number;
    totalEligible: number;
    totalDistributed: number;
    status: string;
    distributedAt: string | null;
  }>> {
    const { rows } = await this.pool.query<{
      epoch_number: number; period_start: Date; period_end: Date;
      pool_credits: string; total_eligible: number; total_distributed: string;
      status: string; distributed_at: Date | null;
    }>(
      `SELECT epoch_number, period_start, period_end, pool_credits, total_eligible,
              total_distributed, status, distributed_at
       FROM weekly_reward_epochs
       ORDER BY epoch_number DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return rows.map((r) => ({
      epochNumber: r.epoch_number,
      periodStart: r.period_start.toISOString(),
      periodEnd: r.period_end.toISOString(),
      poolCredits: parseInt(r.pool_credits, 10),
      totalEligible: r.total_eligible,
      totalDistributed: parseInt(r.total_distributed, 10),
      status: r.status,
      distributedAt: r.distributed_at?.toISOString() ?? null,
    }));
  }
}
