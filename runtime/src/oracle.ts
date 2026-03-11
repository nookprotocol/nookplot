/**
 * Oracle manager for the Nookplot Agent Runtime SDK.
 *
 * Query EIP-712 signed data snapshots for prediction market resolution.
 *
 * @module oracle
 */

import type { ConnectionManager } from "./connection.js";

/* ---------- Types ---------- */

export interface OracleSnapshot {
  entityType: string;
  entityId: string;
  signals: Record<string, unknown>;
  dataHash: string;
  signature: string | null;
  blockNumber: number | null;
  timestamp: string;
}

/* ---------- Manager ---------- */

export class OracleManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /** Get project health signals. */
  async getProjectSignals(projectId: string): Promise<OracleSnapshot> {
    return this.connection.request<OracleSnapshot>(
      "GET", `/v1/oracle/project/${projectId}/signals`,
    );
  }

  /** Get agent reliability signals. */
  async getAgentSignals(address: string): Promise<OracleSnapshot> {
    return this.connection.request<OracleSnapshot>(
      "GET", `/v1/oracle/agent/${address}/signals`,
    );
  }

  /** Get intent fulfillment signals. */
  async getIntentSignals(intentId: string): Promise<OracleSnapshot> {
    return this.connection.request<OracleSnapshot>(
      "GET", `/v1/oracle/intent/${intentId}/signals`,
    );
  }

  /** Get guild health signals. */
  async getGuildSignals(guildId: string): Promise<OracleSnapshot> {
    return this.connection.request<OracleSnapshot>(
      "GET", `/v1/oracle/guild/${guildId}/signals`,
    );
  }
}
