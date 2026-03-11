/**
 * PolicyEngine — composable relay policy enforcement.
 *
 * 6 policy types evaluated at relay time:
 *   spending_limit   — Max credits per tx/day/week
 *   contract_scope   — Allow/deny specific contracts
 *   action_scope     — Allow/deny specific method selectors
 *   time_window      — Restrict relays to specific hours/days
 *   cooldown         — Min interval between same-type transactions
 *   threshold_approval — Require N-of-M approval above credit threshold
 *
 * Policies are composable: an agent can have multiple policies from
 * self, guild admin, or protocol admin. ALL must pass for a relay to proceed.
 *
 * @module services/policyEngine
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PolicyType =
  | "spending_limit"
  | "contract_scope"
  | "action_scope"
  | "time_window"
  | "cooldown"
  | "threshold_approval";

export type CreatorRole = "self" | "guild_admin" | "protocol_admin";

export interface SpendingLimitRules {
  maxPerTx?: number;
  maxPerDay?: number;
  maxPerWeek?: number;
}

export interface ContractScopeRules {
  mode: "allow" | "deny";
  contracts: string[];
}

export interface ActionScopeRules {
  mode: "allow" | "deny";
  actions: string[];
}

export interface TimeWindowRule {
  daysOfWeek: number[]; // 0=Sun, 6=Sat
  startHour: number;    // 0-23 UTC
  endHour: number;      // 0-23 UTC
}

export interface TimeWindowRules {
  allowedWindows: TimeWindowRule[];
}

export interface CooldownRules {
  selector: string;
  minIntervalSeconds: number;
}

export interface ThresholdApprovalRules {
  thresholdCredits: number;
  approvers: string[]; // agent IDs
  requiredApprovals: number;
}

export type PolicyRules =
  | SpendingLimitRules
  | ContractScopeRules
  | ActionScopeRules
  | TimeWindowRules
  | CooldownRules
  | ThresholdApprovalRules;

export interface AgentPolicy {
  id: string;
  agentId: string;
  policyType: PolicyType;
  rules: PolicyRules;
  priority: number;
  creatorRole: CreatorRole;
  creatorId: string | null;
  guildId: string | null;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyViolation {
  policyId: string;
  policyType: PolicyType;
  message: string;
  details: Record<string, unknown>;
}

export interface EvaluationContext {
  targetContract: string;
  methodSelector: string;
  creditCost: number;
  calldata?: string;
}

export interface EvaluationResult {
  allowed: boolean;
  violations: PolicyViolation[];
  pendingApproval?: string; // approval request ID if threshold_approval triggered
}

export interface PolicyEngineConfig {
  cacheTtlMs: number;
}

const DEFAULT_CONFIG: PolicyEngineConfig = {
  cacheTtlMs: 60_000,
};

/* ------------------------------------------------------------------ */
/*  Cache entry                                                        */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  policies: AgentPolicy[];
  expiresAt: number;
}

/* ------------------------------------------------------------------ */
/*  PolicyEngine                                                       */
/* ------------------------------------------------------------------ */

export class PolicyEngine {
  private readonly pool: pg.Pool;
  private readonly config: PolicyEngineConfig;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(pool: pg.Pool, config?: Partial<PolicyEngineConfig>) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /* ================================================================ */
  /*  Core evaluation                                                  */
  /* ================================================================ */

