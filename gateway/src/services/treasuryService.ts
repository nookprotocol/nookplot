/**
 * TreasuryService — Guild economics: treasury, collective funding, revenue sharing.
 *
 * Off-chain credit-gated operations.
 * Guild members pool credits into a shared treasury, fund bounties collectively,
 * and distribute revenue proportional to contribution scores.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEPOSIT_MIN = 10;          // 0.10 credits minimum deposit
const WITHDRAW_MIN = 10;         // 0.10 credits minimum withdrawal
const FUND_BOUNTY_MIN = 100;     // 1.00 credits minimum bounty funding
const DISTRIBUTE_COST = 10;      // 0.10 credits overhead per distribution run

const VALID_DISTRIBUTION_MODES = new Set(["contribution", "equal", "custom"]);

// ─── Service ──────────────────────────────────────────────────────────────────

export class TreasuryService {
  private readonly pool: pg.Pool;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private creditManager: any = null;
  private messageBus: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setCreditManager(cm: any): void { this.creditManager = cm; }
  setMessageBus(mb: any): void { this.messageBus = mb; }

  // ============================================================
  //  Treasury Initialization
  // ============================================================

  /** Ensure a treasury exists for a guild (idempotent). */
  async ensureTreasury(guildId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO guild_treasuries (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
      [guildId],
    );
  }

  // ============================================================
  //  Deposit
  // ============================================================

  /** Agent deposits credits from their balance into guild treasury. */
  async deposit(
    agentId: string,
    guildId: string,
    amount: number,
    memo?: string,
  ): Promise<{ transaction: any; balance: number }> {
    if (amount < DEPOSIT_MIN) {
      throw Object.assign(new Error("Minimum deposit is 0.10 credits"), { code: "INVALID_AMOUNT" });
    }

    // Verify guild membership (approved = status 2)
    await this.requireGuildMember(agentId, guildId);

    // Deduct from agent's credit balance
    if (!this.creditManager) throw new Error("CreditManager not configured");
    try {
      await this.creditManager.deductCredits(agentId, amount, `treasury_deposit:${guildId}`, "treasury_deposit");
    } catch {
      throw Object.assign(new Error("Insufficient credits"), { code: "INSUFFICIENT_CREDITS" });
    }

    // Ensure treasury exists and credit it
    await this.ensureTreasury(guildId);

    const result = await this.pool.query(
      `UPDATE guild_treasuries
       SET balance = balance + $1, total_deposited = total_deposited + $1, updated_at = NOW()
       WHERE guild_id = $2
       RETURNING balance`,
      [amount, guildId],
    );
    const newBalance = Number(result.rows[0].balance);

    // Log transaction
    const txId = randomUUID();
    await this.pool.query(
      `INSERT INTO treasury_transactions (id, guild_id, agent_id, tx_type, amount, direction, balance_after, memo)
       VALUES ($1, $2, $3, 'deposit', $4, 'credit', $5, $6)`,
      [txId, guildId, agentId, amount, newBalance, memo || null],
    );

    this.publishEvent(guildId, "guild.treasury_deposit", {
      guildId, agentId, amount, balance: newBalance,
    });

    return {
      transaction: { id: txId, tx_type: "deposit", amount, balance_after: newBalance },
      balance: newBalance,
    };
  }

  // ============================================================
  //  Withdraw
  // ============================================================

  /** Admin withdraws credits from treasury back to their personal balance. */
  async withdraw(
    agentId: string,
    guildId: string,
    amount: number,
    memo?: string,
  ): Promise<{ transaction: any; balance: number }> {
    if (amount < WITHDRAW_MIN) {
      throw Object.assign(new Error("Minimum withdrawal is 0.10 credits"), { code: "INVALID_AMOUNT" });
    }

    // Verify agent is guild proposer (admin)
    await this.requireGuildAdmin(agentId, guildId);

    // Debit treasury
    const result = await this.pool.query(
      `UPDATE guild_treasuries
       SET balance = balance - $1, total_withdrawn = total_withdrawn + $1, updated_at = NOW()
       WHERE guild_id = $2 AND balance >= $1
       RETURNING balance`,
      [amount, guildId],
    );

    if (result.rowCount === 0) {
      throw Object.assign(new Error("Insufficient treasury balance"), { code: "INSUFFICIENT_TREASURY" });
    }
    const newBalance = Number(result.rows[0].balance);

    // Credit agent's personal balance
    await this.creditManager.addCredits(agentId, amount, "treasury_withdraw", guildId);

    // Log transaction
    const txId = randomUUID();
    await this.pool.query(
      `INSERT INTO treasury_transactions (id, guild_id, agent_id, tx_type, amount, direction, balance_after, memo)
       VALUES ($1, $2, $3, 'withdraw', $4, 'debit', $5, $6)`,
      [txId, guildId, agentId, amount, newBalance, memo || null],
    );

    this.publishEvent(guildId, "guild.treasury_withdraw", {
      guildId, agentId, amount, balance: newBalance,
    });

    return {
      transaction: { id: txId, tx_type: "withdraw", amount, balance_after: newBalance },
      balance: newBalance,
    };
  }

  // ============================================================
  //  Fund Bounty
  // ============================================================

  /** Fund a bounty from guild treasury. Admin-only or via passed proposal. */
  async fundBounty(
    agentId: string,
    guildId: string,
    bountyId: string,
    amount: number,
    proposalId?: string,
  ): Promise<{ transaction: any; balance: number }> {
    // If no proposal backing, require admin
    if (!proposalId) {
      await this.requireGuildAdmin(agentId, guildId);
    }

    return this.fundBountyCore(guildId, bountyId, amount, proposalId, agentId);
  }

  /** Core bounty funding logic. agentId is null for system/proposal actions. */
  private async fundBountyCore(
    guildId: string,
    bountyId: string,
    amount: number,
    proposalId?: string,
    agentId?: string | null,
  ): Promise<{ transaction: any; balance: number }> {
    if (amount < FUND_BOUNTY_MIN) {
      throw Object.assign(new Error("Minimum bounty funding is 1.00 credits"), { code: "INVALID_AMOUNT" });
    }

    // Debit treasury
    const result = await this.pool.query(
      `UPDATE guild_treasuries
       SET balance = balance - $1, total_funded = total_funded + $1, updated_at = NOW()
       WHERE guild_id = $2 AND balance >= $1
       RETURNING balance`,
      [amount, guildId],
    );

    if (result.rowCount === 0) {
      throw Object.assign(new Error("Insufficient treasury balance"), { code: "INSUFFICIENT_TREASURY" });
    }
    const newBalance = Number(result.rows[0].balance);

    // Log transaction
    const txId = randomUUID();
    await this.pool.query(
      `INSERT INTO treasury_transactions (id, guild_id, agent_id, tx_type, amount, direction, balance_after, reference_type, reference_id)
       VALUES ($1, $2, $3, 'fund_bounty', $4, 'debit', $5, 'bounty', $6)`,
      [txId, guildId, agentId ?? null, amount, newBalance, bountyId],
    );

    this.publishEvent(guildId, "guild.treasury_fund_bounty", {
      guildId, agentId: agentId ?? null, bountyId, amount, balance: newBalance,
    });

    return {
      transaction: { id: txId, tx_type: "fund_bounty", amount, balance_after: newBalance },
      balance: newBalance,
    };
  }

  // ============================================================
  //  Revenue Distribution
  // ============================================================

  /** Distribute treasury credits to guild members proportional to contribution scores. */
  async distributeRevenue(
    agentId: string,
    guildId: string,
    amount?: number,
  ): Promise<{ distributionId: string; totalDistributed: number; recipients: number; balance: number }> {
    // Require admin
    await this.requireGuildAdmin(agentId, guildId);

    // Charge distribution overhead
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, DISTRIBUTE_COST, `treasury_distribute:${guildId}`, "treasury_distribute");
      } catch {
        throw Object.assign(new Error("Insufficient credits for distribution fee"), { code: "INSUFFICIENT_CREDITS" });
      }
    }

    return this.distributeRevenueCore(guildId, amount, agentId);
  }

  /** Core distribution logic shared by admin and auto-distribution paths. */
  private async distributeRevenueCore(
    guildId: string,
    amount?: number,
    triggeredBy?: string,
  ): Promise<{ distributionId: string; totalDistributed: number; recipients: number; balance: number }> {
    // Get treasury
    const treasuryResult = await this.pool.query(
      `SELECT balance FROM guild_treasuries WHERE guild_id = $1`,
      [guildId],
    );
    if (treasuryResult.rowCount === 0) {
      throw Object.assign(new Error("Treasury not found"), { code: "NOT_FOUND" });
    }
    const treasuryBalance = Number(treasuryResult.rows[0].balance);

    // Get revenue config
    const configResult = await this.pool.query(
      `SELECT * FROM guild_revenue_configs WHERE guild_id = $1`,
      [guildId],
    );
    const config = configResult.rows[0] || {
      treasury_pct: 20,
      member_pct: 80,
      distribution_mode: "contribution",
    };

    // Calculate distributable amount
    const memberPct = config.member_pct / 100;
    const maxDistributable = Math.floor(treasuryBalance * memberPct);
    const distributeAmount = amount ? Math.min(amount, maxDistributable) : maxDistributable;

    if (distributeAmount < 100) { // less than 1.00 credit
      throw Object.assign(new Error("Distributable amount too small (< 1.00 credits)"), { code: "INVALID_AMOUNT" });
    }

    // Get approved guild members
    const members = await this.getGuildMembers(guildId);
    if (members.length === 0) {
      throw Object.assign(new Error("No guild members to distribute to"), { code: "NO_MEMBERS" });
    }

    // Compute shares based on distribution mode
    const shares = await this.computeShares(members, config.distribution_mode, guildId);

    // Debit treasury
    const debitResult = await this.pool.query(
      `UPDATE guild_treasuries
       SET balance = balance - $1, total_distributed = total_distributed + $1, updated_at = NOW()
       WHERE guild_id = $2 AND balance >= $1
       RETURNING balance`,
      [distributeAmount, guildId],
    );
    if (debitResult.rowCount === 0) {
      throw Object.assign(new Error("Insufficient treasury balance"), { code: "INSUFFICIENT_TREASURY" });
    }
    const newBalance = Number(debitResult.rows[0].balance);

    // Distribute to each member
    const distributionId = randomUUID();
    let totalDistributed = 0;
    const caller = triggeredBy || "system:auto_distribute";

    for (const share of shares) {
      const memberAmount = Math.floor(distributeAmount * share.pct);
      if (memberAmount <= 0) continue;

      // Credit member
      if (this.creditManager) {
        await this.creditManager.addCredits(share.agentId, memberAmount, "treasury_revenue", guildId);
      }

      // Record distribution
      await this.pool.query(
        `INSERT INTO treasury_distributions (guild_id, distribution_id, agent_id, agent_address, amount, share_pct, contribution_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [guildId, distributionId, share.agentId, share.address, memberAmount, share.pct * 100, share.score],
      );

      totalDistributed += memberAmount;
    }

    // Log transaction
    const txId = randomUUID();
    await this.pool.query(
      `INSERT INTO treasury_transactions (id, guild_id, agent_id, tx_type, amount, direction, balance_after, reference_type, reference_id, memo)
       VALUES ($1, $2, $3, 'revenue_share', $4, 'debit', $5, 'distribution', $6, $7)`,
      [txId, guildId, caller, totalDistributed, newBalance, distributionId,
       `Distributed to ${shares.filter(s => Math.floor(distributeAmount * s.pct) > 0).length} members`],
    );

    this.publishEvent(guildId, "guild.treasury_distributed", {
      guildId, distributionId, totalDistributed, recipients: shares.length, balance: newBalance,
    });

    return {
      distributionId,
      totalDistributed,
      recipients: shares.filter(s => Math.floor(distributeAmount * s.pct) > 0).length,
      balance: newBalance,
    };
  }

  // ============================================================
  //  Revenue Config
  // ============================================================

  /** Set revenue sharing configuration for a guild. Admin-only. */
  async setRevenueConfig(
    agentId: string,
    guildId: string,
    input: {
      treasuryPct?: number;
      memberPct?: number;
      distributionMode?: string;
      minDistribution?: number;
      autoDistribute?: boolean;
    },
  ): Promise<any> {
    await this.requireGuildAdmin(agentId, guildId);
    await this.ensureTreasury(guildId);

    const treasuryPct = input.treasuryPct ?? 20;
    const memberPct = input.memberPct ?? 80;

    if (treasuryPct + memberPct !== 100) {
      throw Object.assign(new Error("treasury_pct + member_pct must equal 100"), { code: "INVALID_CONFIG" });
    }
    if (input.distributionMode && !VALID_DISTRIBUTION_MODES.has(input.distributionMode)) {
      throw Object.assign(
        new Error(`Invalid distribution mode. Must be: ${[...VALID_DISTRIBUTION_MODES].join(", ")}`),
        { code: "INVALID_CONFIG" },
      );
    }

    const result = await this.pool.query(
      `INSERT INTO guild_revenue_configs (guild_id, treasury_pct, member_pct, distribution_mode, min_distribution, auto_distribute, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guild_id) DO UPDATE SET
         treasury_pct = EXCLUDED.treasury_pct,
         member_pct = EXCLUDED.member_pct,
         distribution_mode = EXCLUDED.distribution_mode,
         min_distribution = EXCLUDED.min_distribution,
         auto_distribute = EXCLUDED.auto_distribute,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [
        guildId,
        treasuryPct,
        memberPct,
        input.distributionMode || "contribution",
        input.minDistribution ?? 100,
        input.autoDistribute ?? false,
        agentId,
      ],
    );

    return result.rows[0];
  }

  /** Get revenue config for a guild. */
  async getRevenueConfig(guildId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT * FROM guild_revenue_configs WHERE guild_id = $1`,
      [guildId],
    );
    return result.rows[0] || {
      guild_id: guildId,
      treasury_pct: 20,
      member_pct: 80,
      distribution_mode: "contribution",
      min_distribution: 100,
      auto_distribute: false,
    };
  }

  // ============================================================
  //  Read Methods
  // ============================================================

  /** Get treasury balance and stats. */
  async getTreasury(guildId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT * FROM guild_treasuries WHERE guild_id = $1`,
      [guildId],
    );
    if (result.rowCount === 0) {
      return {
        guild_id: guildId,
        balance: 0,
        total_deposited: 0,
        total_withdrawn: 0,
        total_funded: 0,
        total_distributed: 0,
      };
    }
    return result.rows[0];
  }

  /** Get transaction history for a guild treasury. */
  async getTransactions(
    guildId: string,
    opts?: { limit?: number; offset?: number; txType?: string },
  ): Promise<any[]> {
    const limit = Math.min(opts?.limit || 50, 100);
    const offset = opts?.offset || 0;
    const params: any[] = [guildId, limit, offset];
    let where = "WHERE guild_id = $1";

    if (opts?.txType) {
      where += ` AND tx_type = $${params.length + 1}`;
      params.push(opts.txType);
    }

    const result = await this.pool.query(
      `SELECT * FROM treasury_transactions ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      params,
    );
    return result.rows;
  }

  /** Get distribution history. */
  async getDistributions(
    guildId: string,
    opts?: { limit?: number; distributionId?: string },
  ): Promise<any[]> {
    if (opts?.distributionId) {
      const result = await this.pool.query(
        `SELECT * FROM treasury_distributions WHERE guild_id = $1 AND distribution_id = $2 ORDER BY amount DESC`,
        [guildId, opts.distributionId],
      );
      return result.rows;
    }

    const limit = Math.min(opts?.limit || 50, 100);
    const result = await this.pool.query(
      `SELECT * FROM treasury_distributions WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [guildId, limit],
    );
    return result.rows;
  }

  // ============================================================
  //  Internal: Fund Bounty from Proposal Execution
  // ============================================================

  /** Internal method. Called by auto-distribution tick when auto_distribute=true and balance >= threshold. */
  async distributeRevenueInternal(guildId: string): Promise<{ distributionId: string; totalDistributed: number; recipients: number; balance: number }> {
    return this.distributeRevenueCore(guildId);
  }

  /** Internal method. Called by ProposalService when a fund_bounty proposal passes. */
  async fundBountyInternal(
    guildId: string,
    bountyId: string,
    amount: number,
    proposalId: string,
  ): Promise<{ transaction: any; balance: number }> {
    return this.fundBountyCore(guildId, bountyId, amount, proposalId);
  }

  // ============================================================
  //  Helpers
  // ============================================================

  /** Get approved guild members with their agent IDs. */
  private async getGuildMembers(guildId: string): Promise<Array<{ agentId: string; address: string }>> {
    const result = await this.pool.query(
      `SELECT gm.member_id AS address, a.id AS agent_id
       FROM idx_guild_members gm
       JOIN agents a ON LOWER(a.address) = LOWER(gm.member_id)
       WHERE gm.guild_id = $1 AND gm.status = 2`,
      [guildId],
    );
    return result.rows.map((r: any) => ({ agentId: r.agent_id, address: r.address }));
  }

  /** Compute share percentages for each member based on distribution mode. */
  private async computeShares(
    members: Array<{ agentId: string; address: string }>,
    mode: string,
    guildId: string,
  ): Promise<Array<{ agentId: string; address: string; pct: number; score: number | null }>> {
    if (mode === "equal") {
      const pct = 1 / members.length;
      return members.map(m => ({ ...m, pct, score: null }));
    }

    // Default: contribution-based
    const scores: Array<{ agentId: string; address: string; score: number }> = [];
    let totalScore = 0;

    for (const member of members) {
      try {
        const result = await this.pool.query(
          `SELECT overall_score FROM contribution_scores WHERE agent_id = $1`,
          [member.agentId],
        );
        const score = result.rows[0]?.overall_score ? Number(result.rows[0].overall_score) : 1;
        scores.push({ ...member, score });
        totalScore += score;
      } catch {
        // Graceful degradation — give minimum score
        scores.push({ ...member, score: 1 });
        totalScore += 1;
      }
    }

    if (totalScore === 0) {
      // Fallback to equal if everyone is 0
      const pct = 1 / members.length;
      return scores.map(s => ({ ...s, pct }));
    }

    return scores.map(s => ({
      ...s,
      pct: s.score / totalScore,
    }));
  }

  /** Verify agent is an approved guild member. */
  private async requireGuildMember(agentId: string, guildId: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM idx_guild_members gm
       JOIN agents a ON LOWER(a.address) = LOWER(gm.member_id)
       WHERE gm.guild_id = $1 AND a.id = $2 AND gm.status = 2`,
      [guildId, agentId],
    );
    if (result.rowCount === 0) {
      throw Object.assign(new Error("Not a guild member"), { code: "FORBIDDEN" });
    }
  }

  /** Verify agent is the guild proposer (admin). */
  private async requireGuildAdmin(agentId: string, guildId: string): Promise<void> {
    // Check if agent is proposer of the guild (on-chain admin)
    const result = await this.pool.query(
      `SELECT 1 FROM idx_guilds g
       JOIN agents a ON LOWER(a.address) = LOWER(g.proposer_id)
       WHERE g.guild_id = CAST(('x' || LPAD(REPLACE($1, '0x', ''), 8, '0'))::bit(32)::int AS INTEGER) AND a.id = $2`,
      [guildId, agentId],
    );
    if (result.rowCount === 0) {
      throw Object.assign(new Error("Not a guild admin"), { code: "FORBIDDEN" });
    }
  }

  /** Publish real-time event via message bus. */
  private publishEvent(guildId: string, type: string, data: any): void {
    if (!this.messageBus) return;
    try {
      this.messageBus.publish(`guild:${guildId}`, { type, data, ts: Date.now() });
    } catch (err) {
      logSecurityEvent("warn", "treasury-event-publish-failed", { guildId, type, error: String(err) });
    }
  }
}
