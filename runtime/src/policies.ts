/**
 * PolicyManager — CRUD + evaluation for composable relay policies.
 *
 * @module policies
 */

import type { ConnectionManager } from "./connection.js";

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
  daysOfWeek: number[];
  startHour: number;
  endHour: number;
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
  approvers: string[];
  requiredApprovals: number;
}

export type PolicyRules =
  | SpendingLimitRules
  | ContractScopeRules
  | ActionScopeRules
  | TimeWindowRules
  | CooldownRules
  | ThresholdApprovalRules;

export interface Policy {
  id: string;
  agentId: string;
  policyType: PolicyType;
  rules: PolicyRules;
  priority: number;
  creatorRole: string;
  creatorId: string | null;
  guildId: string | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyViolation {
  policyId: string;
  policyType: PolicyType;
  message: string;
  details: Record<string, unknown>;
}

export interface EvaluationResult {
  allowed: boolean;
  violations: PolicyViolation[];
  pendingApproval?: string;
}

export interface CreatePolicyInput {
  policyType: PolicyType;
  rules: PolicyRules;
  priority?: number;
  expiresAt?: string;
}

export interface UpdatePolicyInput {
  rules?: PolicyRules;
  priority?: number;
  enabled?: boolean;
  expiresAt?: string | null;
}

export interface EvaluateInput {
  targetContract: string;
  methodSelector: string;
  creditCost?: number;
  calldata?: string;
}

/* ------------------------------------------------------------------ */
/*  PolicyManager                                                      */
/* ------------------------------------------------------------------ */

export class PolicyManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /** Create a policy for the authenticated agent. */
  async create(input: CreatePolicyInput): Promise<Policy> {
    return this.connection.request<Policy>("POST", "/v1/policies", input);
  }

  /** List policies for the authenticated agent. */
  async list(enabledOnly = true): Promise<{ policies: Policy[] }> {
    const qs = enabledOnly ? "" : "?enabledOnly=false";
    return this.connection.request<{ policies: Policy[] }>("GET", `/v1/policies${qs}`);
  }

  /** Get a policy by ID. */
  async get(policyId: string): Promise<Policy> {
    return this.connection.request<Policy>("GET", `/v1/policies/${policyId}`);
  }

  /** Update a policy. */
  async update(policyId: string, input: UpdatePolicyInput): Promise<Policy> {
    return this.connection.request<Policy>("PATCH", `/v1/policies/${policyId}`, input);
  }

  /** Delete a policy. */
  async delete(policyId: string): Promise<{ deleted: boolean }> {
    return this.connection.request<{ deleted: boolean }>("DELETE", `/v1/policies/${policyId}`);
  }

  /** Dry-run policy evaluation. */
  async evaluate(input: EvaluateInput): Promise<EvaluationResult> {
    return this.connection.request<EvaluationResult>("POST", "/v1/policies/evaluate", input);
  }

  /** Get violation history. */
  async violations(opts?: { limit?: number; offset?: number }): Promise<{
    violations: Array<{
      id: string;
      policyId: string;
      policyType: string;
      violationDetails: Record<string, unknown>;
      targetContract: string | null;
      methodSelector: string | null;
      creditCost: number | null;
      createdAt: string;
    }>;
    total: number;
  }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/policies/violations${qs ? `?${qs}` : ""}`);
  }

  /** Approve a threshold approval request. */
  async approveRequest(requestId: string): Promise<{ approved: boolean; status: string }> {
    return this.connection.request<{ approved: boolean; status: string }>(
      "POST", `/v1/policies/approvals/${requestId}/approve`,
    );
  }

  /** Create a guild policy for a member (requires guild admin). */
  async createGuildPolicy(guildId: string, input: CreatePolicyInput & { agentId: string }): Promise<Policy> {
    return this.connection.request<Policy>("POST", `/v1/guilds/${guildId}/policies`, input);
  }

  /** List guild policies. */
  async listGuildPolicies(guildId: string): Promise<{ policies: Policy[] }> {
    return this.connection.request<{ policies: Policy[] }>("GET", `/v1/guilds/${guildId}/policies`);
  }
}
