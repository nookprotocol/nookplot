/**
 * Merkle reward service.
 *
 * Computes weekly Merkle trees for on-chain NOOK reward distribution.
 * 100% of the pool goes to agents (guilds disabled until guild system is ready).
 *
 * Both pool types use `overall_score` (10-dimension recency-weighted
 * score) from the contribution_scores table.
 *
 * Uses sqrt dampening to prevent whales from dominating distributions.
 * Cumulative amounts enable efficient on-chain claiming (claim once for
 * all accumulated rewards).
 *
 * Feature-flagged behind `merkleRewardEnabled`.
 *
 * @module services/merkleRewardService
 */

import crypto from "node:crypto";
import type pg from "pg";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface MerkleRewardConfig {
  /** Share of pool going to agents (default: 1.0 = 100% — guilds disabled) */
  agentSharePct: number;
  /** Share of pool going to guilds (default: 0.0 = 0% — guilds disabled) */
  guildSharePct: number;
  /** Tick interval in milliseconds (default: 1 hour) */
  tickIntervalMs: number;
  /** Apply sqrt dampening to scores (default: true) */
  sqrtDampening: boolean;
  /** Maximum jitter hours for epoch boundary offset */
  maxJitterHours: number;
  /** Config-based budget (in token wei) for wETH pool when on-chain reading unavailable */
  wethBudget: string;
  /** Config-based budget (in token wei) for NOOK pool when on-chain reading unavailable */
  nookBudget: string;
}

const DEFAULT_CONFIG: MerkleRewardConfig = {
  agentSharePct: 1.0,   // 100% to agents (guilds disabled)
  guildSharePct: 0.0,   // 0% to guilds (disabled until guild system ready)
  tickIntervalMs: 3_600_000,
  sqrtDampening: true,
  maxJitterHours: 12,
  wethBudget: "0",                          // wETH disabled for now
  nookBudget: "100000000000000000000000",    // 100k NOOK default (18 decimals)
};

export type PoolType = "weth" | "nook";

interface RewardEntry {
  address: string;
  entityType: "agent" | "guild";
  score: number;
  epochAmount: bigint;
  cumulativeAmount: bigint;
  proof: string[];
}

// ============================================================
//  Service
// ============================================================

export class MerkleRewardService {
  private readonly pool: pg.Pool;
  private readonly config: MerkleRewardConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(
    pool: pg.Pool,
    config?: Partial<MerkleRewardConfig>,
  ) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ----------------------------------------------------------
  //  Lifecycle
  // ----------------------------------------------------------

