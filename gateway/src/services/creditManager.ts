/**
 * Credit management for inference economics.
 *
 * Manages per-agent credit accounts: deposits, spends, refunds,
 * auto-conversion from bounty earnings, and credit splitting on spawn.
 * All balance operations use SELECT FOR UPDATE for atomicity.
 *
 * @module services/creditManager
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Broadcaster interface (avoids circular dep on RuntimeEventBroadcaster)
// ============================================================

/** Minimal broadcast interface for credit balance change events. */
export interface CreditEventBroadcaster {
  broadcast(agentId: string, event: { type: string; timestamp: string; data: Record<string, unknown> }): void;
}

/** Minimal inbox interface (avoids circular dep on InboxService). */
export interface CreditInboxSender {
  send(input: { fromAgentId: string; toAgentId: string; messageType?: string; content: string; metadata?: Record<string, unknown> }): Promise<unknown>;
}

// ============================================================
//  Types
// ============================================================

export interface CreditManagerConfig {
  /** Per-token pricing: credits per million tokens, keyed by provider then model. */
  pricing: Record<string, Record<string, { promptPerMToken: number; completionPerMToken: number }>>;
  /** Credits allocated on initial deployment. */
  defaultInitialCredits: number;
  /** Per-agent daily spend cap in credits. */
  maxDailySpend: number;
}

export interface CreditAccountInfo {
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  autoConvertPct: number;
  status: "active" | "low_power" | "paused";
}

export interface CreditTransaction {
  id: string;
  agentId: string;
  amountCredits: number;
  balanceAfter: number;
  type: string;
  referenceId: string | null;
  createdAt: string;
}

export interface UsageSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostCredits: number;
  byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number; costCredits: number }>;
  byModel: Record<string, { requests: number; promptTokens: number; completionTokens: number; costCredits: number }>;
}

// ============================================================
//  CreditManager
// ============================================================

export class CreditManager {
  private readonly pool: pg.Pool;
  private readonly config: CreditManagerConfig;
  private broadcaster: CreditEventBroadcaster | null = null;
  private inboxSender: CreditInboxSender | null = null;

  /** Wire a WebSocket broadcaster for real-time credit balance events. */
  setBroadcaster(b: CreditEventBroadcaster): void {
    this.broadcaster = b;
  }

  /** Wire an inbox sender for budget threshold DMs. */
  setInboxService(svc: CreditInboxSender): void {
    this.inboxSender = svc;
  }

  /** Emit a credits.balance_changed event to the agent's WebSocket connections. */
  private emitBalanceChanged(
    agentId: string,
    balanceAfter: number,
    delta: number,
    reason: string,
    referenceId?: string,
  ): void {
    if (!this.broadcaster) return;
    this.broadcaster.broadcast(agentId, {
      type: "credits.balance_changed",
      timestamp: new Date().toISOString(),
      data: {
        agentId,
        balance: balanceAfter,
        balanceDisplay: CreditManager.toDisplay(balanceAfter),
        delta,
        deltaDisplay: CreditManager.toDisplay(delta),
        reason,
        ...(referenceId ? { referenceId } : {}),
      },
    });
  }

  /** Emit a credits.budget_alert event when a budget threshold is crossed. */
  private emitBudgetAlert(
    agentId: string,
    level: "low" | "critical",
    balance: number,
    threshold: number,
  ): void {
    if (!this.broadcaster) return;
    const suggestion =
      level === "critical"
        ? "Balance below critical threshold. Proactive actions paused. Purchase credits at GET /v1/credits/packs."
        : "Balance below low threshold. Expensive proactive actions will be suppressed. Purchase credits at GET /v1/credits/packs.";
    this.broadcaster.broadcast(agentId, {
      type: "credits.budget_alert",
      timestamp: new Date().toISOString(),
      data: {
        agentId,
        level,
        balance,
        balanceDisplay: CreditManager.toDisplay(balance),
        threshold,
        thresholdDisplay: CreditManager.toDisplay(threshold),
        suggestion,
      },
    });
  }

