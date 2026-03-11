/**
 * DelegationService — off-chain delegated access management.
 *
 * Agents can delegate specific actions to other agents with:
 *   - Scoped action lists (allowed method selectors)
 *   - Spending limits (total credits the delegate can consume)
 *   - Expiry dates
 *   - Revocation
 *
 * Delegated relays are validated here, then executed via the
 * normal relay flow with the delegator as the `from` address.
 *
 * @module services/delegationService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

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
  expiresAt: Date | null;
  revoked: boolean;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDelegationParams {
  delegatorId: string;
  delegateId: string;
  allowedActions?: string[];
  spendingLimit?: number;
  label?: string;
  expiresAt?: Date;
}

export interface DelegationValidation {
  valid: boolean;
  error?: string;
  delegation?: Delegation;
}

/* ------------------------------------------------------------------ */
/*  DelegationService                                                  */
/* ------------------------------------------------------------------ */

export class DelegationService {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /* ================================================================ */
  /*  CRUD                                                             */
  /* ================================================================ */

  async create(params: CreateDelegationParams): Promise<Delegation> {
    if (params.delegatorId === params.delegateId) {
      throw new Error("Cannot delegate to self");
    }

    const { rows } = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO delegations (delegator_id, delegate_id, allowed_actions, spending_limit, label, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.delegatorId,
        params.delegateId,
        params.allowedActions ?? [],
        params.spendingLimit ?? null,
        params.label ?? null,
        params.expiresAt ?? null,
      ],
    );

    logSecurityEvent("info", "delegation-created", {
      delegatorId: params.delegatorId,
      delegateId: params.delegateId,
      allowedActions: params.allowedActions?.length ?? 0,
      hasSpendingLimit: params.spendingLimit !== undefined,
    });

    return this.rowToDelegation(rows[0]);
  }

  async get(id: string): Promise<Delegation | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM delegations WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? this.rowToDelegation(rows[0]) : null;
  }

  async list(opts: {
    agentId: string;
    role?: "delegator" | "delegate";
    activeOnly?: boolean;
  }): Promise<Delegation[]> {
    let query: string;
    const params: unknown[] = [opts.agentId];

    if (opts.role === "delegate") {
      query = `SELECT * FROM delegations WHERE delegate_id = $1`;
    } else if (opts.role === "delegator") {
      query = `SELECT * FROM delegations WHERE delegator_id = $1`;
    } else {
      query = `SELECT * FROM delegations WHERE delegator_id = $1 OR delegate_id = $1`;
    }

    if (opts.activeOnly !== false) {
      query += ` AND revoked = FALSE AND (expires_at IS NULL OR expires_at > NOW())`;
    }

    query += ` ORDER BY created_at DESC`;

    const { rows } = await this.pool.query<Record<string, unknown>>(query, params);
    return rows.map((r) => this.rowToDelegation(r));
  }

  async revoke(id: string, revokerId: string): Promise<boolean> {
    const delegation = await this.get(id);
    if (!delegation) return false;

    // Only the delegator can revoke
    if (delegation.delegatorId !== revokerId) {
      throw new Error("Only the delegator can revoke a delegation");
    }

    if (delegation.revoked) {
      throw new Error("Delegation already revoked");
    }

    await this.pool.query(
      `UPDATE delegations SET revoked = TRUE, revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id],
    );

    logSecurityEvent("info", "delegation-revoked", {
      delegationId: id,
      delegatorId: delegation.delegatorId,
      delegateId: delegation.delegateId,
    });

    return true;
  }

  /* ================================================================ */
  /*  Validation                                                       */
  /* ================================================================ */

  async validate(
    delegationId: string,
    delegateId: string,
    methodSelector: string,
    creditCost: number,
  ): Promise<DelegationValidation> {
    const delegation = await this.get(delegationId);

    if (!delegation) {
      return { valid: false, error: "Delegation not found" };
    }

    // Check delegate matches
    if (delegation.delegateId !== delegateId) {
      return { valid: false, error: "Delegate does not match delegation" };
    }

    // Check revocation
    if (delegation.revoked) {
      return { valid: false, error: "Delegation has been revoked" };
    }

    // Check expiry
    if (delegation.expiresAt && delegation.expiresAt < new Date()) {
      return { valid: false, error: "Delegation has expired" };
    }

    // Check action scope (empty = all actions allowed)
    if (delegation.allowedActions.length > 0) {
      const selectorLower = methodSelector.toLowerCase();
      const allowed = delegation.allowedActions.some(
        (a) => a.toLowerCase() === selectorLower,
      );
      if (!allowed) {
        return { valid: false, error: `Action ${methodSelector} not in allowed actions` };
      }
    }

    // Check spending limit
    if (delegation.spendingLimit !== null) {
      const remaining = delegation.spendingLimit - delegation.spent;
      if (creditCost > remaining) {
        return {
          valid: false,
          error: `Spending limit exceeded: cost ${creditCost}, remaining ${remaining}`,
        };
      }
    }

    return { valid: true, delegation };
  }

  /* ================================================================ */
  /*  Spend tracking                                                   */
  /* ================================================================ */

  async recordSpend(delegationId: string, amount: number): Promise<void> {
    await this.pool.query(
      `UPDATE delegations SET spent = spent + $1, updated_at = NOW() WHERE id = $2`,
      [amount, delegationId],
    );
  }

  async logRelay(params: {
    delegationId: string;
    delegateId: string;
    delegatorId: string;
    targetContract: string;
    methodSelector: string;
    creditCost: number;
    txHash?: string;
    status?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO delegation_relay_log
         (delegation_id, delegate_id, delegator_id, target_contract, method_selector, credit_cost, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.delegationId,
        params.delegateId,
        params.delegatorId,
        params.targetContract,
        params.methodSelector,
        params.creditCost,
        params.txHash ?? null,
        params.status ?? "submitted",
      ],
    );
  }

  async getRelayLog(delegationId: string, opts?: { limit?: number }): Promise<Array<{
    id: string;
    delegateId: string;
    delegatorId: string;
    targetContract: string;
    methodSelector: string;
    creditCost: number;
    txHash: string | null;
    status: string;
    createdAt: Date;
  }>> {
    const limit = opts?.limit ?? 50;
    const { rows } = await this.pool.query(
      `SELECT * FROM delegation_relay_log WHERE delegation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [delegationId, limit],
    );

    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      delegateId: r.delegate_id as string,
      delegatorId: r.delegator_id as string,
      targetContract: r.target_contract as string,
      methodSelector: r.method_selector as string,
      creditCost: Number(r.credit_cost),
      txHash: r.tx_hash as string | null,
      status: r.status as string,
      createdAt: r.created_at as Date,
    }));
  }

  /* ================================================================ */
  /*  Helpers                                                          */
  /* ================================================================ */

  private rowToDelegation(row: Record<string, unknown>): Delegation {
    return {
      id: row.id as string,
      delegatorId: row.delegator_id as string,
      delegateId: row.delegate_id as string,
      allowedActions: (row.allowed_actions as string[]) ?? [],
      spendingLimit: row.spending_limit !== null ? Number(row.spending_limit) : null,
      spent: Number(row.spent ?? 0),
      label: row.label as string | null,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      revoked: row.revoked as boolean,
      revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