  async evaluate(agentId: string, ctx: EvaluationContext): Promise<EvaluationResult> {
    const policies = await this.getActivePolicies(agentId);
    if (policies.length === 0) return { allowed: true, violations: [] };

    const violations: PolicyViolation[] = [];

    for (const policy of policies) {
      const v = await this.evaluatePolicy(policy, agentId, ctx);
      if (v) violations.push(v);
    }

    if (violations.length > 0) {
      // Log violations asynchronously
      this.logViolations(agentId, violations, ctx).catch((err) => {
        logSecurityEvent("error", "policy-violation-log-failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return { allowed: violations.length === 0, violations };
  }

  /* ================================================================ */
  /*  Per-type evaluators                                              */
  /* ================================================================ */

  private async evaluatePolicy(
    policy: AgentPolicy,
    agentId: string,
    ctx: EvaluationContext,
  ): Promise<PolicyViolation | null> {
    switch (policy.policyType) {
      case "spending_limit":
        return this.evalSpendingLimit(policy, agentId, ctx);
      case "contract_scope":
        return this.evalContractScope(policy, ctx);
      case "action_scope":
        return this.evalActionScope(policy, ctx);
      case "time_window":
        return this.evalTimeWindow(policy);
      case "cooldown":
        return this.evalCooldown(policy, agentId, ctx);
      case "threshold_approval":
        return this.evalThresholdApproval(policy, ctx);
      default:
        return null;
    }
  }

  private async evalSpendingLimit(
    policy: AgentPolicy,
    agentId: string,
    ctx: EvaluationContext,
  ): Promise<PolicyViolation | null> {
    const rules = policy.rules as SpendingLimitRules;

    // Per-transaction limit
    if (rules.maxPerTx !== undefined && ctx.creditCost > rules.maxPerTx) {
      return {
        policyId: policy.id,
        policyType: "spending_limit",
        message: `Transaction cost ${ctx.creditCost} exceeds per-tx limit of ${rules.maxPerTx}`,
        details: { limit: "maxPerTx", cost: ctx.creditCost, max: rules.maxPerTx },
      };
    }

    // Daily/weekly limits — check spending tracker
    if (rules.maxPerDay !== undefined || rules.maxPerWeek !== undefined) {
      const tracker = await this.getSpendingTracker(agentId);

      if (rules.maxPerDay !== undefined) {
        const projectedDaily = tracker.dailySpent + ctx.creditCost;
        if (projectedDaily > rules.maxPerDay) {
          return {
            policyId: policy.id,
            policyType: "spending_limit",
            message: `Daily spending would reach ${projectedDaily}, exceeding limit of ${rules.maxPerDay}`,
            details: { limit: "maxPerDay", dailySpent: tracker.dailySpent, cost: ctx.creditCost, max: rules.maxPerDay },
          };
        }
      }

      if (rules.maxPerWeek !== undefined) {
        const projectedWeekly = tracker.weeklySpent + ctx.creditCost;
        if (projectedWeekly > rules.maxPerWeek) {
          return {
            policyId: policy.id,
            policyType: "spending_limit",
            message: `Weekly spending would reach ${projectedWeekly}, exceeding limit of ${rules.maxPerWeek}`,
            details: { limit: "maxPerWeek", weeklySpent: tracker.weeklySpent, cost: ctx.creditCost, max: rules.maxPerWeek },
          };
        }
      }
    }

    return null;
  }

  private evalContractScope(
    policy: AgentPolicy,
    ctx: EvaluationContext,
  ): PolicyViolation | null {
    const rules = policy.rules as ContractScopeRules;
    const target = ctx.targetContract.toLowerCase();
    const contracts = rules.contracts.map((c) => c.toLowerCase());

    if (rules.mode === "allow" && !contracts.includes(target)) {
      return {
        policyId: policy.id,
        policyType: "contract_scope",
        message: `Contract ${ctx.targetContract} not in allowed list`,
        details: { mode: "allow", target: ctx.targetContract },
      };
    }

    if (rules.mode === "deny" && contracts.includes(target)) {
      return {
        policyId: policy.id,
        policyType: "contract_scope",
        message: `Contract ${ctx.targetContract} is in denied list`,
        details: { mode: "deny", target: ctx.targetContract },
      };
    }

    return null;
  }

  private evalActionScope(
    policy: AgentPolicy,
    ctx: EvaluationContext,
  ): PolicyViolation | null {
    const rules = policy.rules as ActionScopeRules;
    const selector = ctx.methodSelector.toLowerCase();
    const actions = rules.actions.map((a) => a.toLowerCase());

    if (rules.mode === "allow" && !actions.includes(selector)) {
      return {
        policyId: policy.id,
        policyType: "action_scope",
        message: `Action ${ctx.methodSelector} not in allowed list`,
        details: { mode: "allow", selector: ctx.methodSelector },
      };
    }

    if (rules.mode === "deny" && actions.includes(selector)) {
      return {
        policyId: policy.id,
        policyType: "action_scope",
        message: `Action ${ctx.methodSelector} is in denied list`,
        details: { mode: "deny", selector: ctx.methodSelector },
      };
    }

    return null;
  }

  private evalTimeWindow(policy: AgentPolicy): PolicyViolation | null {
    const rules = policy.rules as TimeWindowRules;
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const hour = now.getUTCHours();

    const inWindow = rules.allowedWindows.some(
      (w) => w.daysOfWeek.includes(dayOfWeek) && hour >= w.startHour && hour < w.endHour,
    );

    if (!inWindow) {
      return {
        policyId: policy.id,
        policyType: "time_window",
        message: `Current time (day=${dayOfWeek}, hour=${hour} UTC) outside allowed windows`,
        details: { dayOfWeek, hour, windows: rules.allowedWindows },
      };
    }

    return null;
  }

  private async evalCooldown(
    policy: AgentPolicy,
    agentId: string,
    ctx: EvaluationContext,
  ): Promise<PolicyViolation | null> {
    const rules = policy.rules as CooldownRules;
    if (ctx.methodSelector.toLowerCase() !== rules.selector.toLowerCase()) {
      return null; // cooldown only applies to the specific selector
    }

    const { rows } = await this.pool.query<{ last_relay_at: Date }>(
      `SELECT created_at AS last_relay_at FROM policy_violations
       WHERE agent_id = $1 AND policy_type = 'cooldown'
       ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );

    // Also check the relay_log for last successful relay with this selector
    const { rows: relayRows } = await this.pool.query<{ last_relay_at: Date }>(
      `SELECT created_at AS last_relay_at FROM relay_log
       WHERE agent_id = $1 AND method_selector = $2 AND status != 'failed'
       ORDER BY created_at DESC LIMIT 1`,
      [agentId, ctx.methodSelector.toLowerCase()],
    );

    const lastRelay = relayRows[0]?.last_relay_at;
    if (!lastRelay) return null; // no previous relay, no cooldown

    const elapsedSeconds = (Date.now() - lastRelay.getTime()) / 1000;
    if (elapsedSeconds < rules.minIntervalSeconds) {
      return {
        policyId: policy.id,
        policyType: "cooldown",
        message: `Cooldown: ${Math.ceil(rules.minIntervalSeconds - elapsedSeconds)}s remaining for ${rules.selector}`,
        details: {
          selector: rules.selector,
          minIntervalSeconds: rules.minIntervalSeconds,
          elapsedSeconds: Math.floor(elapsedSeconds),
        },
      };
    }

    return null;
  }

  private evalThresholdApproval(
    policy: AgentPolicy,
    ctx: EvaluationContext,
  ): PolicyViolation | null {
    const rules = policy.rules as ThresholdApprovalRules;
    if (ctx.creditCost < rules.thresholdCredits) return null; // below threshold, no approval needed

    return {
      policyId: policy.id,
      policyType: "threshold_approval",
      message: `Transaction cost ${ctx.creditCost} exceeds threshold ${rules.thresholdCredits} — requires ${rules.requiredApprovals} approval(s)`,
      details: {
        thresholdCredits: rules.thresholdCredits,
        requiredApprovals: rules.requiredApprovals,
        cost: ctx.creditCost,
      },
    };
  }

  /* ================================================================ */
  /*  Spending tracker                                                 */
  /* ================================================================ */

  private async getSpendingTracker(agentId: string): Promise<{ dailySpent: number; weeklySpent: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart();

    const { rows } = await this.pool.query<{ daily_spent: string; weekly_spent: string }>(
      `SELECT daily_spent, weekly_spent FROM policy_spending_tracker
       WHERE agent_id = $1 AND date = $2`,
      [agentId, today],
    );

    if (rows.length > 0) {
      return {
        dailySpent: Number(rows[0].daily_spent),
        weeklySpent: Number(rows[0].weekly_spent),
      };
    }

    // No tracker for today — compute weekly from previous days
    const { rows: weekRows } = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(daily_spent), 0)::text AS total
       FROM policy_spending_tracker
       WHERE agent_id = $1 AND date >= $2 AND date < $3`,
      [agentId, weekStart, today],
    );

    return {
      dailySpent: 0,
      weeklySpent: Number(weekRows[0]?.total ?? "0"),
    };
  }

  async recordSpend(agentId: string, amount: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = this.getWeekStart();

    await this.pool.query(
      `INSERT INTO policy_spending_tracker (agent_id, date, daily_spent, weekly_spent, last_relay_at, week_start)
       VALUES ($1, $2, $3, $3, NOW(), $4)
       ON CONFLICT (agent_id, date)
       DO UPDATE SET
         daily_spent = policy_spending_tracker.daily_spent + $3,
         weekly_spent = policy_spending_tracker.weekly_spent + $3,
         last_relay_at = NOW(),
         updated_at = NOW()`,
      [agentId, today, amount, weekStart],
    );
  }

  private getWeekStart(): string {
    const d = new Date();
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday as week start
    const weekStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
    return weekStart.toISOString().slice(0, 10);
  }

  /* ================================================================ */
  /*  CRUD                                                             */
  /* ================================================================ */

  async createPolicy(params: {
    agentId: string;
    policyType: PolicyType;
    rules: PolicyRules;
    priority?: number;
    creatorRole?: CreatorRole;
    creatorId?: string;
    guildId?: string;
    expiresAt?: Date;
  }): Promise<AgentPolicy> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO agent_policies (agent_id, policy_type, rules, priority, creator_role, creator_id, guild_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        params.agentId,
        params.policyType,
        JSON.stringify(params.rules),
        params.priority ?? 0,
        params.creatorRole ?? "self",
        params.creatorId ?? null,
        params.guildId ?? null,
        params.expiresAt ?? null,
      ],
    );

    this.invalidateCache(params.agentId);
    logSecurityEvent("info", "policy-created", {
      agentId: params.agentId,
      policyType: params.policyType,
      creatorRole: params.creatorRole ?? "self",
    });

    return this.rowToPolicy(rows[0]);
  }

  async getPolicy(id: string): Promise<AgentPolicy | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM agent_policies WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? this.rowToPolicy(rows[0]) : null;
  }

  async listPolicies(agentId: string, opts?: { guildId?: string; enabledOnly?: boolean }): Promise<AgentPolicy[]> {
    let query = `SELECT * FROM agent_policies WHERE agent_id = $1`;
    const params: unknown[] = [agentId];
    let idx = 2;

    if (opts?.guildId) {
      query += ` AND guild_id = $${idx}`;
      params.push(opts.guildId);
      idx++;
    }

    if (opts?.enabledOnly !== false) {
      query += ` AND enabled = TRUE`;
    }

    query += ` ORDER BY priority DESC, created_at ASC`;

    const { rows } = await this.pool.query<Record<string, unknown>>(query, params);
    return rows.map((r) => this.rowToPolicy(r));
  }

  async updatePolicy(id: string, updates: {
    rules?: PolicyRules;
    priority?: number;
    enabled?: boolean;
    expiresAt?: Date | null;
  }): Promise<AgentPolicy | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.rules !== undefined) {
      sets.push(`rules = $${idx}`);
      params.push(JSON.stringify(updates.rules));
      idx++;
    }
    if (updates.priority !== undefined) {
      sets.push(`priority = $${idx}`);
      params.push(updates.priority);
      idx++;
    }
    if (updates.enabled !== undefined) {
      sets.push(`enabled = $${idx}`);
      params.push(updates.enabled);
      idx++;
    }
    if (updates.expiresAt !== undefined) {
      sets.push(`expires_at = $${idx}`);
      params.push(updates.expiresAt);
      idx++;
    }

