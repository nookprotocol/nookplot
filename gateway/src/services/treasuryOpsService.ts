/**
 * TreasuryOpsService — scheduled treasury operations and budget earmarks.
 *
 * Operation types:
 *   auto_sweep         — Sweep excess balance to guild treasury
 *   scheduled_transfer — Transfer credits between agents on schedule
 *   auto_distribute    — Trigger guild revenue distribution on schedule
 *   balance_alert      — Check earmark utilization, send inbox alerts
 *
 * Runs a minutely tick to process
 * operations whose next_run_at has passed.
 *
 * @module services/treasuryOpsService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type OpType = "auto_sweep" | "scheduled_transfer" | "auto_distribute" | "balance_alert";

export interface ScheduleConfig {
  intervalMinutes?: number;
  cronHour?: number;       // 0-23 UTC
  cronDayOfWeek?: number;  // 0=Sun
}

export interface AutoSweepRules {
  threshold: number;       // sweep when balance > threshold
  targetGuildId: string;
  keepAmount: number;      // leave this much after sweep
}

export interface ScheduledTransferRules {
  fromAgentId: string;
  toAgentId: string;
  amount: number;
}

export interface AutoDistributeRules {
  guildId: string;
  mode: "contribution" | "equal";
}

export interface BalanceAlertRules {
  earmarkLabel: string;
  alertThresholdPercent: number; // alert when spent/allocated > this %
}

export type OpRules = AutoSweepRules | ScheduledTransferRules | AutoDistributeRules | BalanceAlertRules;

export interface ScheduledOp {
  id: string;
  agentId: string;
  guildId: string | null;
  opType: OpType;
  schedule: ScheduleConfig;
  rules: OpRules;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetEarmark {
  id: string;
  agentId: string;
  label: string;
  allocated: number;
  spent: number;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TreasuryOpsConfig {
  tickIntervalMs: number;
}

const DEFAULT_CONFIG: TreasuryOpsConfig = {
  tickIntervalMs: 60_000, // 1 minute
};

/* ------------------------------------------------------------------ */
/*  TreasuryOpsService                                                 */
/* ------------------------------------------------------------------ */

