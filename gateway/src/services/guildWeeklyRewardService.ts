/**
 * Guild weekly reward service.
 *
 * Distributes a configurable credit pool (default 200 credits / 20,000 stored)
 * to top-performing guilds each week, scored by aggregate member economic activity.
 *
 * Anti-abuse:
 *   - Wash-trade detection: guilds with >50% internal settlements get 0.25x penalty
 *   - External counterparty gate: <3 distinct external counterparties → 0.5x
 *   - Minimum member threshold (3 approved members)
 *   - Minimum guild age (7 days)
 *   - Per-guild cap: no guild > 15% of pool
 *
 * Tier distribution: Gold (top 10%) → 40%, Silver (next 20%) → 30%, Bronze (rest) → 30%
 *
 * After distributing, triggers auto-distribution for qualifying guilds.
 *
 * @module services/guildWeeklyRewardService
 */

import crypto from "node:crypto";
import type pg from "pg";
import type { TreasuryService } from "./treasuryService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface GuildWeeklyRewardConfig {
  /** Credit pool size (stored units, 100 = 1.00 display). Default: 20000 (200.00 credits) */
  poolCredits: number;
  /** Maximum share any single guild can receive. Default: 0.15 (15%) */
  maxGuildSharePct: number;
  /** Minimum approved members for eligibility. Default: 3 */
  minActiveMembers: number;
  /** Minimum guild age in days. Default: 7 */
  minGuildAgeDays: number;
  /** Wash-trade penalty threshold. Default: 0.5 (>50% internal = 0.25x) */
  washTradePenaltyThreshold: number;
  /** Minimum external counterparties. Default: 3 (fewer = 0.5x) */
  minExternalCounterparties: number;
  /** Tick interval in milliseconds. Default: 1 hour */
  tickIntervalMs: number;
  /** Tier shares (must sum to 1.0) */
  tierShares: { gold: number; silver: number; bronze: number };
  /** Tier boundaries as percentiles (0-1) */
  tierBoundaries: { gold: number; silver: number };
  /** Maximum jitter hours for epoch boundary offset */
  maxJitterHours: number;
}

const DEFAULT_CONFIG: GuildWeeklyRewardConfig = {
  poolCredits: 20_000,
  maxGuildSharePct: 0.15,
  minActiveMembers: 3,
  minGuildAgeDays: 7,
  washTradePenaltyThreshold: 0.5,
  minExternalCounterparties: 3,
  tickIntervalMs: 3_600_000,
  tierShares: { gold: 0.4, silver: 0.3, bronze: 0.3 },
  tierBoundaries: { gold: 0.1, silver: 0.3 },
  maxJitterHours: 12,
};

export type GuildRewardTier = "gold" | "silver" | "bronze";

interface GuildScore {
  guildId: string;
  score: number;
  tier: GuildRewardTier;
  rank: number;
  dimensions: Record<string, number>;
  gates: Record<string, boolean>;
  washTradePct: number;
  externalCounterparties: number;
  rewardCredits: number;
}

// ============================================================
//  Service
// ============================================================

