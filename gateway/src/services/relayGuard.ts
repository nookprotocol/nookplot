/**
 * Anti-abuse relay protection service.
 *
 * Layered defenses against relayer wallet drain:
 * 1. Global circuit breaker — hourly/daily gas budget with hard stop
 * 2. Per-agent daily relay cap — 10/200 txs per day by tier
 * 3. Credits for relay — each relay costs 50/25/10 centricredits by tier
 * 4. Progressive tiers — computed from agent state + purchase history
 *
 * @module services/relayGuard
 */

import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface TierConfig {
  cap: number;
  creditCost: number;
  dailyRefill: number;
  maxBalance: number;
  initialCredits: number;
}

export interface RelayGuardConfig {
  hourlyGasBudgetWei: bigint;
  dailyGasBudgetWei: bigint;
  refillIntervalMs: number;
  tiers: [TierConfig, TierConfig, TierConfig]; // [tier0, tier1, tier2]
  /** Optional: agents with sybil suspicion_score above this threshold get downgraded to tier 0. */
  sybilScoreThreshold?: number;
}

export interface RelayLogEntry {
  id: string;
  agentId: string;
  txHash: string | null;
  targetContract: string;
  methodSelector: string;
  creditsCharged: number;
  tier: number;
  status: string;
}

interface AgentForTier {
  id: string;
  did_cid: string | null;
  created_at: Date;
  hasPurchased?: boolean;
}

// ============================================================
//  RelayGuard
// ============================================================

export class RelayGuard {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;
  private readonly config: RelayGuardConfig;

  // In-memory circuit breaker counters (bootstrapped from DB on startup)
  private hourlyGasSpentWei = 0n;
  private dailyGasSpentWei = 0n;
  private hourlyResetAt: number;
  private dailyResetAt: number;
  private circuitBroken = false;
  /** Set to true after initCircuitBreaker() completes. Relays are rejected until ready. */
  private ready = false;

  constructor(pool: pg.Pool, creditManager: CreditManager, config: RelayGuardConfig) {
    this.pool = pool;
    this.creditManager = creditManager;
    this.config = config;

    const now = Date.now();
    this.hourlyResetAt = now + 3_600_000;
    this.dailyResetAt = now + 86_400_000;
  }

  // -------------------------------------------------------
  //  Tier computation
  // -------------------------------------------------------

  /**
   * Compute relay tier for an agent.
   * If sybilScoreThreshold is configured and the agent's suspicion score
   * exceeds it, they are downgraded to tier 0 regardless of purchase status.
   */
  computeTier(agent: AgentForTier): number {
    if (agent.hasPurchased) return 2;
    if (!agent.did_cid) return 0;
    return 1;
  }

  /**
   * Compute tier with optional sybil score check (async — queries DB).
   * Use this instead of computeTier() when sybilScoreThreshold is configured.
   */
  async computeTierWithSybilCheck(agent: AgentForTier): Promise<number> {
    const baseTier = this.computeTier(agent);
    if (!this.config.sybilScoreThreshold) return baseTier;

    try {
      const { rows } = await this.pool.query<{ suspicion_score: number }>(
        `SELECT suspicion_score FROM sybil_scores WHERE agent_id = $1`,
        [agent.id],
      );
      if (rows.length > 0 && rows[0].suspicion_score > this.config.sybilScoreThreshold) {
        logSecurityEvent("warn", "relay-sybil-downgrade", {
          agentId: agent.id,
          originalTier: baseTier,
          suspicionScore: rows[0].suspicion_score,
          threshold: this.config.sybilScoreThreshold,
        });
        return 0; // Downgrade to tier 0
      }
    } catch {
      // Non-fatal — fall through to base tier
    }

    return baseTier;
  }

  getTierConfig(tier: number): TierConfig {
    return this.config.tiers[Math.min(tier, 2)];
  }

  // -------------------------------------------------------
  //  Circuit breaker
  // -------------------------------------------------------

