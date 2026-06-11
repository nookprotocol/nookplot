/**
 * TreasuryOpsManager — scheduled treasury operations + budget earmarks.
 *
 * @module treasury-ops
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type OpType = "auto_sweep" | "scheduled_transfer" | "auto_distribute" | "balance_alert";

export interface ScheduleConfig {
  intervalMinutes?: number;
  cronHour?: number;
  cronDayOfWeek?: number;
}

export interface ScheduledOp {
  id: string;
  agentId: string;
  guildId: string | null;
  opType: OpType;
  schedule: ScheduleConfig;
  rules: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetEarmark {
  id: string;
  agentId: string;
  label: string;
  allocated: number;
  spent: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOpInput {
  opType: OpType;
  schedule: ScheduleConfig;
  rules: Record<string, unknown>;
  guildId?: string;
}

export interface UpdateOpInput {
  schedule?: ScheduleConfig;
  rules?: Record<string, unknown>;
  enabled?: boolean;
}

export interface CreateEarmarkInput {
  label: string;
  allocated: number;
  description?: string;
}

export interface UpdateEarmarkInput {
  allocated?: number;
  description?: string;
}

export interface OpHistoryEntry {
  id: string;
  status: string;
  details: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  TreasuryOpsManager                                                 */
/* ------------------------------------------------------------------ */

export class TreasuryOpsManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /* ---- Scheduled operations ---- */

  /** Create a scheduled treasury operation. */
  async createOp(input: CreateOpInput): Promise<ScheduledOp> {
    return this.connection.request<ScheduledOp>("POST", "/v1/treasury-ops", input);
  }

  /** List scheduled operations. */
  async listOps(guildId?: string): Promise<{ operations: ScheduledOp[] }> {
    const qs = guildId ? `?guildId=${guildId}` : "";
    return this.connection.request<{ operations: ScheduledOp[] }>("GET", `/v1/treasury-ops${qs}`);
  }

  /** Update a scheduled operation. */
  async updateOp(opId: string, input: UpdateOpInput): Promise<ScheduledOp> {
    return this.connection.request<ScheduledOp>("PATCH", `/v1/treasury-ops/${opId}`, input);
  }

  /** Delete a scheduled operation. */
  async deleteOp(opId: string): Promise<{ deleted: boolean }> {
    return this.connection.request<{ deleted: boolean }>("DELETE", `/v1/treasury-ops/${opId}`);
  }

  /** Manually trigger an operation. */
  async runOp(opId: string): Promise<{ status: string; details: Record<string, unknown> }> {
    return this.connection.request<{ status: string; details: Record<string, unknown> }>(
      "POST", `/v1/treasury-ops/${opId}/run`,
    );
  }

  /** Get execution history for an operation. */
  async getHistory(opId: string, limit?: number): Promise<{ history: OpHistoryEntry[] }> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.connection.request<{ history: OpHistoryEntry[] }>(
      "GET", `/v1/treasury-ops/${opId}/history${qs}`,
    );
  }

  /* ---- Budget earmarks ---- */

  /** Create a budget earmark. */
  async createEarmark(input: CreateEarmarkInput): Promise<BudgetEarmark> {
    return this.connection.request<BudgetEarmark>("POST", "/v1/budgets", input);
  }

  /** List budget earmarks. */
  async listEarmarks(): Promise<{ earmarks: BudgetEarmark[] }> {
    return this.connection.request<{ earmarks: BudgetEarmark[] }>("GET", "/v1/budgets");
  }

  /** Update a budget earmark. */
  async updateEarmark(earmarkId: string, input: UpdateEarmarkInput): Promise<BudgetEarmark> {
    return this.connection.request<BudgetEarmark>("PATCH", `/v1/budgets/${earmarkId}`, input);
  }

  /** Delete a budget earmark. */
  async deleteEarmark(earmarkId: string): Promise<{ deleted: boolean }> {
    return this.connection.request<{ deleted: boolean }>("DELETE", `/v1/budgets/${earmarkId}`);
  }
}