  /** Send a system DM to an agent when a budget threshold is crossed. */
  private sendBudgetDm(
    agentId: string,
    level: "low" | "critical",
    balance: number,
  ): void {
    if (!this.inboxSender) return;
    const balanceDisplay = CreditManager.toDisplay(balance).toFixed(2);
    const content =
      level === "critical"
        ? `Your credits are critically low (${balanceDisplay} remaining). Actions may fail. Top up: https://nookplot.com/economy#purchase`
        : `Your credits are running low (${balanceDisplay} remaining). Top up: https://nookplot.com/economy#purchase`;

    this.inboxSender
      .send({
        fromAgentId: agentId,
        toAgentId: agentId,
        messageType: "system",
        content,
        metadata: {
          _type: "credits.budget_alert",
          level,
          balance,
          balanceDisplay: CreditManager.toDisplay(balance),
          deepLink: "/economy#purchase",
        },
      })
      .catch((err) => {
        logSecurityEvent("warn", "budget-dm-failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Convert centricredits (stored) to display credits (e.g. 100 → 1.00). */
  static toDisplay(centricredits: number): number {
    return Math.round(centricredits) / 100;
  }

  /** Convert display credits to centricredits (e.g. 1.00 → 100). */
  static toCentricredits(display: number): number {
    return Math.round(display * 100);
  }

  constructor(pool: pg.Pool, config: CreditManagerConfig) {
    this.pool = pool;
    this.config = config;
  }

  /**
   * Create a credit account for a newly deployed agent.
   */
  async createAccount(agentId: string, initialCredits?: number): Promise<void> {
    const credits = initialCredits ?? this.config.defaultInitialCredits;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO credit_accounts (agent_id, balance_credits, lifetime_earned, status)
         VALUES ($1, $2, $2, 'active')
         ON CONFLICT (agent_id) DO NOTHING`,
        [agentId, credits],
      );

      if (credits > 0) {
        await client.query(
          `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
           VALUES ($1, $2, $2, 'initial_deposit', 'deployment')`,
          [agentId, credits],
        );
      }

      await client.query("COMMIT");

      logSecurityEvent("info", "credit-account-created", {
        agentId,
        initialCredits: credits,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Deduct credits atomically. Throws if insufficient balance.
   */
  async deductCredits(
    agentId: string,
    amount: number,
    requestId: string,
    type: string = "inference_spend",
  ): Promise<{ balanceAfter: number }> {
    if (amount <= 0) {
      throw new Error("Deduction amount must be positive");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the row (includes budget thresholds — no extra query needed)
      const { rows } = await client.query<{
        balance_credits: string;
        lifetime_spent: string;
        lifetime_earned: string;
        budget_low_threshold: string;
        budget_critical_threshold: string;
      }>(
        `SELECT balance_credits, lifetime_spent, lifetime_earned, budget_low_threshold, budget_critical_threshold
         FROM credit_accounts WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      );

      // Check daily spend cap INSIDE the transaction to prevent TOCTOU race.
      // The row lock above serializes concurrent deductions for the same agent.
      const { rows: dailyRows } = await client.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(ABS(amount_credits)), 0)::text AS total
         FROM credit_transactions
         WHERE agent_id = $1
           AND amount_credits < 0
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [agentId],
      );
      const dailySpent = Number(dailyRows[0]?.total ?? "0");
      if (dailySpent + amount > this.config.maxDailySpend) {
        await client.query("ROLLBACK");
        throw new Error("DAILY_SPEND_LIMIT");
      }

      if (rows.length === 0) {
        throw new Error("ACCOUNT_NOT_FOUND");
      }

      const currentBalance = Number(rows[0].balance_credits);
      if (currentBalance < amount) {
        await client.query("ROLLBACK");
        throw new Error("INSUFFICIENT_CREDITS");
      }

      const newBalance = currentBalance - amount;
      const newLifetimeSpent = Number(rows[0].lifetime_spent) + amount;
      const lifetimeEarned = Number(rows[0].lifetime_earned);

      // Compute status
      const status = this.computeStatus(newBalance, lifetimeEarned);

      await client.query(
        `UPDATE credit_accounts
         SET balance_credits = $1, lifetime_spent = $2, status = $3, updated_at = NOW()
         WHERE agent_id = $4`,
        [newBalance, newLifetimeSpent, status, agentId],
      );

      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [agentId, -amount, newBalance, type, requestId],
      );

      await client.query("COMMIT");

      if (status === "low_power") {
        logSecurityEvent("warn", "credit-low-power", { agentId, balance: newBalance });
      } else if (status === "paused") {
        logSecurityEvent("warn", "credit-paused", { agentId, balance: newBalance });
      }

      // Emit real-time balance event (fire-and-forget, after commit)
      this.emitBalanceChanged(agentId, newBalance, -amount, type, requestId);

      // Emit budget threshold alerts (exactly once when crossing a threshold)
      const budgetLow = Number(rows[0].budget_low_threshold);
      const budgetCritical = Number(rows[0].budget_critical_threshold);

      if (newBalance <= budgetCritical && currentBalance > budgetCritical) {
        this.emitBudgetAlert(agentId, "critical", newBalance, budgetCritical);
        this.sendBudgetDm(agentId, "critical", newBalance);
      } else if (newBalance <= budgetLow && currentBalance > budgetLow) {
        this.emitBudgetAlert(agentId, "low", newBalance, budgetLow);
        this.sendBudgetDm(agentId, "low", newBalance);
      }

      return { balanceAfter: newBalance };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add credits (top-up, refund, auto-convert).
   */
  async addCredits(
    agentId: string,
    amount: number,
    type: string,
    referenceId?: string,
  ): Promise<{ balanceAfter: number }> {
    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ balance_credits: string; lifetime_earned: string }>(
        `SELECT balance_credits, lifetime_earned
         FROM credit_accounts WHERE agent_id = $1 FOR UPDATE`,
        [agentId],
      );

      if (rows.length === 0) {
        throw new Error("ACCOUNT_NOT_FOUND");
      }

      const newBalance = Number(rows[0].balance_credits) + amount;
      const newLifetimeEarned = Number(rows[0].lifetime_earned) + amount;
      const status = this.computeStatus(newBalance, newLifetimeEarned);

      await client.query(
        `UPDATE credit_accounts
         SET balance_credits = $1, lifetime_earned = $2, status = $3, updated_at = NOW()
         WHERE agent_id = $4`,
        [newBalance, newLifetimeEarned, status, agentId],
      );

      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [agentId, amount, newBalance, type, referenceId ?? null],
      );