  checkCircuitBreaker(): { ok: boolean; reason?: string } {
    // Block relays until initCircuitBreaker() has loaded counters from DB.
    // Without this, the brief window after restart has zero counters,
    // allowing relays to exceed the true gas budget.
    if (!this.ready) {
      return { ok: false, reason: "Relay service initializing — try again shortly." };
    }

    this.maybeResetCounters();

    if (this.circuitBroken) {
      return { ok: false, reason: "Circuit breaker tripped — relay paused to protect relayer wallet." };
    }

    if (this.hourlyGasSpentWei >= this.config.hourlyGasBudgetWei) {
      this.circuitBroken = true;
      logSecurityEvent("error", "relay-circuit-breaker-tripped", {
        trigger: "hourly",
        spentWei: this.hourlyGasSpentWei.toString(),
        budgetWei: this.config.hourlyGasBudgetWei.toString(),
      });
      return { ok: false, reason: "Hourly gas budget exceeded — relay paused." };
    }

    if (this.dailyGasSpentWei >= this.config.dailyGasBudgetWei) {
      this.circuitBroken = true;
      logSecurityEvent("error", "relay-circuit-breaker-tripped", {
        trigger: "daily",
        spentWei: this.dailyGasSpentWei.toString(),
        budgetWei: this.config.dailyGasBudgetWei.toString(),
      });
      return { ok: false, reason: "Daily gas budget exceeded — relay paused." };
    }

    return { ok: true };
  }

  recordGasSpend(weiAmount: bigint): void {
    this.maybeResetCounters();
    this.hourlyGasSpentWei += weiAmount;
    this.dailyGasSpentWei += weiAmount;
  }

  private maybeResetCounters(): void {
    const now = Date.now();
    if (now >= this.hourlyResetAt) {
      this.hourlyGasSpentWei = 0n;
      this.hourlyResetAt = now + 3_600_000;
      // Hourly reset may un-trip the breaker if daily is still OK
      if (this.circuitBroken && this.dailyGasSpentWei < this.config.dailyGasBudgetWei) {
        this.circuitBroken = false;
        logSecurityEvent("info", "relay-circuit-breaker-reset", { trigger: "hourly" });
      }
    }
    if (now >= this.dailyResetAt) {
      this.dailyGasSpentWei = 0n;
      this.dailyResetAt = now + 86_400_000;
      this.circuitBroken = false;
      logSecurityEvent("info", "relay-circuit-breaker-reset", { trigger: "daily" });
    }
  }

  // -------------------------------------------------------
  //  Per-agent relay cap + credit charge
  // -------------------------------------------------------

  async checkRelayCapAndCharge(
    agent: AgentForTier,
  ): Promise<{ ok: boolean; tier: number; provisionalId?: string; creditsCharged?: number; creditsRemaining?: number; error?: string; statusCode?: number }> {
    const tier = this.computeTier(agent);
    const tierCfg = this.getTierConfig(tier);

    // Atomic cap check: insert a provisional row, then count.
    // If over cap, rollback — prevents TOCTOU race where concurrent
    // requests both pass a SELECT COUNT check before either inserts.
    // The provisional row is promoted to 'submitted' by promoteProvisionalRelay(),
    // or cleaned up by deleteProvisionalRelay() if the relay doesn't proceed.
    let provisionalId: string;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Insert provisional row (will be promoted with real data later, or deleted on early exit)
      const { rows: provisionalRows } = await client.query<{ id: string }>(
        `INSERT INTO relay_log (agent_id, target_contract, method_selector, credits_charged, tier, status)
         VALUES ($1, '', '', 0, $2, 'reserved')
         RETURNING id`,
        [agent.id, tier],
      );
      provisionalId = provisionalRows[0].id;

      // Count including the row we just inserted
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM relay_log
         WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [agent.id],
      );
      const todayCount = Number(countRows[0]?.count ?? "0");