  start(): void {
    if (this.timer) return;

    this.tick().catch((err) => {
      logSecurityEvent("warn", "merkle-reward-initial-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logSecurityEvent("warn", "merkle-reward-tick-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.tickIntervalMs);

    logSecurityEvent("info", "merkle-reward-service-started", {
      tickIntervalMs: this.config.tickIntervalMs,
      agentSharePct: this.config.agentSharePct,
      guildSharePct: this.config.guildSharePct,
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
      const { periodEnd } = this.getEpochBounds(epoch);

      if (now < periodEnd) return; // current epoch hasn't ended

      // Process both pool types
      for (const poolType of ["weth", "nook"] as PoolType[]) {
        const { rows } = await this.pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM merkle_reward_roots WHERE pool_type = $1 AND epoch_number = $2`,
          [poolType, epoch],
        );
        if (Number(rows[0].count) > 0) continue; // already processed

        await this.computeEpoch(poolType, epoch);
      }
    } catch (err) {
      logSecurityEvent("warn", "merkle-reward-tick-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  // ----------------------------------------------------------
  //  Epoch computation
  // ----------------------------------------------------------

  async computeEpoch(poolType: PoolType, epochNumber: number): Promise<{ merkleRoot: string; leafCount: number } | null> {
    const budget = BigInt(poolType === "weth" ? await this.loadBudget("weth") : await this.loadBudget("nook"));
    if (budget === 0n) {
      logSecurityEvent("info", "merkle-reward-zero-budget", { poolType, epochNumber });
      return null;
    }

    // 1. Get agent scores
    const agentScores = await this.getAgentScores(poolType);

    // 2. Get guild scores
    const guildScores = await this.getGuildScores(poolType);

    // Filter zero scores
    const validAgents = agentScores.filter((a) => a.score > 0);
    const validGuilds = guildScores.filter((g) => g.score > 0);

    if (validAgents.length === 0 && validGuilds.length === 0) {
      logSecurityEvent("info", "merkle-reward-no-eligible", { poolType, epochNumber });
      return null;
    }

    // 3. Compute budgets (100% agents / 0% guilds by default)
    const agentBudget = (budget * BigInt(Math.floor(this.config.agentSharePct * 10000))) / 10000n;
    const guildBudget = budget - agentBudget;

    // 4. Distribute within each pool using sqrt dampening
    const agentEntries = this.distributePool(validAgents, agentBudget);
    const guildEntries = this.distributePool(validGuilds, guildBudget);

    const allEntries = [...agentEntries, ...guildEntries];
    if (allEntries.length === 0) return null;

    // 5. Retrieve previous cumulative amounts (with entity type for carry-forward)
    const prevCumulative = await this.getPreviousCumulative(poolType, epochNumber);

    // 6. Compute new cumulative amounts
    const currentAddresses = new Set(allEntries.map((e) => e.address.toLowerCase()));
    for (const entry of allEntries) {
      const prev = prevCumulative.get(entry.address.toLowerCase());
      entry.cumulativeAmount = (prev?.amount ?? 0n) + entry.epochAmount;
    }

    // 6b. Carry forward addresses who have prior rewards but aren't earning this epoch.
    //     Without this, agents/guilds who miss an epoch would lose their accumulated
    //     rewards because their leaf would disappear from the tree.
    for (const [addr, prevData] of prevCumulative) {
      if (!currentAddresses.has(addr) && prevData.amount > 0n) {
        allEntries.push({
          address: addr,
          entityType: prevData.entityType,
          score: 0,
          epochAmount: 0n,
          cumulativeAmount: prevData.amount,
          proof: [],
        });
      }
    }

    // 7. Build Merkle tree
    const leaves: Array<[string, bigint]> = allEntries.map((e) => [
      e.address,
      e.cumulativeAmount,
    ]);

    const tree = StandardMerkleTree.of(leaves, ["address", "uint256"]);

    // 8. Attach proofs
    for (const [i, leaf] of tree.entries()) {
      const addr = (leaf[0] as string).toLowerCase();
      const entry = allEntries.find((e) => e.address.toLowerCase() === addr);
      if (entry) {
        entry.proof = tree.getProof(i);
      }
    }

    // 9. Store root + leaves
    const rootId = await this.storeRoot(poolType, epochNumber, tree, allEntries);

    logSecurityEvent("info", "merkle-reward-epoch-computed", {
      poolType,
      epochNumber,
      merkleRoot: tree.root,
      leafCount: allEntries.length,
      agents: agentEntries.length,
      guilds: guildEntries.length,
    });

    return { merkleRoot: tree.root, leafCount: allEntries.length };
  }

  // ----------------------------------------------------------
  //  Score fetching
  // ----------------------------------------------------------

  private async getAgentScores(poolType: PoolType): Promise<Array<{ address: string; entityType: "agent"; score: number }>> {
    try {
      // Both pool types use overall_score.
      const scoreColumn = "overall_score";
      const { rows } = await this.pool.query<{ address: string; score: string }>(
        `SELECT a.address, COALESCE(cs.${scoreColumn}, 0) AS score
         FROM agents a
         LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
         WHERE a.address IS NOT NULL AND COALESCE(cs.${scoreColumn}, 0) > 0`,
      );
      return rows.map((r) => ({
        address: r.address,
        entityType: "agent" as const,
        score: Number(r.score),
      }));
    } catch (err) {
      logSecurityEvent("warn", "merkle-reward-agent-scores-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async getGuildScores(poolType: PoolType): Promise<Array<{ address: string; entityType: "guild"; score: number }>> {
    try {
      // Get guild proposer addresses (wallet that represents the guild on-chain)
      // Both pool types use overall_score (same as agent scores)
      const scoreColumn = "overall_score";
      const { rows } = await this.pool.query<{ guild_id: string; proposer_address: string; avg_score: string }>(
        `SELECT g.guild_id::text, g.proposer_id AS proposer_address,
                COALESCE(AVG(cs.${scoreColumn}), 0) AS avg_score
         FROM idx_guilds g
         JOIN idx_guild_members gm ON gm.guild_id = g.guild_id AND gm.status = 2
         JOIN agents a ON LOWER(a.address) = LOWER(gm.member_id)
         LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
         WHERE g.status = 1 AND g.proposer_id IS NOT NULL
         GROUP BY g.guild_id, g.proposer_id
         HAVING COUNT(gm.member_id) >= 3`,
      );
      return rows
        .filter((r) => Number(r.avg_score) > 0 && r.proposer_address)
        .map((r) => ({
          address: r.proposer_address,
          entityType: "guild" as const,
          score: Number(r.avg_score),
        }));
    } catch (err) {
      logSecurityEvent("warn", "merkle-reward-guild-scores-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ----------------------------------------------------------
  //  Pool distribution with sqrt dampening
  // ----------------------------------------------------------

  private distributePool(
    entries: Array<{ address: string; entityType: "agent" | "guild"; score: number }>,
    budget: bigint,
  ): RewardEntry[] {
    if (entries.length === 0 || budget === 0n) return [];

    // Apply sqrt dampening
    const dampened = entries.map((e) => ({
      ...e,
      dampenedScore: this.config.sqrtDampening ? Math.sqrt(e.score) : e.score,
    }));

    const totalDampened = dampened.reduce((s, e) => s + e.dampenedScore, 0);
    if (totalDampened === 0) return [];

    // Use scaled integer arithmetic to avoid Number(budget) precision loss.
    // Multiply each agent's share numerator by budget, then divide by denominator.
    // Scale dampened scores to BigInt for precision (9 decimal places)
    const scaledTotal = BigInt(Math.floor(totalDampened * 1_000_000_000));

    return dampened.map((e) => {
      const scaledScore = BigInt(Math.floor(e.dampenedScore * 1_000_000_000));
      const epochAmount = (budget * scaledScore) / scaledTotal;
      return {
        address: e.address,
        entityType: e.entityType,
        score: e.score,
        epochAmount,
        cumulativeAmount: 0n, // will be computed later
        proof: [],
      };
    }).filter((e) => e.epochAmount > 0n);
  }

  // ----------------------------------------------------------
  //  Previous cumulative lookup
  // ----------------------------------------------------------

  private async getPreviousCumulative(
    poolType: PoolType,
    currentEpoch: number,
  ): Promise<Map<string, { amount: bigint; entityType: "agent" | "guild" }>> {
    const result = new Map<string, { amount: bigint; entityType: "agent" | "guild" }>();
    try {
      // Get the latest cumulative amount and entity type per address across
      // ALL prior epochs (not just the immediately previous one). This prevents
      // agents who miss an epoch from losing their accumulated rewards.
      // Filter by epoch_number < currentEpoch to avoid double-counting if
      // current epoch is somehow already stored (retry/race).
      const { rows } = await this.pool.query<{
        address: string;
        cumulative_amount: string;
        entity_type: string;
      }>(
        `SELECT DISTINCT ON (LOWER(l.address)) l.address, l.cumulative_amount, l.entity_type
         FROM merkle_reward_leaves l
         JOIN merkle_reward_roots r ON r.id = l.root_id
         WHERE r.pool_type = $1 AND r.epoch_number < $2
         ORDER BY LOWER(l.address), r.epoch_number DESC`,
        [poolType, currentEpoch],
      );
      for (const row of rows) {
        result.set(row.address.toLowerCase(), {
          amount: BigInt(row.cumulative_amount),
          entityType: row.entity_type as "agent" | "guild",
        });
      }
    } catch { /* first epoch has no previous */ }
    return result;
  }

  // ----------------------------------------------------------
  //  Storage
  // ----------------------------------------------------------

  private async storeRoot(
    poolType: PoolType,
    epochNumber: number,
    tree: StandardMerkleTree<[string, bigint]>,
    entries: RewardEntry[],
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const totalAmount = entries.reduce((s, e) => s + e.epochAmount, 0n);

      // Serialize tree dump with BigInt support
      const treeDump = JSON.stringify(tree.dump(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );

      const { rows: [rootRow] } = await client.query<{ id: string }>(
        `INSERT INTO merkle_reward_roots (pool_type, epoch_number, merkle_root, tree_dump, total_amount, leaf_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pool_type, epoch_number) DO NOTHING
         RETURNING id`,
        [
          poolType,
          epochNumber,
          tree.root,
          treeDump,
          totalAmount.toString(),
          entries.length,
        ],
      );

      if (!rootRow) {
        await client.query("ROLLBACK");
        return "";
      }

      const rootId = rootRow.id;

      for (const entry of entries) {
        await client.query(
          `INSERT INTO merkle_reward_leaves (root_id, address, cumulative_amount, epoch_amount, proof, entity_type, score_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (root_id, address) DO NOTHING`,
          [
            rootId,
            entry.address,
            entry.cumulativeAmount.toString(),
            entry.epochAmount.toString(),
            JSON.stringify(entry.proof),
            entry.entityType,
            entry.score,
          ],
        );
      }

      await client.query("COMMIT");
      return rootId;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ----------------------------------------------------------
  //  Public query methods (used by routes)
  // ----------------------------------------------------------

  /** Get claimable amounts for an address across all pool types. */
  async getClaimable(address: string): Promise<{
    weth: { cumulativeAmount: string; epochAmount: string; entityType: string } | null;
    nook: { cumulativeAmount: string; epochAmount: string; entityType: string } | null;
  }> {
    const result: any = { weth: null, nook: null };

    for (const poolType of ["weth", "nook"] as PoolType[]) {
      try {
        const { rows } = await this.pool.query<{
          cumulative_amount: string;
          epoch_amount: string;
          entity_type: string;
        }>(
          `SELECT l.cumulative_amount, l.epoch_amount, l.entity_type
           FROM merkle_reward_leaves l
           JOIN merkle_reward_roots r ON r.id = l.root_id
           WHERE r.pool_type = $1 AND LOWER(l.address) = LOWER($2)
             AND r.published_at IS NOT NULL
           ORDER BY r.epoch_number DESC
           LIMIT 1`,
          [poolType, address],
        );
        if (rows.length > 0) {
          result[poolType] = {
            cumulativeAmount: rows[0].cumulative_amount,
            epochAmount: rows[0].epoch_amount,
            entityType: rows[0].entity_type,
          };
        }
      } catch { /* graceful degradation */ }
    }

    return result;
  }

  /** Get Merkle proof for an address in a specific pool type. */
  async getProof(address: string, poolType: PoolType): Promise<{
    proof: string[];
    cumulativeAmount: string;
    epochNumber: number;
    merkleRoot: string;
  } | null> {
    try {
      const { rows } = await this.pool.query<{
        proof: string[];
        cumulative_amount: string;
        epoch_number: number;
        merkle_root: string;
      }>(
        `SELECT l.proof, l.cumulative_amount, r.epoch_number, r.merkle_root
         FROM merkle_reward_leaves l
         JOIN merkle_reward_roots r ON r.id = l.root_id
         WHERE r.pool_type = $1 AND LOWER(l.address) = LOWER($2)
           AND r.published_at IS NOT NULL
         ORDER BY r.epoch_number DESC
         LIMIT 1`,
        [poolType, address],
      );
      if (rows.length === 0) return null;
      return {
        proof: rows[0].proof,
        cumulativeAmount: rows[0].cumulative_amount,
        epochNumber: rows[0].epoch_number,
        merkleRoot: rows[0].merkle_root,
      };
    } catch {
      return null;
    }
  }

  /** Get reward history for an address. */
  async getHistory(address: string, limit = 20): Promise<Array<{
    poolType: string;
    epochNumber: number;
    epochAmount: string;
    cumulativeAmount: string;
    entityType: string;
    createdAt: string;
  }>> {
    try {
      const { rows } = await this.pool.query<{
        pool_type: string;
        epoch_number: number;
        epoch_amount: string;
        cumulative_amount: string;
        entity_type: string;
        created_at: string;
      }>(
        `SELECT r.pool_type, r.epoch_number, l.epoch_amount, l.cumulative_amount, l.entity_type, l.created_at
         FROM merkle_reward_leaves l
         JOIN merkle_reward_roots r ON r.id = l.root_id
         WHERE LOWER(l.address) = LOWER($1)
           AND r.published_at IS NOT NULL
         ORDER BY r.epoch_number DESC
         LIMIT $2`,
        [address, Math.min(limit, 100)],
      );
      return rows.map((r) => ({
        poolType: r.pool_type,
        epochNumber: r.epoch_number,
        epochAmount: r.epoch_amount,
        cumulativeAmount: r.cumulative_amount,
        entityType: r.entity_type,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------
  //  Helpers
  // ----------------------------------------------------------

  private async loadBudget(poolType: PoolType): Promise<string> {
    try {
      const key = poolType === "weth" ? "merkle_reward_weth_budget" : "merkle_reward_nook_budget";
      const { rows } = await this.pool.query<{ value: string }>(
        `SELECT value FROM system_settings WHERE key = $1`,
        [key],
      );
      if (rows.length > 0 && rows[0].value) return rows[0].value;
    } catch { /* use default */ }
    return poolType === "weth" ? this.config.wethBudget : this.config.nookBudget;
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

    let jitterHours = 0;
    if (this.config.maxJitterHours > 0) {
      const jitterHash = crypto
        .createHash("sha256")
        .update(`merkle-reward:${epochNumber}`)
        .digest();
      jitterHours = (jitterHash.readUInt32BE(0) % (this.config.maxJitterHours * 60)) / 60;
    }

    const periodStart = new Date(weekMonday.getTime() + jitterHours * 3_600_000);
    const periodEnd = new Date(periodStart.getTime() + 7 * 86_400_000);

    return { periodStart, periodEnd };
  }
}
