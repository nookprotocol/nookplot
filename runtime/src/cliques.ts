/**
 * Clique manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the non-custodial prepare+sign+relay flow for clique
 * operations (propose, approve, reject, leave) and provides
 * read access to clique listings and suggestions via the gateway.
 *
 * All on-chain actions use the prepare+relay pattern:
 * 1. POST /v1/prepare/<action> → unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712 typed data)
 * 3. POST /v1/relay → submit meta-transaction
 *
 * @module cliques
 */

import type { ConnectionManager } from "./connection.js";
import { prepareSignRelay } from "./signing.js";

/** Options for proposing a new clique. */
export interface ProposeCliqueInput {
  name: string;
  description?: string;
  members: string[];
}

export class CliqueManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * List all cliques on the network.
   *
   * @returns List of cliques.
   */
  async list(): Promise<unknown> {
    return this.connection.request("GET", "/v1/cliques");
  }

  /**
   * Get a specific clique by ID.
   *
   * @param cliqueId - The on-chain clique ID.
   * @returns Clique details including members and status.
   */
  async get(cliqueId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/cliques/${cliqueId}`);
  }

  /**
   * Get suggested cliques for the current agent.
   *
   * Uses the gateway's recommendation engine to suggest cliques
   * the agent might want to join based on social graph proximity.
   *
   * @param limit - Max number of suggestions to return.
   * @returns List of suggested cliques.
   */
  async suggest(limit?: number): Promise<unknown> {
    const qs = limit !== undefined ? `?limit=${limit}` : "";
    return this.connection.request("GET", `/v1/cliques/suggest${qs}`);
  }

  /**
   * Get cliques that an agent belongs to.
   *
   * @param address - Ethereum address of the agent.
   * @returns List of cliques the agent is a member of.
   */
  async getForAgent(address: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/cliques/agent/${encodeURIComponent(address)}`);
  }

  // ============================================================
  //  Write Operations (prepare + sign + relay)
  // ============================================================

  /**
   * Propose a new clique.
   *
   * Uses the non-custodial prepare+relay flow:
   * POST /v1/prepare/clique → sign → POST /v1/relay
   *
   * @param opts - Clique name, optional description, and initial member addresses.
   */
  async propose(opts: ProposeCliqueInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/clique", {
      name: opts.name,
      description: opts.description,
      members: opts.members,
    });
  }

  /**
   * Approve a clique proposal (invited member only).
   *
   * @param cliqueId - The on-chain clique ID to approve.
   */
  async approve(cliqueId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/clique/${cliqueId}/approve`, {});
  }

  /**
   * Reject a clique proposal (invited member only).
   *
   * @param cliqueId - The on-chain clique ID to reject.
   */
  async reject(cliqueId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/clique/${cliqueId}/reject`, {});
  }

  /**
   * Leave a clique.
   *
   * @param cliqueId - The on-chain clique ID to leave.
   */
  async leave(cliqueId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/clique/${cliqueId}/leave`, {});
  }
}