      if (todayCount > tierCfg.cap) {
        await client.query("ROLLBACK");
        logSecurityEvent("warn", "relay-cap-exceeded", {
          agentId: agent.id,
          tier,
          cap: tierCfg.cap,
          todayCount: todayCount - 1, // exclude the provisional row we rolled back
        });
        return {
          ok: false,
          tier,
          error: `Daily relay cap exceeded (${tierCfg.cap}/day for tier ${tier}). Resets in 24h.`,
          statusCode: 429,
        };
      }

      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore rollback error */ }
      throw err;
    } finally {
      client.release();
    }

    // Deduct credits — auto-create account on first relay (handles registration chicken-and-egg)
    let deductResult: { balanceAfter: number } | undefined;
    try {
      deductResult = await this.creditManager.deductCredits(
        agent.id,
        tierCfg.creditCost,
        `relay-${Date.now()}`,
        "relay_spend",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg === "ACCOUNT_NOT_FOUND") {
        // First relay ever — auto-create credit account and retry
        try {
          await this.creditManager.createAccount(agent.id, tierCfg.initialCredits);
          logSecurityEvent("info", "relay-auto-create-credit-account", {
            agentId: agent.id,
            tier,
            initialCredits: tierCfg.initialCredits,
          });
          deductResult = await this.creditManager.deductCredits(
            agent.id,
            tierCfg.creditCost,
            `relay-${Date.now()}`,
            "relay_spend",
          );
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return {
            ok: false,
            tier,
            error: `Failed to charge relay credits: ${retryMsg}`,
            statusCode: 402,
          };
        }
      } else if (msg === "INSUFFICIENT_CREDITS") {
        return {
          ok: false,
          tier,
          error: `Insufficient credits for relay (need ${tierCfg.creditCost}, tier ${tier}). Purchase credits at GET /v1/credits/packs.`,
          statusCode: 402,
        };
      } else if (msg === "DAILY_SPEND_LIMIT") {
        return {
          ok: false,
          tier,
          error: "Daily credit spend limit reached.",
          statusCode: 429,
        };
      } else {
        return {
          ok: false,
          tier,
          error: `Credit deduction failed: ${msg}`,
          statusCode: 500,
        };
      }
    }

    return {
      ok: true,
      tier,
      provisionalId,
      creditsCharged: tierCfg.creditCost,
      creditsRemaining: deductResult?.balanceAfter,
    };
  }

  // -------------------------------------------------------
  //  Relay logging
  // -------------------------------------------------------

  /**
   * @deprecated Use promoteProvisionalRelay() instead. This creates a second row
   * which double-counts against the relay cap.
   */
  async logRelayAttempt(
    agentId: string,
    targetContract: string,
    methodSelector: string,
    creditsCharged: number,
    tier: number,
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO relay_log (agent_id, target_contract, method_selector, credits_charged, tier, status)
       VALUES ($1, $2, $3, $4, $5, 'submitted')
       RETURNING id`,
      [agentId, targetContract, methodSelector, creditsCharged, tier],
    );
    return rows[0].id;
  }

  /**
   * Promote the provisional 'reserved' row to 'submitted' with real relay data.
   * This avoids creating a second row (which was double-counting against the cap).
   */
  async promoteProvisionalRelay(
    provisionalId: string,
    targetContract: string,
    methodSelector: string,
    creditsCharged: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE relay_log
       SET target_contract = $1, method_selector = $2, credits_charged = $3, status = 'submitted'
       WHERE id = $4`,
      [targetContract, methodSelector, creditsCharged, provisionalId],
    );
  }

  /**
   * Delete the provisional 'reserved' row when relay doesn't proceed
   * (e.g., signature verification failed). Without this, the orphaned row
   * counts against the agent's daily cap.
   */
  async deleteProvisionalRelay(provisionalId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM relay_log WHERE id = $1 AND status = 'reserved'`,
      [provisionalId],
    );
  }

  async updateRelayResult(
    logId: string,
    txHash: string,
    gasUsed: bigint,
    gasPriceWei: bigint,
    ethCostWei: bigint,
    status: "mined" | "reverted",
  ): Promise<void> {
    await this.pool.query(
      `UPDATE relay_log
       SET tx_hash = $1, gas_used = $2, gas_price_wei = $3, eth_cost_wei = $4, status = $5
       WHERE id = $6`,
      [txHash, gasUsed.toString(), gasPriceWei.toString(), ethCostWei.toString(), status, logId],
    );
  }

  async markRelayFailed(logId: string): Promise<void> {
    await this.pool.query(
      `UPDATE relay_log SET status = 'failed' WHERE id = $1`,
      [logId],
    );
  }

  /**
   * Refund relay credits when relay fails after credit deduction.
   * Uses addCredits() to atomically restore the balance with an audit trail.
   */
  async refundRelayCredits(agentId: string, amount: number, reason: string): Promise<void> {
    try {
      await this.creditManager.addCredits(
        agentId,
        amount,
        "relay_refund",
        `refund-${reason}-${Date.now()}`,
      );
      logSecurityEvent("info", "relay-credit-refund", {
        agentId,
        amount,
        reason,
      });
    } catch (refundErr) {
      // Critical: refund failed — log for manual resolution
      logSecurityEvent("error", "relay-credit-refund-failed", {
        agentId,
        amount,
        reason,
        error: refundErr instanceof Error ? refundErr.message : String(refundErr),
      });
    }
  }

  // -------------------------------------------------------
  //  Refill job (disabled — no free refills in new economics)
  // -------------------------------------------------------

  /** @deprecated No-op. Daily refills removed in economics overhaul. */
  startRefillJob(): void {}

  /** @deprecated No-op. Daily refills removed in economics overhaul. */
  stopRefillJob(): void {}

  // -------------------------------------------------------
  //  Bootstrap circuit breaker from DB (survives restarts)
  // -------------------------------------------------------

  async initCircuitBreaker(): Promise<void> {
    try {
      // Sum gas costs from the last hour
      const { rows: hourlyRows } = await this.pool.query<{ total_wei: string | null }>(
        `SELECT COALESCE(SUM(eth_cost_wei), 0)::text AS total_wei
         FROM relay_log
         WHERE created_at > NOW() - INTERVAL '1 hour'
           AND eth_cost_wei IS NOT NULL`,
      );
      this.hourlyGasSpentWei = BigInt(hourlyRows[0]?.total_wei ?? "0");

      // Sum gas costs from the last 24 hours
      const { rows: dailyRows } = await this.pool.query<{ total_wei: string | null }>(
        `SELECT COALESCE(SUM(eth_cost_wei), 0)::text AS total_wei
         FROM relay_log
         WHERE created_at > NOW() - INTERVAL '24 hours'
           AND eth_cost_wei IS NOT NULL`,
      );
      this.dailyGasSpentWei = BigInt(dailyRows[0]?.total_wei ?? "0");

      logSecurityEvent("info", "relay-circuit-breaker-initialized", {
        hourlyGasSpentWei: this.hourlyGasSpentWei.toString(),
        dailyGasSpentWei: this.dailyGasSpentWei.toString(),
        hourlyBudgetWei: this.config.hourlyGasBudgetWei.toString(),
        dailyBudgetWei: this.config.dailyGasBudgetWei.toString(),
      });

      // Check if already over budget on startup
      if (
        this.hourlyGasSpentWei >= this.config.hourlyGasBudgetWei ||
        this.dailyGasSpentWei >= this.config.dailyGasBudgetWei
      ) {
        this.circuitBroken = true;
        logSecurityEvent("warn", "relay-circuit-breaker-tripped-on-startup", {
          hourlyGasSpentWei: this.hourlyGasSpentWei.toString(),
          dailyGasSpentWei: this.dailyGasSpentWei.toString(),
        });
      }

      this.ready = true;
    } catch (err) {
      // Non-fatal — mark as ready with zero counters so gateway doesn't
      // stay permanently locked if the DB query fails.
      this.ready = true;
      logSecurityEvent("warn", "relay-circuit-breaker-init-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
