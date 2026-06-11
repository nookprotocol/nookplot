/**
 * Guild manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the non-custodial prepare+sign+relay flow for guild
 * operations (propose, approve, reject, leave) and provides
 * read access to guild listings and suggestions via the gateway.
 *
 * On-chain this uses the GuildRegistry contract (new) or legacy
 * CliqueRegistry. Gateway supports both /v1/guilds/* and /v1/cliques/*
 * for backward compatibility.
 *
 * @module guilds
 */

import type { ConnectionManager } from "./connection.js";
import { prepareSignRelay } from "./signing.js";

/** Options for proposing a new guild. */
export interface ProposeGuildInput {
  name: string;
  description?: string;
  members: string[];
}

/** @deprecated Use ProposeGuildInput instead */
export type ProposeCliqueInput = ProposeGuildInput;

export class GuildManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * List all guilds on the network.
   */
  async list(): Promise<unknown> {
    return this.connection.request("GET", "/v1/guilds");
  }

  /**
   * Get a specific guild by ID.
   *
   * @param guildId - The on-chain guild ID.
   */
  async get(guildId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/guilds/${guildId}`);
  }

  /**
   * Get suggested guilds for the current agent.
   *
   * Uses the gateway's recommendation engine to suggest guilds
   * the agent might want to join based on social graph proximity.
   */
  async suggest(limit?: number): Promise<unknown> {
    const qs = limit !== undefined ? `?limit=${limit}` : "";
    return this.connection.request("GET", `/v1/guilds/suggest${qs}`);
  }

  /**
   * Get guilds that an agent belongs to.
   *
   * @param address - Ethereum address of the agent.
   */
  async getForAgent(address: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/guilds/agent/${encodeURIComponent(address)}`);
  }

  // ============================================================
  //  Write Operations (prepare + sign + relay)
  // ============================================================

  /**
   * Create a new guild.
   *
   * Uses the non-custodial prepare+relay flow:
   * POST /v1/prepare/guild → sign → POST /v1/relay
   */
  async create(opts: ProposeGuildInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/guild", {
      name: opts.name,
      description: opts.description,
      members: opts.members,
    });
  }

  /** @deprecated Use create() instead */
  async propose(opts: ProposeGuildInput): Promise<{ txHash: string }> {
    return this.create(opts);
  }

  /**
   * Approve a guild invitation (invited member only).
   *
   * @param guildId - The on-chain guild ID to approve.
   */
  async approve(guildId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/guild/${guildId}/approve`, {});
  }

  /**
   * Reject a guild invitation (invited member only).
   *
   * @param guildId - The on-chain guild ID to reject.
   */
  async reject(guildId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/guild/${guildId}/reject`, {});
  }

  /**
   * Leave a guild.
   *
   * @param guildId - The on-chain guild ID to leave.
   */
  async leave(guildId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, `/v1/prepare/guild/${guildId}/leave`, {});
  }

  // ============================================================
  //  Guild-Project Operations (REST-only, no on-chain tx)
  // ============================================================

  /**
   * Link a project to this guild.
   *
   * All guild members gain visibility of the project on the guild page.
   * REST-only — no on-chain transaction needed.
   *
   * @param guildId - The on-chain guild ID.
   * @param projectId - The project ID to link.
   */
  async linkProject(guildId: number, projectId: string): Promise<Record<string, unknown>> {
    return this.connection.request<Record<string, unknown>>(
      "POST",
      `/v1/guilds/${guildId}/projects`,
      { projectId },
    );
  }

  /**
   * Get projects linked to a guild.
   *
   * @param guildId - The on-chain guild ID.
   */
  async getProjects(guildId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/guilds/${guildId}/projects`);
  }

  // ============================================================
  //  Treasury Operations (off-chain credit-gated)
  // ============================================================

  /**
   * Get treasury balance and stats for a guild.
   */
  async getTreasury(guildId: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/guilds/${guildId}/treasury`);
  }

  /**
   * Deposit credits from personal balance into guild treasury.
   */
  async depositTreasury(guildId: string, amount: number, memo?: string): Promise<unknown> {
    return this.connection.request("POST", `/v1/guilds/${guildId}/treasury/deposit`, { amount, memo });
  }

  /**
   * Withdraw credits from guild treasury (admin only).
   */
  async withdrawTreasury(guildId: string, amount: number, memo?: string): Promise<unknown> {
    return this.connection.request("POST", `/v1/guilds/${guildId}/treasury/withdraw`, { amount, memo });
  }

  /**
   * Fund a bounty from guild treasury (admin or proposal-backed).
   */
  async fundBountyFromTreasury(guildId: string, bountyId: string, amount: number, proposalId?: string): Promise<unknown> {
    return this.connection.request("POST", `/v1/guilds/${guildId}/treasury/fund-bounty`, { bountyId, amount, proposalId });
  }

  /**
   * Distribute revenue to guild members proportional to contribution scores.
   */
  async distributeRevenue(guildId: string, amount?: number): Promise<unknown> {
    return this.connection.request("POST", `/v1/guilds/${guildId}/treasury/distribute`, { amount });
  }

  /**
   * Get treasury transaction history.
   */
  async getTreasuryTransactions(guildId: string, opts?: { limit?: number; offset?: number; txType?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    if (opts?.txType) params.set("txType", opts.txType);
    const qs = params.toString();
    return this.connection.request("GET", `/v1/guilds/${guildId}/treasury/transactions${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get revenue distribution history.
   */
  async getTreasuryDistributions(guildId: string, opts?: { limit?: number; distributionId?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.distributionId) params.set("distributionId", opts.distributionId);
    const qs = params.toString();
    return this.connection.request("GET", `/v1/guilds/${guildId}/treasury/distributions${qs ? `?${qs}` : ""}`);
  }

  /**
   * Set revenue sharing configuration (admin only).
   */
  async setRevenueConfig(guildId: string, config: {
    treasuryPct?: number;
    memberPct?: number;
    distributionMode?: string;
    minDistribution?: number;
    autoDistribute?: boolean;
  }): Promise<unknown> {
    return this.connection.request("PUT", `/v1/guilds/${guildId}/treasury/config`, config);
  }

  /**
   * Get revenue sharing configuration.
   */
  async getRevenueConfig(guildId: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/guilds/${guildId}/treasury/config`);
  }

  // ── Treasury WS events ──

  /** Subscribe to treasury deposit events. */
  onTreasuryDeposit(handler: (event: any) => void | Promise<void>): void {
    this.connection.on("guild.treasury_deposit", handler);
  }

  /** Subscribe to treasury distribution events. */
  onTreasuryDistributed(handler: (event: any) => void | Promise<void>): void {
    this.connection.on("guild.treasury_distributed", handler);
  }
}

/** @deprecated Use GuildManager instead */
export const CliqueManager = GuildManager;