      await client.query("COMMIT");

      // Emit real-time balance event (fire-and-forget, after commit)
      this.emitBalanceChanged(agentId, newBalance, amount, type, referenceId);

      return { balanceAfter: newBalance };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Split credits from parent to child during spawn.
   */
  async splitCredits(
    parentId: string,
    childId: string,
    splitPct: number,
  ): Promise<void> {
    if (splitPct <= 0 || splitPct > 100) {
      throw new Error("Split percentage must be 1-100");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock parent
      const { rows: parentRows } = await client.query<{ balance_credits: string; lifetime_earned: string }>(
        `SELECT balance_credits, lifetime_earned
         FROM credit_accounts WHERE agent_id = $1 FOR UPDATE`,
        [parentId],
      );

      if (parentRows.length === 0) {
        throw new Error("PARENT_ACCOUNT_NOT_FOUND");
      }

      const parentBalance = Number(parentRows[0].balance_credits);
      const splitAmount = Math.floor(parentBalance * (splitPct / 100));

      if (splitAmount <= 0) {
        await client.query("ROLLBACK");
        // Create child account with zero credits
        await this.createAccount(childId, 0);
        return;
      }

      const newParentBalance = parentBalance - splitAmount;
      const parentLifetimeEarned = Number(parentRows[0].lifetime_earned);
      const parentStatus = this.computeStatus(newParentBalance, parentLifetimeEarned);

      // Deduct from parent
      await client.query(
        `UPDATE credit_accounts
         SET balance_credits = $1, status = $2, updated_at = NOW()
         WHERE agent_id = $3`,
        [newParentBalance, parentStatus, parentId],
      );

      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $3, 'spawn_split_out', $4)`,
        [parentId, -splitAmount, newParentBalance, childId],
      );

      // Create child account
      await client.query(
        `INSERT INTO credit_accounts (agent_id, balance_credits, lifetime_earned, status)
         VALUES ($1, $2, $2, 'active')
         ON CONFLICT (agent_id) DO NOTHING`,
        [childId, splitAmount],
      );

      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $2, 'spawn_split_in', $3)`,
        [childId, splitAmount, parentId],
      );

      await client.query("COMMIT");

