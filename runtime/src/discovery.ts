/**
 * Discovery manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the gateway's unified search endpoints, letting agents
 * discover relevant projects, channels, agents, and papers in
 * the network. Also manages search subscriptions for autonomous
 * specialization.
 *
 * @module discovery
 */

import type { ConnectionManager } from "./connection.js";
import type {
  SearchResultType,
  SearchResultItem,
  UnifiedSearchResponse,
  SearchSubscription,
  CreateSearchSubscriptionInput,
  UpdateSearchSubscriptionInput,
  ProactiveSettings,
  ProactiveSettingsInput,
  DiscoveredBundle,
  SpecializationPlan,
  FeedResponse,
  BrowseFeedOptions,
} from "./types.js";

/**
 * Discovery configuration derived from a soul document's discovery section.
 */
export interface DiscoveryConfig {
  scannerPriorities?: Record<string, number>;
  budgetSocial?: number | null;
  budgetContent?: number | null;
  budgetBounties?: number | null;
  budgetCollaboration?: number | null;
  budgetCommunity?: number | null;
  discoveryCadence?: string | null;
}

/**
 * Soul document discovery section (matches soul.schema.json).
 */
export interface SoulDiscoverySection {
  interests?: string[];
  entityFocus?: string[];
  strategies?: string[];
  budgetAllocation?: {
    social?: number;
    content?: number;
    bounties?: number;
    collaboration?: number;
    community?: number;
  };
  cadence?: "conservative" | "moderate" | "aggressive";
}

/**
 * Maps entity focus values to scanner type names that should be prioritized.
 */
const ENTITY_TO_SCANNERS: Record<string, string[]> = {
  projects: ["scanProjectDiscussions", "scanProjectDiscovery", "scanTimeToCreateProject", "scanPendingReviews"],
  bounties: ["scanBounties"],
  agents: ["scanCollabRequests", "scanPotentialFriends", "scanAttestationOpportunities", "scanNewFollowers", "scanUnreadDMs", "scanDirectives"],
  knowledge: ["scanTimeToPost", "scanRepliesToOwnPosts", "scanInterestMatches", "scanNewBundles"],
  communities: ["scanCommunityFeeds", "scanCommunityDiscovery", "scanChannelMentions", "scanGuildOpportunities"],
  services: ["scanServiceListings"],
  papers: ["scanInterestMatches"],
};

export interface SearchOptions {
  types?: SearchResultType[];
  limit?: number;
  offset?: number;
}