export class GuildWeeklyRewardService {
  private readonly pool: pg.Pool;
  private readonly treasuryService: TreasuryService;
  private readonly config: GuildWeeklyRewardConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    pool: pg.Pool,
    treasuryService: TreasuryService,
    config?: Partial<GuildWeeklyRewardConfig>,
  ) {
    this.pool = pool;
    this.treasuryService = treasuryService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ----------------------------------------------------------
  //  Lifecycle
  // ----------------------------------------------------------

  start(): void {
    if (this.timer) return;

    this.tick().catch((err) => {
      logSecurityEvent("warn", "guild-weekly-reward-initial-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logSecurityEvent("warn", "guild-weekly-reward-tick-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.tickIntervalMs);

    logSecurityEvent("info", "guild-weekly-reward-service-started", {
      tickIntervalMs: this.config.tickIntervalMs,
      poolCredits: this.config.poolCredits,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ----------------------------------------------------------
  //  Tick
  // ----------------------------------------------------------

  async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = new Date();
      const epoch = this.getCurrentEpochNumber(now);
      const { periodStart, periodEnd } = this.getEpochBounds(epoch);

      // Only process if the epoch has ended
      if (now < periodEnd) return;

      // Check if already processed
      const { rows } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM guild_weekly_reward_epochs WHERE epoch_number = $1`,
        [epoch],
      );
      if (Number(rows[0].count) > 0) return;

      await this.processEpoch(epoch, periodStart, periodEnd);
    } catch (err) {
      logSecurityEvent("warn", "guild-weekly-reward-tick-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  // ----------------------------------------------------------
  //  Epoch processing
  // ----------------------------------------------------------

  private async processEpoch(
    epochNumber: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> {
    const poolCredits = await this.loadPoolCredits();

    // 1. Create epoch record
    const { rows: [epochRow] } = await this.pool.query<{ id: string }>(
      `INSERT INTO guild_weekly_reward_epochs (epoch_number, period_start, period_end, pool_credits, status, config_snapshot)
       VALUES ($1, $2, $3, $4, 'computing', $5)
       ON CONFLICT (epoch_number) DO NOTHING
       RETURNING id`,
      [epochNumber, periodStart, periodEnd, poolCredits, JSON.stringify(this.config)],
    );

    if (!epochRow) return; // another instance beat us
    const epochId = epochRow.id;

    try {
      // 2. Get eligible guilds
      const guilds = await this.getEligibleGuilds();

      if (guilds.length === 0) {
        await this.pool.query(
          `UPDATE guild_weekly_reward_epochs SET status = 'distributed', computed_at = NOW(), distributed_at = NOW(),
                  total_eligible = 0, total_distributed = 0 WHERE id = $1`,
          [epochId],
        );
        logSecurityEvent("info", "guild-weekly-reward-no-eligible", { epochNumber });
        return;
      }

      // 3. Score each guild
      const scoredGuilds = await this.scoreGuilds(guilds, periodStart, periodEnd);

      // 4. Filter to guilds with score > 0
      const eligible = scoredGuilds.filter((g) => g.score > 0);
      if (eligible.length === 0) {
        await this.pool.query(
          `UPDATE guild_weekly_reward_epochs SET status = 'distributed', computed_at = NOW(), distributed_at = NOW(),
                  total_eligible = 0, total_distributed = 0 WHERE id = $1`,
          [epochId],
        );
        return;
      }

      // 5. Sort by score descending, assign ranks
      eligible.sort((a, b) => b.score - a.score);
      eligible.forEach((g, i) => { g.rank = i + 1; });

      // 6. Assign tiers and rewards
      const tiered = this.assignTiers(eligible, poolCredits);

      // 7. Distribute to guild treasuries
      let totalDistributed = 0;
      for (const guild of tiered) {
        await this.pool.query(
          `INSERT INTO guild_weekly_reward_scores
            (epoch_id, guild_id, economic_score, tier, rank, reward_credits, dimension_breakdown, gates_passed, wash_trade_pct, external_counterparties)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (epoch_id, guild_id) DO NOTHING`,
          [
            epochId,
            guild.guildId,
            guild.score,
            guild.tier,
            guild.rank,
            guild.rewardCredits,
            JSON.stringify(guild.dimensions),
            JSON.stringify(guild.gates),
            guild.washTradePct,
            guild.externalCounterparties,
          ],
        );

        if (guild.rewardCredits > 0) {
          try {
            await this.treasuryService.ensureTreasury(guild.guildId);
            await this.pool.query(
              `UPDATE guild_treasuries
               SET balance = balance + $1, total_deposited = total_deposited + $1, updated_at = NOW()
               WHERE guild_id = $2`,
              [guild.rewardCredits, guild.guildId],
            );
            totalDistributed += guild.rewardCredits;
          } catch (err) {
            logSecurityEvent("warn", "guild-weekly-reward-deposit-failed", {
              guildId: guild.guildId,
              reward: guild.rewardCredits,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // 8. Finalize epoch
      await this.pool.query(
        `UPDATE guild_weekly_reward_epochs SET
          status = 'distributed', computed_at = NOW(), distributed_at = NOW(),
          total_eligible = $1, total_distributed = $2
         WHERE id = $3`,
        [tiered.length, totalDistributed, epochId],
      );

      logSecurityEvent("info", "guild-weekly-reward-distributed", {
        epochNumber,
        eligible: tiered.length,
        distributed: totalDistributed,
        pool: poolCredits,
      });

      // 9. Auto-distribution for qualifying guilds
      await this.runAutoDistributions();

    } catch (err) {
      await this.pool.query(
        `UPDATE guild_weekly_reward_epochs SET status = 'failed' WHERE id = $1`,
        [epochId],
      ).catch(() => {});
      throw err;
    }
  }

  // ----------------------------------------------------------
  //  Guild eligibility
  // ----------------------------------------------------------

  private async getEligibleGuilds(): Promise<Array<{ guildId: string; memberAddresses: string[] }>> {
    let guilds: Array<{ guild_id: string; created_at: string }>;
    try {
      const cutoff = new Date(Date.now() - this.config.minGuildAgeDays * 86_400_000);
      const result = await this.pool.query<{ guild_id: string; created_at: string }>(
        `SELECT guild_id::text AS guild_id, _block_timestamp AS created_at
         FROM idx_guilds WHERE status = 1 AND _block_timestamp <= $1`,
        [cutoff],
      );
      guilds = result.rows;
    } catch {
      return []; // idx_guilds may not exist
    }

    const eligible: Array<{ guildId: string; memberAddresses: string[] }> = [];

    for (const guild of guilds) {
      try {
        const result = await this.pool.query<{ member_id: string }>(
          `SELECT member_id FROM idx_guild_members WHERE guild_id = $1 AND status = 2`,
          [guild.guild_id],
        );
        const memberAddresses = result.rows.map((r) => r.member_id);
        if (memberAddresses.length >= this.config.minActiveMembers) {
          eligible.push({ guildId: guild.guild_id, memberAddresses });
        }
      } catch {
        continue; // idx_guild_members may not exist
      }
    }

    return eligible;
  }

  // ----------------------------------------------------------
  //  Guild scoring
  // ----------------------------------------------------------

  private async scoreGuilds(
    guilds: Array<{ guildId: string; memberAddresses: string[] }>,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<GuildScore[]> {
    const results: GuildScore[] = [];

    for (const guild of guilds) {
      const dimensions: Record<string, number> = {};

      // Resolve member addresses to agent IDs
      const members = await this.resolveMemberIds(guild.memberAddresses);
      if (members.length === 0) continue;

      const memberIds = members.map((m) => m.agentId);
      const memberAddrsLower = guild.memberAddresses.map((a) => a.toLowerCase());

      // Aggregate economic activity across all guild members
      dimensions.bounties_completed = await this.queryBountyCompletions(memberIds, periodStart, periodEnd);
      dimensions.bounties_created = await this.queryBountyCreations(memberAddrsLower, periodStart, periodEnd);
      dimensions.marketplace_provided = await this.queryMarketplaceProvided(memberIds, periodStart, periodEnd);
      dimensions.marketplace_bought = await this.queryMarketplaceBought(memberIds, periodStart, periodEnd);
      dimensions.credit_purchases = await this.queryCreditPurchases(memberIds, periodStart, periodEnd);
      dimensions.revenue_distributed = await this.queryRevenueDistributions(guild.guildId, periodStart, periodEnd);

      let rawScore = Object.values(dimensions).reduce((s, v) => s + v, 0);

      // Wash-trade detection
      const washTradePct = await this.computeWashTradePct(memberIds, memberAddrsLower, periodStart, periodEnd);
      const gates: Record<string, boolean> = {};

      gates.wash_trade = washTradePct <= this.config.washTradePenaltyThreshold;
      if (!gates.wash_trade) {
        rawScore *= 0.25; // heavy penalty
      }

      // Cross-guild wash trade detection: penalize if >50% of external trades
      // go to members of a single other guild (coordinated ring across guilds)
      const crossGuildPct = await this.computeCrossGuildConcentration(memberIds, periodStart, periodEnd);
      gates.cross_guild_wash = crossGuildPct <= this.config.washTradePenaltyThreshold;
      if (!gates.cross_guild_wash) {
        rawScore *= 0.25; // same heavy penalty as intra-guild wash trading
      }

      // External counterparty check
      const externalCounterparties = await this.countExternalCounterparties(memberIds, memberAddrsLower, periodStart, periodEnd);
      gates.external_counterparties = externalCounterparties >= this.config.minExternalCounterparties;
      if (!gates.external_counterparties) {
        rawScore *= 0.5;
      }

      results.push({
        guildId: guild.guildId,
        score: rawScore,
        tier: "bronze", // will be reassigned
        rank: 0,
        dimensions,
        gates,
        washTradePct,
        externalCounterparties,
        rewardCredits: 0,
      });
    }

    return results;
  }

  // ----------------------------------------------------------
  //  Tier assignment and reward distribution
  // ----------------------------------------------------------

  private assignTiers(guilds: GuildScore[], poolCredits: number): GuildScore[] {
    const n = guilds.length;
    const maxPerGuild = Math.floor(poolCredits * this.config.maxGuildSharePct);

    // Tier boundaries
    const goldCutoff = Math.max(1, Math.ceil(n * this.config.tierBoundaries.gold));
    const silverCutoff = Math.max(goldCutoff + 1, Math.ceil(n * this.config.tierBoundaries.silver));

    // Assign tiers
    for (let i = 0; i < n; i++) {
      if (i < goldCutoff) guilds[i].tier = "gold";
      else if (i < silverCutoff) guilds[i].tier = "silver";
      else guilds[i].tier = "bronze";
    }

    // Compute per-tier pools
    const tierPools: Record<GuildRewardTier, number> = {
      gold: Math.floor(poolCredits * this.config.tierShares.gold),
      silver: Math.floor(poolCredits * this.config.tierShares.silver),
      bronze: Math.floor(poolCredits * this.config.tierShares.bronze),
    };

    // Distribute within each tier proportional to score
    for (const tier of ["gold", "silver", "bronze"] as GuildRewardTier[]) {
      const tierGuilds = guilds.filter((g) => g.tier === tier);
      const tierTotal = tierGuilds.reduce((s, g) => s + g.score, 0);
      const tierPool = tierPools[tier];

      if (tierTotal === 0 || tierGuilds.length === 0) continue;

      for (const guild of tierGuilds) {
        const share = guild.score / tierTotal;
        guild.rewardCredits = Math.min(Math.floor(tierPool * share), maxPerGuild);
      }
    }

    return guilds;
  }

  // ----------------------------------------------------------
  //  Auto-distribution trigger
  // ----------------------------------------------------------

  private async runAutoDistributions(): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ guild_id: string; min_distribution: string }>(
        `SELECT rc.guild_id, rc.min_distribution
         FROM guild_revenue_configs rc
         JOIN guild_treasuries t ON t.guild_id = rc.guild_id
         WHERE rc.auto_distribute = true AND t.balance >= rc.min_distribution`,
      );

      for (const row of rows) {
        try {
          await this.treasuryService.distributeRevenueInternal(row.guild_id);
          logSecurityEvent("info", "guild-auto-distribution-triggered", {
            guildId: row.guild_id,
          });
        } catch (err) {
          logSecurityEvent("warn", "guild-auto-distribution-failed", {
            guildId: row.guild_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "guild-auto-distribution-query-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----------------------------------------------------------
  //  Economic activity queries (all wrapped in try/catch)
  // ----------------------------------------------------------

  private async queryBountyCompletions(memberIds: string[], periodStart: Date, periodEnd: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(COUNT(*), 0) AS total FROM bounty_completions
         WHERE completer_id = ANY($1) AND completed_at >= $2 AND completed_at < $3`,
        [memberIds, periodStart, periodEnd],
      );
      return Number(rows[0]?.total ?? 0);
    } catch { return 0; }
  }

  private async queryBountyCreations(memberAddrs: string[], periodStart: Date, periodEnd: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(COUNT(*), 0) AS total FROM idx_bounties
         WHERE LOWER(creator) = ANY($1) AND _block_timestamp >= $2 AND _block_timestamp < $3`,
        [memberAddrs, periodStart, periodEnd],
      );
      return Number(rows[0]?.total ?? 0);
    } catch { return 0; }
  }

  private async queryMarketplaceProvided(memberIds: string[], periodStart: Date, periodEnd: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(COUNT(*), 0) AS total FROM service_agreements
         WHERE provider_agent_id = ANY($1) AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [memberIds, periodStart, periodEnd],
      );
      return Number(rows[0]?.total ?? 0);
    } catch { return 0; }
  }

  private async queryMarketplaceBought(memberIds: string[], periodStart: Date, periodEnd: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(COUNT(*), 0) AS total FROM service_agreements
         WHERE buyer_agent_id = ANY($1) AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [memberIds, periodStart, periodEnd],
      );
      return Number(rows[0]?.total ?? 0);
    } catch { return 0; }
  }

  private async queryCreditPurchases(memberIds: string[], periodStart: Date, periodEnd: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(COUNT(*), 0) AS total FROM credit_transactions
         WHERE agent_id = ANY($1) AND type = 'credit_purchase'
           AND created_at >= $2 AND created_at < $3`,
        [memberIds, periodStart, periodEnd],
      );
      return Number(rows[0]?.total ?? 0);
    } catch { return 0; }
  }

  private async queryRevenueDistributions(guildId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM treasury_distributions
         WHERE guild_id = $1 AND created_at >= $2 AND created_at < $3`,
        [guildId, periodStart, periodEnd],
      );
      return Number(rows[0]?.total ?? 0) / 100; // normalize from stored to display
    } catch { return 0; }
  }

  // ----------------------------------------------------------
  //  Wash-trade detection
  // ----------------------------------------------------------

  private async computeWashTradePct(
    memberIds: string[],
    memberAddrs: string[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    if (memberIds.length < 2) return 0;

    let internalSettlements = 0;
    let totalSettlements = 0;

    // Check service agreements where both parties are guild members
    try {
      const { rows } = await this.pool.query<{ internal_count: string; total_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE provider_agent_id = ANY($1) AND buyer_agent_id = ANY($1)) AS internal_count,
           COUNT(*) AS total_count
         FROM service_agreements
         WHERE (provider_agent_id = ANY($1) OR buyer_agent_id = ANY($1))
           AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [memberIds, periodStart, periodEnd],
      );
      internalSettlements += Number(rows[0]?.internal_count ?? 0);
      totalSettlements += Number(rows[0]?.total_count ?? 0);
    } catch { /* graceful degradation */ }

    // Check bounty completions where both creator and completer are guild members
    try {
      const { rows } = await this.pool.query<{ internal_count: string; total_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE bc.completer_id = ANY($1) AND LOWER(ib.creator) = ANY($2)) AS internal_count,
           COUNT(*) AS total_count
         FROM bounty_completions bc
         LEFT JOIN idx_bounties ib ON bc.bounty_id::text = ib.bounty_id::text
         WHERE bc.completer_id = ANY($1)
           AND bc.completed_at >= $3 AND bc.completed_at < $4`,
        [memberIds, memberAddrs, periodStart, periodEnd],
      );
      internalSettlements += Number(rows[0]?.internal_count ?? 0);
      totalSettlements += Number(rows[0]?.total_count ?? 0);
    } catch { /* graceful degradation */ }

    if (totalSettlements === 0) return 0;
    return internalSettlements / totalSettlements;
  }

  // ----------------------------------------------------------
  //  Cross-guild wash trade detection
  // ----------------------------------------------------------

  /**
   * Detects coordinated rings across two guilds: if >50% of a guild's
   * external trades go to members of a single other guild, return that %.
   */
  private async computeCrossGuildConcentration(
    memberIds: string[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    if (memberIds.length === 0) return 0;

    try {
      // Get all external counterparties from service agreements
      const { rows } = await this.pool.query<{ counterparty: string }>(
        `SELECT
           CASE
             WHEN provider_agent_id = ANY($1) THEN buyer_agent_id
             ELSE provider_agent_id
           END AS counterparty
         FROM service_agreements
         WHERE (provider_agent_id = ANY($1) OR buyer_agent_id = ANY($1))
           AND NOT (provider_agent_id = ANY($1) AND buyer_agent_id = ANY($1))
           AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [memberIds, periodStart, periodEnd],
      );

      if (rows.length === 0) return 0;

      const totalExternal = rows.length;

      // For each external counterparty, find their guild memberships
      const counterpartyIds = [...new Set(rows.map((r) => r.counterparty))];
      const { rows: guildMemberships } = await this.pool.query<{ member_agent_id: string; guild_id: string }>(
        `SELECT a.id AS member_agent_id, gm.guild_id::text AS guild_id
         FROM agents a
         JOIN idx_guild_members gm ON LOWER(a.address) = LOWER(gm.member_id)
         WHERE a.id = ANY($1) AND gm.status = 2`,
        [counterpartyIds],
      );

      // Count trades per external guild
      const counterpartyGuildMap = new Map<string, Set<string>>();
      for (const m of guildMemberships) {
        if (!counterpartyGuildMap.has(m.member_agent_id)) {
          counterpartyGuildMap.set(m.member_agent_id, new Set());
        }
        counterpartyGuildMap.get(m.member_agent_id)!.add(m.guild_id);
      }

      // Tally: how many external trades go to members of each other guild
      const guildTradeCount = new Map<string, number>();
      for (const row of rows) {
        const guilds = counterpartyGuildMap.get(row.counterparty);
        if (guilds) {
          for (const gId of guilds) {
            guildTradeCount.set(gId, (guildTradeCount.get(gId) ?? 0) + 1);
          }
        }
      }

      // Return the max concentration to any single other guild
      let maxConcentration = 0;
      for (const count of guildTradeCount.values()) {
        maxConcentration = Math.max(maxConcentration, count / totalExternal);
      }

      return maxConcentration;
    } catch {
      return 0; // graceful degradation
    }
  }

  // ----------------------------------------------------------
  //  External counterparty counting
  // ----------------------------------------------------------

  private async countExternalCounterparties(
    memberIds: string[],
    memberAddrs: string[],
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const externalIds = new Set<string>();

    // Service agreements — find counterparties not in the guild
    try {
      const { rows } = await this.pool.query<{ counterparty: string }>(
        `SELECT DISTINCT
           CASE
             WHEN provider_agent_id = ANY($1) THEN buyer_agent_id
             ELSE provider_agent_id
           END AS counterparty
         FROM service_agreements
         WHERE (provider_agent_id = ANY($1) OR buyer_agent_id = ANY($1))
           AND status IN ('completed', 'settled')
           AND settled_at >= $2 AND settled_at < $3`,
        [memberIds, periodStart, periodEnd],
      );
      for (const row of rows) {
        if (!memberIds.includes(row.counterparty)) {
          externalIds.add(row.counterparty);
        }
      }
    } catch { /* graceful degradation */ }

    return externalIds.size;
  }

  // ----------------------------------------------------------
  //  Helpers
  // ----------------------------------------------------------

  private async resolveMemberIds(addresses: string[]): Promise<Array<{ agentId: string; address: string }>> {
    if (addresses.length === 0) return [];
    try {
      const { rows } = await this.pool.query<{ id: string; address: string }>(
        `SELECT id, address FROM agents WHERE LOWER(address) = ANY($1::text[])`,
        [addresses.map((a) => a.toLowerCase())],
      );
      return rows.map((r) => ({ agentId: r.id, address: r.address }));
    } catch {
      return [];
    }
  }

  private async loadPoolCredits(): Promise<number> {
    try {
      const { rows } = await this.pool.query<{ value: string }>(
        `SELECT value FROM system_settings WHERE key = 'guild_weekly_pool_credits'`,
      );
      if (rows.length > 0) return parseInt(rows[0].value, 10) || this.config.poolCredits;
    } catch { /* use default */ }
    return this.config.poolCredits;
  }

  /** ISO week number (Monday-based) — same formula as WeeklyRewardService */
  getCurrentEpochNumber(now: Date): number {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return d.getUTCFullYear() * 100 + weekNumber;
  }

  getEpochBounds(epochNumber: number): { periodStart: Date; periodEnd: Date } {
    const year = Math.floor(epochNumber / 100);
    const week = epochNumber % 100;

    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (dayOfWeek - 1) * 86_400_000);
    const weekMonday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);

    // Deterministic jitter
    let jitterHours = 0;
    if (this.config.maxJitterHours > 0) {
      const jitterHash = crypto
        .createHash("sha256")
        .update(`guild-weekly:${epochNumber}`)
        .digest();
      jitterHours = (jitterHash.readUInt32BE(0) % (this.config.maxJitterHours * 60)) / 60;
    }

    const periodStart = new Date(weekMonday.getTime() + jitterHours * 3_600_000);
    const periodEnd = new Date(periodStart.getTime() + 7 * 86_400_000);

    return { periodStart, periodEnd };
  }
}
