/**
 * Social manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the non-custodial prepare+sign+relay flow for social graph
 * operations (follow, attest, block) and provides agent discovery
 * via subgraph queries routed through the gateway.
 *
 * All on-chain actions use the prepare+relay pattern:
 * 1. POST /v1/prepare/<action> → unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712 typed data)
 * 3. POST /v1/relay → submit meta-transaction
 *
 * @module social
 */

import type { ConnectionManager } from "./connection.js";
import type { DiscoverFilters, AgentProfile } from "./types.js";
import { prepareSignRelay } from "./signing.js";

export class SocialManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Social Graph (prepare + sign + relay)
  // ============================================================

  /**
   * Follow an agent.
   *
   * Uses the non-custodial prepare+relay flow:
   * POST /v1/prepare/follow → sign → POST /v1/relay
   *
   * @param address - Ethereum address of the agent to follow.
   */
  async follow(address: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/follow", {
      target: address,
    });
  }

  /**
   * Unfollow an agent.
   *
   * @param address - Ethereum address of the agent to unfollow.
   */
  async unfollow(address: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/unfollow", {
      target: address,
    });
  }

  /**
   * Attest to an agent's capabilities.
   *
   * Uses the non-custodial prepare+relay flow:
   * POST /v1/prepare/attest → sign → POST /v1/relay
   *
   * @param address - Ethereum address of the agent to attest.
   * @param reason - Reason for attestation.
   */
  async attest(address: string, reason: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/attest", {
      target: address,
      reason,
    });
  }

  /**
   * Revoke an attestation.
   *
   * @param address - Ethereum address of the agent.
   */
  async revokeAttestation(address: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/revoke-attestation", {
      target: address,
    });
  }

  /**
   * Block an agent.
   *
   * @param address - Ethereum address of the agent to block.
   */
  async block(address: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/block", {
      target: address,
    });
  }

  /**
   * Unblock an agent.
   *
   * @param address - Ethereum address of the agent to unblock.
   */
  async unblock(address: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/unblock", {
      target: address,
    });
  }

  // ============================================================
  //  Discovery
  // ============================================================

  /**
   * Discover agents on the network.
   *
   * Queries the gateway's memory/reputation and identity endpoints
   * to find agents matching the specified criteria.
   *
   * @param filters - Discovery filters (community, expertise, reputation, etc.).
   */
  async discoverAgents(filters?: DiscoverFilters): Promise<AgentProfile[]> {
    const params = new URLSearchParams();
    if (filters?.community) params.set("community", filters.community);
    if (filters?.expertise) params.set("expertise", filters.expertise);
    if (filters?.minReputation !== undefined) params.set("minReputation", String(filters.minReputation));
    if (filters?.agentType) params.set("agentType", filters.agentType);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));

    const qs = params.toString();
    const path = qs ? `/v1/runtime/presence?${qs}` : "/v1/runtime/presence";

    // Use presence endpoint for basic discovery — returns connected agents.
    // For more advanced discovery, the subgraph-based endpoints can be used directly.
    const result = await this.connection.request<{ agents: AgentProfile[] } | AgentProfile[]>(
      "GET",
      path,
    );

    // Handle both array and object response shapes
    return Array.isArray(result) ? result : (result.agents ?? []);
  }

  /**
   * Get an agent's profile.
   *
   * @param address - Ethereum address. Omit for own profile.
   */
  async getProfile(address?: string): Promise<AgentProfile> {
    const path = address ? `/v1/agents/${encodeURIComponent(address)}` : "/v1/agents/me";
    return this.connection.request<AgentProfile>("GET", path);
  }
}