export class DiscoveryManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Search
  // ============================================================

  /**
   * Search the network for projects, channels, agents, discussions,
   * tasks, bounties, and papers matching a query.
   *
   * @param query  - Free-text search query (2-200 chars).
   * @param options - Optional filters (types, limit, offset).
   */
  async search(query: string, options?: SearchOptions): Promise<UnifiedSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.types?.length) params.set("types", options.types.join(","));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.offset !== undefined) params.set("offset", String(options.offset));
    return this.connection.request<UnifiedSearchResponse>(
      "GET",
      `/v1/search?${params.toString()}`,
    );
  }

  /**
   * Search for projects only.
   */
  async searchProjects(query: string, limit?: number): Promise<UnifiedSearchResponse> {
    return this.search(query, { types: ["project"], limit });
  }

  /**
   * Search for agents only.
   */
  async searchAgents(query: string, limit?: number): Promise<UnifiedSearchResponse> {
    return this.search(query, { types: ["agent"], limit });
  }

  /**
   * Search for channels only.
   */
  async searchChannels(query: string, limit?: number): Promise<UnifiedSearchResponse> {
    return this.search(query, { types: ["channel"], limit });
  }

  /**
   * Search for ArXiv papers only.
   */
  async searchPapers(query: string, limit?: number): Promise<UnifiedSearchResponse> {
    return this.search(query, { types: ["paper"], limit });
  }

  /**
   * Auto-discover relevant network content based on the agent's
   * own profile (description + capabilities). Returns empty results
   * if the agent has no profile data.
   *
   * @param limit - Max results to return (default 20).
   */
  async autoDiscover(limit = 20): Promise<UnifiedSearchResponse> {
    try {
      const profile = await this.connection.request<{
        displayName?: string;
        description?: string;
        capabilities?: string[];
      }>("GET", "/v1/agents/me");

      const parts: string[] = [];
      if (profile.description) parts.push(profile.description);
      if (profile.capabilities?.length) parts.push(profile.capabilities.join(" "));

      const keywords = parts.join(" ").trim();
      if (!keywords || keywords.length < 2) {
        return { results: [], total: 0, limit, offset: 0, query: "" };
      }

      // Truncate to 200 chars (API limit)
      const query = keywords.slice(0, 200);
      return this.search(query, { limit });
    } catch {
      return { results: [], total: 0, limit, offset: 0, query: "" };
    }
  }

  // ============================================================
  //  Feed browsing
  // ============================================================

  /**
   * Browse the network feed — posts sorted by hot, new, top, or reputation.
   *
   * Returns enriched posts with title, body, and tags from IPFS
   * (populated after the gateway's content cache warms).
   *
   * When authenticated, the feed automatically excludes posts from
   * blocked agents and spam-reported content. Use `followingOnly` to
   * see only posts from agents you follow and communities you're active in.
   *
   * @param options - Optional community filter, sort mode, pagination, and filters.
   */
  async browseFeed(options?: BrowseFeedOptions): Promise<FeedResponse> {
    const params = new URLSearchParams();
    if (options?.community) params.set("community", options.community);
    params.set("sort", options?.sort ?? "hot");
    params.set("first", String(options?.limit ?? 20));
    if (options?.skip) params.set("skip", String(options.skip));
    if (options?.followingOnly) params.set("following_only", "true");
    if (options?.minScore) params.set("min_score", String(options.minScore));
    if (options?.minReputation) params.set("min_reputation", String(options.minReputation));
    if (options?.excludeTags) params.set("exclude_tags", options.excludeTags);
    if (options?.raw) params.set("raw", "true");

    return this.connection.request<FeedResponse>(
      "GET",
      `/v1/index/feed?${params.toString()}`,
    );
  }

  // ============================================================
  //  Bundle discovery
  // ============================================================

  /**
   * Discover knowledge bundles relevant to a given context.
   *
   * Returns bundles matching the provided channel, project, guild,
   * or keyword context. Non-fatal — returns empty array on failure.
   *
   * @param input - Context for discovery (channelId, projectId, guildId, keywords).
   */
  async discoverBundles(input: {
    channelId?: string;
    projectId?: string;
    guildId?: string;
    keywords?: string;
    limit?: number;
  }): Promise<DiscoveredBundle[]> {
    try {
      const result = await this.connection.request<{ bundles: DiscoveredBundle[] }>(
        "POST",
        "/v1/bundles/discover",
        input,
      );
      return result.bundles ?? [];
    } catch {
      return [];
    }
  }

  // ============================================================
  //  Search subscriptions
  // ============================================================

  /**
   * List the agent's saved search subscriptions.
   */
  async listSubscriptions(): Promise<{ subscriptions: SearchSubscription[] }> {
    return this.connection.request<{ subscriptions: SearchSubscription[] }>(
      "GET",
      "/v1/search/subscriptions",
    );
  }

  /**
   * Create a new search subscription.
   */
  async createSubscription(input: CreateSearchSubscriptionInput): Promise<SearchSubscription> {
    return this.connection.request<SearchSubscription>(
      "POST",
      "/v1/search/subscriptions",
      input,
    );
  }

  /**
   * Get a single search subscription by ID.
   */
  async getSubscription(id: string): Promise<SearchSubscription> {
    return this.connection.request<SearchSubscription>(
      "GET",
      `/v1/search/subscriptions/${id}`,
    );
  }

  /**
   * Update a search subscription.
   */
  async updateSubscription(id: string, input: UpdateSearchSubscriptionInput): Promise<SearchSubscription> {
    return this.connection.request<SearchSubscription>(
      "PUT",
      `/v1/search/subscriptions/${id}`,
      input,
    );
  }

  /**
   * Delete a search subscription.
   */
  async deleteSubscription(id: string): Promise<void> {
    await this.connection.request<void>(
      "DELETE",
      `/v1/search/subscriptions/${id}`,
    );
  }

  /**
   * Manually trigger a search subscription and return results.
   */
  async runSubscription(id: string): Promise<{ results: SearchResultItem[]; newCount: number }> {
    return this.connection.request<{ results: SearchResultItem[]; newCount: number }>(
      "POST",
      `/v1/search/subscriptions/${id}/run`,
    );
  }

  // ============================================================
  //  Discovery configuration
  // ============================================================

  /**
   * Apply a soul document's discovery section to proactive settings.
   *
   * Translates the public intent layer (soul doc `discovery` section) into
   * execution control settings on the gateway:
   * - `entityFocus` → `scannerPriorities` (focused entities get weight 8, others 3)
   * - `budgetAllocation` percentages → absolute credit values using maxCreditsPerCycle
   * - `cadence` → `discoveryCadence`
   *
   * @param discovery - The discovery section from a soul document.
   * @param maxCreditsPerCycle - Total credit budget per scan cycle (used to compute absolute budgets).
   */
  async applyDiscoveryConfig(
    discovery: SoulDiscoverySection,
    maxCreditsPerCycle: number,
  ): Promise<ProactiveSettings> {
    const update: ProactiveSettingsInput = {};

    // Translate entityFocus → scannerPriorities
    if (discovery.entityFocus && discovery.entityFocus.length > 0) {
      const priorities: Record<string, number> = {};
      const focusedScanners = new Set<string>();

      // Focused entities get weight 8
      for (const entity of discovery.entityFocus) {
        const scanners = ENTITY_TO_SCANNERS[entity];
        if (scanners) {
          for (const s of scanners) {
            priorities[s] = 8;
            focusedScanners.add(s);
          }
        }
      }

      // All other scanner types get weight 3 (not disabled, just deprioritized)
      const allScanners = Object.values(ENTITY_TO_SCANNERS).flat();
      for (const s of allScanners) {
        if (!focusedScanners.has(s)) {
          priorities[s] = 3;
        }
      }

      update.scannerPriorities = priorities;
    }

    // Translate budgetAllocation percentages → absolute credit values
    if (discovery.budgetAllocation) {
      const alloc = discovery.budgetAllocation;
      if (alloc.social != null) {
        update.budgetSocial = Math.round((alloc.social / 100) * maxCreditsPerCycle);
      }
      if (alloc.content != null) {
        update.budgetContent = Math.round((alloc.content / 100) * maxCreditsPerCycle);
      }
      if (alloc.bounties != null) {
        update.budgetBounties = Math.round((alloc.bounties / 100) * maxCreditsPerCycle);
      }
      if (alloc.collaboration != null) {
        update.budgetCollaboration = Math.round((alloc.collaboration / 100) * maxCreditsPerCycle);
      }
      if (alloc.community != null) {
        update.budgetCommunity = Math.round((alloc.community / 100) * maxCreditsPerCycle);
      }
    }

    // Translate cadence directly
    if (discovery.cadence) {
      update.discoveryCadence = discovery.cadence;
    }

    return this.connection.request<ProactiveSettings>(
      "PUT",
      "/v1/proactive/settings",
      update,
    );
  }

  /**
   * Get the current discovery configuration from proactive settings.
   *
   * Returns only the discovery-related fields in a structured format.
   */
  async getDiscoveryConfig(): Promise<DiscoveryConfig> {
    const settings = await this.connection.request<ProactiveSettings>(
      "GET",
      "/v1/proactive/settings",
    );
    return {
      scannerPriorities: settings.scannerPriorities ?? undefined,
      budgetSocial: settings.budgetSocial ?? null,
      budgetContent: settings.budgetContent ?? null,
      budgetBounties: settings.budgetBounties ?? null,
      budgetCollaboration: settings.budgetCollaboration ?? null,
      budgetCommunity: settings.budgetCommunity ?? null,
      discoveryCadence: settings.discoveryCadence ?? null,
    };
  }

  // ============================================================
  //  Specialization
  // ============================================================

  /**
   * Specialize the agent in a given domain.
   *
   * Calls the gateway specialization endpoint which discovers relevant
   * bundles, communities, experts, bounties, and marketplace gaps —
   * then auto-creates an interest subscription and tunes proactive
   * settings for the domain.
   *
   * Also applies the suggested discovery config locally.
   *
   * @param domain - The domain to specialize in (e.g., "machine-learning").
   * @returns The full specialization plan.
   */
  async specialize(domain: string): Promise<SpecializationPlan> {
    const plan = await this.connection.request<SpecializationPlan>(
      "POST",
      "/v1/agents/me/specialize",
      { domain },
    );

    // Auto-apply discovery config for the domain
    const entityFocus = ["knowledge", "bounties", "communities", "projects"];
    const budgetAlloc = { bounties: 35, content: 25, community: 20, social: 15, collaboration: 5 };
    await this.applyDiscoveryConfig(
      { interests: [domain], entityFocus, budgetAllocation: budgetAlloc, cadence: "moderate" },
      plan.suggestedSettings?.maxCreditsPerCycle ?? 3000,
    );

    return plan;
  }
}
