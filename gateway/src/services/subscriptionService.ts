/**
 * Subscription management service.
 *
 * Handles monthly subscription plans: Free / Starter / Builder / Pro.
 * Subscriptions are activated via on-chain CreditPurchase contract packs
 * (IDs 3/4/5) and managed by this service.
 *
 * @module services/subscriptionService
 */

import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Plan definitions
// ============================================================

export interface PlanDefinition {
  name: string;
  monthlyCredits: number;
  relayTier: number;
  inferenceTokens: number;
  usdcPrice: number;
  packId: number | null; // On-chain pack ID (null for free)
}

export const PLAN_DEFINITIONS: Record<string, PlanDefinition> = {
  free: {
    name: "Free",
    monthlyCredits: 0,
    relayTier: 1,
    inferenceTokens: 0,
    usdcPrice: 0,
    packId: null,
  },
  starter: {
    name: "Starter",
    monthlyCredits: 15_000,
    relayTier: 2,
    inferenceTokens: 500_000,
    usdcPrice: 5,
    packId: 3,
  },
  builder: {
    name: "Builder",
    monthlyCredits: 100_000,
    relayTier: 2,
    inferenceTokens: 2_000_000,
    usdcPrice: 25,
    packId: 4,
  },
  pro: {
    name: "Pro",
    monthlyCredits: 500_000,
    relayTier: 2,
    inferenceTokens: 10_000_000,
    usdcPrice: 99,
    packId: 5,
  },
};

/** Map pack IDs to plan names for purchase watcher integration. */
export const PACK_ID_TO_PLAN: Record<number, string> = {
  3: "starter",
  4: "builder",
  5: "pro",
};

// ============================================================
//  Types
// ============================================================

export interface SubscriptionStatus {
  plan: string;
  planName: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  monthlyCreditsRemaining: number;
  inferenceTokensRemaining: number;
}

// ============================================================
//  SubscriptionService
// ============================================================

export class SubscriptionService {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;

  constructor(pool: pg.Pool, creditManager: CreditManager) {
    this.pool = pool;
    this.creditManager = creditManager;
  }

  /**
   * Activate a subscription for an agent.
   * Inserts subscription row, sets subscription_plan on credit_accounts,
   * and allocates monthly credits.
   */
  async activate(agentId: string, plan: string, txHash?: string): Promise<SubscriptionStatus> {
    const planDef = PLAN_DEFINITIONS[plan];
    if (!planDef || plan === "free") {
      throw new Error("INVALID_PLAN");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Cancel any existing active subscription
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW()
         WHERE agent_id = $1 AND status = 'active'`,
        [agentId],
      );

      // Insert new subscription
      const { rows } = await client.query<{
        id: string;
        current_period_start: Date;
        current_period_end: Date;
      }>(
        `INSERT INTO subscriptions (agent_id, plan, status, monthly_credits_remaining, inference_tokens_remaining, tx_hash)
         VALUES ($1, $2, 'active', $3, $4, $5)
         RETURNING id, current_period_start, current_period_end`,
        [agentId, plan, planDef.monthlyCredits, planDef.inferenceTokens, txHash ?? null],
      );

      // Update credit_accounts
      await client.query(
        `UPDATE credit_accounts SET subscription_plan = $1, has_purchased = TRUE, updated_at = NOW()
         WHERE agent_id = $2`,
        [plan, agentId],
      );

      await client.query("COMMIT");

      // Allocate monthly credits (outside transaction — addCredits has its own)
      if (planDef.monthlyCredits > 0) {
        await this.creditManager.addCredits(
          agentId,
          planDef.monthlyCredits,
          "subscription_credits",
          `sub-${plan}-${rows[0].id}`,
        );
      }

      logSecurityEvent("info", "subscription-activated", {
        agentId,
        plan,
        monthlyCredits: planDef.monthlyCredits,
        txHash,
      });

      return {
        plan,
        planName: planDef.name,
        status: "active",
        currentPeriodStart: rows[0].current_period_start.toISOString(),
        currentPeriodEnd: rows[0].current_period_end.toISOString(),
        monthlyCreditsRemaining: planDef.monthlyCredits,
        inferenceTokensRemaining: planDef.inferenceTokens,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the current subscription status for an agent.
   */
  async getStatus(agentId: string): Promise<SubscriptionStatus> {
    const { rows } = await this.pool.query<{
      plan: string;
      status: string;
      current_period_start: Date;
      current_period_end: Date;
      monthly_credits_remaining: string;
      inference_tokens_remaining: string;
    }>(
      `SELECT plan, status, current_period_start, current_period_end,
              monthly_credits_remaining, inference_tokens_remaining
       FROM subscriptions
       WHERE agent_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );

    if (rows.length === 0) {
      return {
        plan: "free",
        planName: "Free",
        status: "active",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        monthlyCreditsRemaining: 0,
        inferenceTokensRemaining: 0,
      };
    }

    const row = rows[0];
    const planDef = PLAN_DEFINITIONS[row.plan];

    return {
      plan: row.plan,
      planName: planDef?.name ?? row.plan,
      status: row.status,
      currentPeriodStart: row.current_period_start.toISOString(),
      currentPeriodEnd: row.current_period_end.toISOString(),
      monthlyCreditsRemaining: Number(row.monthly_credits_remaining),
      inferenceTokensRemaining: Number(row.inference_tokens_remaining),
    };
  }

  /**
   * Cancel an active subscription.
   */
  async cancel(agentId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW()
       WHERE agent_id = $1 AND status = 'active'`,
      [agentId],
    );

    if (result.rowCount === 0) {
      throw new Error("NO_ACTIVE_SUBSCRIPTION");
    }

    // Reset subscription plan to free
    await this.pool.query(
      `UPDATE credit_accounts SET subscription_plan = 'free', updated_at = NOW()
       WHERE agent_id = $1`,
      [agentId],
    );

    logSecurityEvent("info", "subscription-cancelled", { agentId });
  }

  /**
   * Check for and expire subscriptions past their period end.
   * Called on a timer (every 5 min).
   */
  async checkExpired(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; agent_id: string; plan: string }>(
      `UPDATE subscriptions
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'active' AND current_period_end < NOW()
       RETURNING id, agent_id, plan`,
    );

    for (const row of rows) {
      // Reset subscription plan to free
      await this.pool.query(
        `UPDATE credit_accounts SET subscription_plan = 'free', updated_at = NOW()
         WHERE agent_id = $1`,
        [row.agent_id],
      );

      logSecurityEvent("info", "subscription-expired", {
        subscriptionId: row.id,
        agentId: row.agent_id,
        plan: row.plan,
      });
    }

    return rows.length;
  }
}
