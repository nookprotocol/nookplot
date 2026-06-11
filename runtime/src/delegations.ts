/**
 * DelegationManager — delegated agent access management.
 *
 * @module delegations
 */

import type { ConnectionManager } from "./connection.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Delegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  allowedActions: string[];
  spendingLimit: number | null;
  spent: number;
  label: string | null;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDelegationInput {
  delegateId: string;
  allowedActions?: string[];
  spendingLimit?: number;
  label?: string;
  expiresAt?: string;
}

export interface DelegatedRelayInput {
  delegationId: string;
  targetContract: string;
  methodSelector: string;
  calldata?: string;
  creditCost?: number;
}

export interface DelegatedRelayResult {
  validated: boolean;
  delegationId: string;
  delegatorId: string;
  delegateId: string;
  remainingSpend: number | null;
}

/* ------------------------------------------------------------------ */
/*  DelegationManager                                                  */
/* ------------------------------------------------------------------ */

export class DelegationManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /** Create a delegation (authenticated agent = delegator). */
  async create(input: CreateDelegationInput): Promise<Delegation> {
    return this.connection.request<Delegation>("POST", "/v1/delegations", input);
  }

  /** List delegations for the authenticated agent. */
  async list(opts?: { role?: "delegator" | "delegate"; activeOnly?: boolean }): Promise<{ delegations: Delegation[] }> {
    const params = new URLSearchParams();
    if (opts?.role) params.set("role", opts.role);
    if (opts?.activeOnly === false) params.set("activeOnly", "false");
    const qs = params.toString();
    return this.connection.request<{ delegations: Delegation[] }>(
      "GET", `/v1/delegations${qs ? `?${qs}` : ""}`,
    );
  }

  /** Get delegation details. */
  async get(delegationId: string): Promise<Delegation> {
    return this.connection.request<Delegation>("GET", `/v1/delegations/${delegationId}`);
  }

  /** Revoke a delegation (only delegator can revoke). */
  async revoke(delegationId: string): Promise<{ revoked: boolean }> {
    return this.connection.request<{ revoked: boolean }>("DELETE", `/v1/delegations/${delegationId}`);
  }

  /** Execute a delegated relay. */
  async relay(input: DelegatedRelayInput): Promise<DelegatedRelayResult> {
    return this.connection.request<DelegatedRelayResult>("POST", "/v1/relay/delegated", input);
  }
}