      logSecurityEvent("info", "credit-split", {
        parentId,
        childId,
        splitPct,
        splitAmount,
        parentBalanceAfter: newParentBalance,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Auto-convert bounty earnings to credits based on agent's auto_convert_pct.
   */
  async autoConvertEarnings(
    agentId: string,
    earningsAmount: number,
  ): Promise<number> {
    const { rows } = await this.pool.query<{ auto_convert_pct: number }>(
      `SELECT auto_convert_pct FROM credit_accounts WHERE agent_id = $1`,
      [agentId],
    );

    if (rows.length === 0 || rows[0].auto_convert_pct === 0) {
      return 0;
    }

    const convertAmount = Math.floor(earningsAmount * (rows[0].auto_convert_pct / 100));
    if (convertAmount <= 0) return 0;

    await this.addCredits(agentId, convertAmount, "auto_convert", "bounty_earnings");

    logSecurityEvent("info", "credit-auto-convert", {
      agentId,
      earningsAmount,
      convertPct: rows[0].auto_convert_pct,
      convertAmount,
    });

    return convertAmount;
  }

  /**
   * Set auto-convert percentage for an agent.
   */
  async setAutoConvertPct(agentId: string, pct: number): Promise<void> {
    if (pct < 0 || pct > 100) {
      throw new Error("Auto-convert percentage must be 0-100");
    }

    const result = await this.pool.query(
      `UPDATE credit_accounts SET auto_convert_pct = $1, updated_at = NOW() WHERE agent_id = $2`,
      [pct, agentId],
    );

    if (result.rowCount === 0) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }
  }

  /**
   * Get current credit account info.
   */
  async getBalance(agentId: string): Promise<CreditAccountInfo | null> {
    const { rows } = await this.pool.query<{
      balance_credits: string;
      lifetime_earned: string;
      lifetime_spent: string;
      auto_convert_pct: number;
      status: string;
    }>(
      `SELECT balance_credits, lifetime_earned, lifetime_spent, auto_convert_pct, status
       FROM credit_accounts WHERE agent_id = $1`,
      [agentId],
    );

    if (rows.length === 0) return null;

    return {
      balance: Number(rows[0].balance_credits),
      lifetimeEarned: Number(rows[0].lifetime_earned),
      lifetimeSpent: Number(rows[0].lifetime_spent),
      autoConvertPct: rows[0].auto_convert_pct,
      status: rows[0].status as CreditAccountInfo["status"],
    };
  }

  /**
   * Get paginated transaction ledger.
   */
  async getTransactions(
    agentId: string,
    limit: number,
    offset: number,
  ): Promise<CreditTransaction[]> {
    const { rows } = await this.pool.query<{
      id: string;
      agent_id: string;
      amount_credits: string;
      balance_after: string;
      type: string;
      reference_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, agent_id, amount_credits, balance_after, type, reference_id, created_at
       FROM credit_transactions
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset],
    );

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      amountCredits: Number(r.amount_credits),
      balanceAfter: Number(r.balance_after),
      type: r.type,
      referenceId: r.reference_id,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Get usage summary aggregated from inference_log.
   */
  async getUsageSummary(agentId: string, days: number): Promise<UsageSummary> {
    // Validate days is a positive integer to prevent abuse
    const safeDays = Math.max(1, Math.min(Math.floor(days), 365));

    const { rows } = await this.pool.query<{
      provider: string;
      model: string;
      req_count: string;
      total_prompt: string;
      total_completion: string;
      total_cost: string;
    }>(
      `SELECT provider, model,
              COUNT(*)::text AS req_count,
              COALESCE(SUM(prompt_tokens), 0)::text AS total_prompt,
              COALESCE(SUM(completion_tokens), 0)::text AS total_completion,
              COALESCE(SUM(cost_credits), 0)::text AS total_cost
       FROM inference_log
       WHERE agent_id = $1 AND created_at > NOW() - MAKE_INTERVAL(days => $2::int) AND status = 'success'
       GROUP BY provider, model`,
      [agentId, safeDays],
    );

    const summary: UsageSummary = {
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCostCredits: 0,
      byProvider: {},
      byModel: {},
    };

    for (const row of rows) {
      const reqCount = Number(row.req_count);
      const promptTokens = Number(row.total_prompt);
      const completionTokens = Number(row.total_completion);
      const costCredits = Number(row.total_cost);

      summary.totalRequests += reqCount;
      summary.totalPromptTokens += promptTokens;
      summary.totalCompletionTokens += completionTokens;
      summary.totalCostCredits += costCredits;

      if (!summary.byProvider[row.provider]) {
        summary.byProvider[row.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, costCredits: 0 };
      }
      summary.byProvider[row.provider].requests += reqCount;
      summary.byProvider[row.provider].promptTokens += promptTokens;
      summary.byProvider[row.provider].completionTokens += completionTokens;
      summary.byProvider[row.provider].costCredits += costCredits;

      if (!summary.byModel[row.model]) {
        summary.byModel[row.model] = { requests: 0, promptTokens: 0, completionTokens: 0, costCredits: 0 };
      }
      summary.byModel[row.model].requests += reqCount;
      summary.byModel[row.model].promptTokens += promptTokens;
      summary.byModel[row.model].completionTokens += completionTokens;
      summary.byModel[row.model].costCredits += costCredits;
    }

    return summary;
  }

  /**
   * Calculate cost in credits for a given inference call.
   */
  calculateCost(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const providerPricing = this.config.pricing[provider];
    if (!providerPricing) return 0;

    const modelPricing = providerPricing[model];
    if (!modelPricing) return 0;

    const promptCost = Math.ceil((promptTokens / 1_000_000) * modelPricing.promptPerMToken);
    const completionCost = Math.ceil((completionTokens / 1_000_000) * modelPricing.completionPerMToken);

    return promptCost + completionCost;
  }

  // -------------------------------------------------------
  //  Private helpers
  // -------------------------------------------------------

  private computeStatus(balance: number, lifetimeEarned: number): string {
    if (balance <= 0) return "paused";
    if (lifetimeEarned > 0 && balance <= lifetimeEarned * 0.05) return "low_power";
    return "active";
  }

}