    if (sets.length === 0) return this.getPolicy(id);

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `UPDATE agent_policies SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params,
    );

    if (rows.length === 0) return null;

    const policy = this.rowToPolicy(rows[0]);
    this.invalidateCache(policy.agentId);
    return policy;
  }

  async deletePolicy(id: string): Promise<boolean> {
    const policy = await this.getPolicy(id);
    if (!policy) return false;

    await this.pool.query(`DELETE FROM agent_policies WHERE id = $1`, [id]);
    this.invalidateCache(policy.agentId);

    logSecurityEvent("info", "policy-deleted", {
      agentId: policy.agentId,
      policyType: policy.policyType,
      policyId: id,
    });

    return true;
  }

  /* ================================================================ */
  /*  Violation history                                                */
  /* ================================================================ */

  async getViolations(agentId: string, opts?: { limit?: number; offset?: number }): Promise<{
    violations: Array<{
      id: string;
      agentId: string;
      policyId: string;
      policyType: string;
      violationDetails: Record<string, unknown>;
      targetContract: string | null;
      methodSelector: string | null;
      creditCost: number | null;
      createdAt: Date;
    }>;
    total: number;
  }> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const [dataResult, countResult] = await Promise.all([
      this.pool.query(
        `SELECT * FROM policy_violations WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [agentId, limit, offset],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM policy_violations WHERE agent_id = $1`,
        [agentId],
      ),
    ]);

    return {
      violations: dataResult.rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        agentId: r.agent_id as string,
        policyId: r.policy_id as string,
        policyType: r.policy_type as string,
        violationDetails: r.violation_details as Record<string, unknown>,
        targetContract: r.target_contract as string | null,
        methodSelector: r.method_selector as string | null,
        creditCost: r.credit_cost ? Number(r.credit_cost) : null,
        createdAt: r.created_at as Date,
      })),
      total: Number(countResult.rows[0].count),
    };
  }

  /* ================================================================ */
  /*  Threshold approvals                                              */
  /* ================================================================ */

  async createApprovalRequest(params: {
    agentId: string;
    policyId: string;
    targetContract: string;
    methodSelector: string;
    creditCost: number;
    calldata?: string;
    requiredApprovals: number;
    approvers: string[];
    expiresAt: Date;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO policy_approval_requests
         (agent_id, policy_id, target_contract, method_selector, credit_cost, calldata,
          required_approvals, approvers, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        params.agentId,
        params.policyId,
        params.targetContract,
        params.methodSelector,
        params.creditCost,
        params.calldata ?? null,
        params.requiredApprovals,
        JSON.stringify(params.approvers),
        params.expiresAt,
      ],
    );
    return rows[0].id;
  }

  async approveRequest(requestId: string, approverId: string): Promise<{ approved: boolean; status: string }> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM policy_approval_requests WHERE id = $1 AND status = 'pending'`,
      [requestId],
    );

    if (rows.length === 0) {
      throw new Error("Approval request not found or already resolved");
    }

    const request = rows[0];
    const approvers = (request.approvers as string[]) || [];
    const approvedBy = (request.approved_by as string[]) || [];

    if (!approvers.includes(approverId)) {
      throw new Error("Not an authorized approver");
    }

    if (approvedBy.includes(approverId)) {
      throw new Error("Already approved by this agent");
    }

    const newApprovedBy = [...approvedBy, approverId];
    const newCount = newApprovedBy.length;
    const required = request.required_approvals as number;
    const newStatus = newCount >= required ? "approved" : "pending";

    await this.pool.query(
      `UPDATE policy_approval_requests
       SET approved_by = $1, current_approvals = $2, status = $3
       WHERE id = $4`,
      [JSON.stringify(newApprovedBy), newCount, newStatus, requestId],
    );

    logSecurityEvent("info", "policy-approval-cast", {
      requestId,
      approverId,
      newCount,
      required,
      status: newStatus,
    });

    return { approved: newStatus === "approved", status: newStatus };
  }

  /* ================================================================ */
  /*  Cache                                                            */
  /* ================================================================ */

  private async getActivePolicies(agentId: string): Promise<AgentPolicy[]> {
    const cached = this.cache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.policies;
    }

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM agent_policies
       WHERE agent_id = $1
         AND enabled = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY priority DESC, created_at ASC`,
      [agentId],
    );

    const policies = rows.map((r) => this.rowToPolicy(r));
    this.cache.set(agentId, {
      policies,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });

    return policies;
  }

  invalidateCache(agentId: string): void {
    this.cache.delete(agentId);
  }

  /* ================================================================ */
  /*  Helpers                                                          */
  /* ================================================================ */

  private async logViolations(
    agentId: string,
    violations: PolicyViolation[],
    ctx: EvaluationContext,
  ): Promise<void> {
    for (const v of violations) {
      await this.pool.query(
        `INSERT INTO policy_violations (agent_id, policy_id, policy_type, violation_details, target_contract, method_selector, credit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [agentId, v.policyId, v.policyType, JSON.stringify({ message: v.message, ...v.details }), ctx.targetContract, ctx.methodSelector, ctx.creditCost],
      );
    }

    logSecurityEvent("warn", "policy-violations-detected", {
      agentId,
      count: violations.length,
      types: violations.map((v) => v.policyType),
      targetContract: ctx.targetContract,
      methodSelector: ctx.methodSelector,
    });
  }

  private rowToPolicy(row: Record<string, unknown>): AgentPolicy {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      policyType: row.policy_type as PolicyType,
      rules: row.rules as PolicyRules,
      priority: row.priority as number,
      creatorRole: row.creator_role as CreatorRole,
      creatorId: row.creator_id as string | null,
      guildId: row.guild_id as string | null,
      enabled: row.enabled as boolean,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