export class TreasuryOpsService {
  private readonly pool: pg.Pool;
  private readonly config: TreasuryOpsConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private creditManager: any = null;
  private treasuryService: any = null;
  private inboxService: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool, config?: Partial<TreasuryOpsConfig>) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setCreditManager(cm: any): void { this.creditManager = cm; }
  setTreasuryService(ts: any): void { this.treasuryService = ts; }
  setInboxService(is: any): void { this.inboxService = is; }

  /* ================================================================ */
  /*  Lifecycle                                                        */
  /* ================================================================ */

  start(): void {
    if (this.timer) return;

    this.tick().catch((err) => {
      logSecurityEvent("warn", "treasury-ops-initial-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logSecurityEvent("warn", "treasury-ops-tick-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.tickIntervalMs);

    logSecurityEvent("info", "treasury-ops-service-started", {
      tickIntervalMs: this.config.tickIntervalMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    if (this.processing) return 0;
    this.processing = true;
    let processed = 0;

    try {
      // Find all due operations
      const { rows } = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM scheduled_treasury_ops
         WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW()
         ORDER BY next_run_at ASC
         LIMIT 50`,
      );

      for (const row of rows) {
        const op = this.rowToOp(row);
        try {
          await this.executeOp(op);
          processed++;
        } catch (err) {
          await this.logHistory(op.id, "failed", {}, err instanceof Error ? err.message : String(err));
          logSecurityEvent("warn", "treasury-op-execution-failed", {
            opId: op.id,
            opType: op.opType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logSecurityEvent("warn", "treasury-ops-tick-error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }

    return processed;
  }

  /* ================================================================ */
  /*  Operation execution                                              */
  /* ================================================================ */

  private async executeOp(op: ScheduledOp): Promise<void> {
    switch (op.opType) {
      case "auto_sweep":
        await this.execAutoSweep(op);
        break;
      case "scheduled_transfer":
        await this.execScheduledTransfer(op);
        break;
      case "auto_distribute":
        await this.execAutoDistribute(op);
        break;
      case "balance_alert":
        await this.execBalanceAlert(op);
        break;
    }

    // Update next_run_at and run_count
    const nextRun = this.computeNextRun(op.schedule);
    await this.pool.query(
      `UPDATE scheduled_treasury_ops
       SET last_run_at = NOW(), next_run_at = $1, run_count = run_count + 1, updated_at = NOW()
       WHERE id = $2`,
      [nextRun, op.id],
    );
  }

  private async execAutoSweep(op: ScheduledOp): Promise<void> {
    const rules = op.rules as AutoSweepRules;
    if (!this.creditManager || !this.treasuryService) {
      await this.logHistory(op.id, "skipped", { reason: "missing_dependencies" });
      return;
    }

    // Get agent balance
    const { rows } = await this.pool.query<{ balance_credits: string }>(
      `SELECT balance_credits FROM credit_accounts WHERE agent_id = $1`,
      [op.agentId],
    );
    if (rows.length === 0) {
      await this.logHistory(op.id, "skipped", { reason: "no_credit_account" });
      return;
    }

    const balance = Number(rows[0].balance_credits);
    if (balance <= rules.threshold) {
      await this.logHistory(op.id, "skipped", {
        reason: "below_threshold",
        balance,
        threshold: rules.threshold,
      });
      return;
    }

    const sweepAmount = balance - rules.keepAmount;
    if (sweepAmount <= 0) {
      await this.logHistory(op.id, "skipped", { reason: "nothing_to_sweep" });
      return;
    }

    // Deduct from agent, deposit to guild treasury
    await this.creditManager.deductCredits(op.agentId, sweepAmount, `auto_sweep:${op.id}`, "auto_sweep");
    await this.treasuryService.deposit(op.agentId, rules.targetGuildId, sweepAmount, `Auto-sweep from ${op.agentId}`);

    await this.logHistory(op.id, "success", {
      swept: sweepAmount,
      newBalance: balance - sweepAmount,
      targetGuildId: rules.targetGuildId,
    });
  }

  private async execScheduledTransfer(op: ScheduledOp): Promise<void> {
    const rules = op.rules as ScheduledTransferRules;
    if (!this.creditManager) {
      await this.logHistory(op.id, "skipped", { reason: "missing_credit_manager" });
      return;
    }

    await this.creditManager.deductCredits(rules.fromAgentId, rules.amount, `scheduled_transfer:${op.id}`, "scheduled_transfer");
    await this.creditManager.addCredits(rules.toAgentId, rules.amount, "scheduled_transfer", `scheduled_transfer:${op.id}`);

    await this.logHistory(op.id, "success", {
      from: rules.fromAgentId,
      to: rules.toAgentId,
      amount: rules.amount,
    });
  }

  private async execAutoDistribute(op: ScheduledOp): Promise<void> {
    const rules = op.rules as AutoDistributeRules;
    if (!this.treasuryService) {
      await this.logHistory(op.id, "skipped", { reason: "missing_treasury_service" });
      return;
    }

    // Trigger distribution via TreasuryService
    try {
      await this.treasuryService.distribute(op.agentId, rules.guildId, rules.mode);
      await this.logHistory(op.id, "success", {
        guildId: rules.guildId,
        mode: rules.mode,
      });
    } catch (err) {
      await this.logHistory(op.id, "failed", {
        guildId: rules.guildId,
      }, err instanceof Error ? err.message : String(err));
    }
  }

  private async execBalanceAlert(op: ScheduledOp): Promise<void> {
    const rules = op.rules as BalanceAlertRules;

    const { rows } = await this.pool.query<{ allocated: string; spent: string }>(
      `SELECT allocated, spent FROM budget_earmarks
       WHERE agent_id = $1 AND label = $2`,
      [op.agentId, rules.earmarkLabel],
    );

    if (rows.length === 0) {
      await this.logHistory(op.id, "skipped", { reason: "earmark_not_found" });
      return;
    }

    const allocated = Number(rows[0].allocated);
    const spent = Number(rows[0].spent);
    const utilization = allocated > 0 ? (spent / allocated) * 100 : 0;

    if (utilization >= rules.alertThresholdPercent) {
      // Send inbox alert
      if (this.inboxService) {
        await this.inboxService.send({
          recipientId: op.agentId,
          senderId: null, // system message
          subject: `Budget alert: ${rules.earmarkLabel}`,
          body: `Earmark "${rules.earmarkLabel}" is at ${utilization.toFixed(1)}% utilization (${spent}/${allocated} credits). Threshold: ${rules.alertThresholdPercent}%.`,
          type: "system",
        });
      }

      await this.logHistory(op.id, "success", {
        earmarkLabel: rules.earmarkLabel,
        utilization: utilization.toFixed(1),
        spent,
        allocated,
      });
    } else {
      await this.logHistory(op.id, "skipped", {
        reason: "below_alert_threshold",
        utilization: utilization.toFixed(1),
        threshold: rules.alertThresholdPercent,
      });
    }
  }

  /* ================================================================ */
  /*  Schedule computation                                             */
  /* ================================================================ */

  private computeNextRun(schedule: ScheduleConfig): Date {
    const now = new Date();

    if (schedule.intervalMinutes) {
      return new Date(now.getTime() + schedule.intervalMinutes * 60_000);
    }

    // Cron-like: find next occurrence of cronHour on cronDayOfWeek
    const targetHour = schedule.cronHour ?? 0;
    const targetDay = schedule.cronDayOfWeek;

    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);

    if (targetDay !== undefined) {
      // Weekly: advance to next occurrence of targetDay
      let daysUntil = targetDay - next.getUTCDay();
      if (daysUntil <= 0) daysUntil += 7;
      next.setUTCDate(next.getUTCDate() + daysUntil);
      next.setUTCHours(targetHour);
    } else {
      // Daily: next occurrence of targetHour
      next.setUTCHours(targetHour);
      if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
    }

    return next;
  }

  /* ================================================================ */
  /*  CRUD — Scheduled operations                                      */
  /* ================================================================ */

  async createOp(params: {
    agentId: string;
    guildId?: string;
    opType: OpType;
    schedule: ScheduleConfig;
    rules: OpRules;
  }): Promise<ScheduledOp> {
    const nextRun = this.computeNextRun(params.schedule);

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO scheduled_treasury_ops (agent_id, guild_id, op_type, schedule, rules, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.agentId,
        params.guildId ?? null,
        params.opType,
        JSON.stringify(params.schedule),
        JSON.stringify(params.rules),
        nextRun,
      ],
    );

    logSecurityEvent("info", "treasury-op-created", {
      agentId: params.agentId,
      opType: params.opType,
    });

    return this.rowToOp(rows[0]);
  }

  async getOp(id: string): Promise<ScheduledOp | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM scheduled_treasury_ops WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? this.rowToOp(rows[0]) : null;
  }

  async listOps(agentId: string, opts?: { guildId?: string }): Promise<ScheduledOp[]> {
    let query = `SELECT * FROM scheduled_treasury_ops WHERE agent_id = $1`;
    const params: unknown[] = [agentId];

    if (opts?.guildId) {
      query += ` AND guild_id = $2`;
      params.push(opts.guildId);
    }

    query += ` ORDER BY created_at DESC`;

    const { rows } = await this.pool.query<Record<string, unknown>>(query, params);
    return rows.map((r) => this.rowToOp(r));
  }

  async updateOp(id: string, updates: {
    schedule?: ScheduleConfig;
    rules?: OpRules;
    enabled?: boolean;
  }): Promise<ScheduledOp | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.schedule !== undefined) {
      sets.push(`schedule = $${idx}`);
      params.push(JSON.stringify(updates.schedule));
      idx++;
      // Recompute next_run_at
      sets.push(`next_run_at = $${idx}`);
      params.push(this.computeNextRun(updates.schedule));
      idx++;
    }
    if (updates.rules !== undefined) {
      sets.push(`rules = $${idx}`);
      params.push(JSON.stringify(updates.rules));
      idx++;
    }
    if (updates.enabled !== undefined) {
      sets.push(`enabled = $${idx}`);
      params.push(updates.enabled);
      idx++;
    }

    if (sets.length === 0) return this.getOp(id);

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `UPDATE scheduled_treasury_ops SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params,
    );

    return rows.length > 0 ? this.rowToOp(rows[0]) : null;
  }

  async deleteOp(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM scheduled_treasury_ops WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async runOpNow(id: string): Promise<{ status: string; details: Record<string, unknown> }> {
    const op = await this.getOp(id);
    if (!op) throw new Error("Operation not found");

    try {
      await this.executeOp(op);
      return { status: "success", details: {} };
    } catch (err) {
      return {
        status: "failed",
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async getOpHistory(opId: string, opts?: { limit?: number }): Promise<Array<{
    id: string;
    status: string;
    details: Record<string, unknown>;
    errorMessage: string | null;
    createdAt: Date;
  }>> {
    const limit = opts?.limit ?? 50;
    const { rows } = await this.pool.query(
      `SELECT * FROM treasury_op_history WHERE op_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [opId, limit],
    );

    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      status: r.status as string,
      details: r.details as Record<string, unknown>,
      errorMessage: r.error_message as string | null,
      createdAt: r.created_at as Date,
    }));
  }

  /* ================================================================ */
  /*  CRUD — Budget earmarks                                           */
  /* ================================================================ */

  async createEarmark(params: {
    agentId: string;
    label: string;
    allocated: number;
    description?: string;
  }): Promise<BudgetEarmark> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO budget_earmarks (agent_id, label, allocated, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [params.agentId, params.label, params.allocated, params.description ?? null],
    );

    return this.rowToEarmark(rows[0]);
  }

  async listEarmarks(agentId: string): Promise<BudgetEarmark[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM budget_earmarks WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r) => this.rowToEarmark(r));
  }

  async updateEarmark(id: string, updates: {
    allocated?: number;
    description?: string;
  }): Promise<BudgetEarmark | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.allocated !== undefined) {
      sets.push(`allocated = $${idx}`);
      params.push(updates.allocated);
      idx++;
    }
    if (updates.description !== undefined) {
      sets.push(`description = $${idx}`);
      params.push(updates.description);
      idx++;
    }

    if (sets.length === 0) return null;

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `UPDATE budget_earmarks SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params,
    );

    return rows.length > 0 ? this.rowToEarmark(rows[0]) : null;
  }

  async deleteEarmark(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM budget_earmarks WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordEarmarkSpend(agentId: string, label: string, amount: number): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE budget_earmarks
       SET spent = spent + $1, updated_at = NOW()
       WHERE agent_id = $2 AND label = $3 AND spent + $1 <= allocated`,
      [amount, agentId, label],
    );

    if ((rowCount ?? 0) === 0) {
      throw new Error(`Earmark "${label}" not found or would exceed allocation`);
    }
  }

  /* ================================================================ */
  /*  Helpers                                                          */
  /* ================================================================ */

  private async logHistory(
    opId: string,
    status: string,
    details: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO treasury_op_history (op_id, status, details, error_message)
       VALUES ($1, $2, $3, $4)`,
      [opId, status, JSON.stringify(details), errorMessage ?? null],
    );
  }

  private rowToOp(row: Record<string, unknown>): ScheduledOp {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      guildId: row.guild_id as string | null,
      opType: row.op_type as OpType,
      schedule: row.schedule as ScheduleConfig,
      rules: row.rules as OpRules,
      enabled: row.enabled as boolean,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at as string) : null,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at as string) : null,
      runCount: row.run_count as number,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private rowToEarmark(row: Record<string, unknown>): BudgetEarmark {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      label: row.label as string,
      allocated: Number(row.allocated),
      spent: Number(row.spent),
      description: row.description as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
