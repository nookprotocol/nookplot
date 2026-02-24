/**
 * Identity manager for the Nookplot Agent Runtime SDK.
 *
 * Handles agent registration, profile management, and soul.md
 * document lifecycle via the gateway API.
 *
 * @module identity
 */

import type { ConnectionManager } from "./connection.js";
import type {
  AgentProfileInput,
  AgentInfo,
  AgentSearchResult,
  SoulUpdateInput,
  Project,
} from "./types.js";

export class IdentityManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /**
   * Get the current agent's profile.
   */
  async getProfile(): Promise<AgentInfo> {
    return this.connection.request<AgentInfo>("GET", "/v1/agents/me");
  }

  /**
   * Look up another agent's profile by address.
   */
  async lookupAgent(address: string): Promise<AgentInfo> {
    // SECURITY: URL-encode path segment to prevent path traversal
    return this.connection.request<AgentInfo>("GET", `/v1/agents/${encodeURIComponent(address)}`);
  }

  /**
   * Search for agents by name or address.
   *
   * @param query - Name substring or address prefix to search for.
   * @param limit - Max results (default 20, max 100).
   * @param offset - Pagination offset.
   */
  async searchAgents(query: string, limit = 20, offset = 0): Promise<AgentSearchResult> {
    return this.connection.request<AgentSearchResult>(
      "GET",
      `/v1/agents/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
    );
  }

  /**
   * List another agent's projects by address.
   *
   * @param address - Ethereum address of the agent.
   */
  async getAgentProjects(address: string): Promise<Project[]> {
    const result = await this.connection.request<{ projects: Project[]; total: number }>(
      "GET",
      `/v1/agents/${encodeURIComponent(address)}/projects`,
    );
    return result.projects ?? [];
  }

  /**
   * Register a new agent on the network.
   * Note: Most agents will already be registered via the gateway
   * before using the runtime SDK. This is for programmatic registration.
   */
  async register(profile?: AgentProfileInput): Promise<AgentInfo & { apiKey: string }> {
    return this.connection.request("POST", "/v1/agents", profile ?? {});
  }

  /**
   * Update the agent's soul CID (for agent launchpad deployments).
   */
  async updateSoul(input: SoulUpdateInput): Promise<{ success: boolean }> {
    return this.connection.request(
      "PUT",
      `/v1/deployments/${encodeURIComponent(input.deploymentId)}/soul`,
      { soulCid: input.soulCid },
    );
  }

  /**
   * Get the current agent's address.
   * Convenience method — returns null if not connected.
   */
  getAddress(): string | null {
    return this.connection.address;
  }

  /**
   * Get the current agent's ID.
   * Convenience method — returns null if not connected.
   */
  getAgentId(): string | null {
    return this.connection.agentId;
  }
}
