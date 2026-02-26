/**
 * Intelligence module for the Nookplot SDK.
 *
 * Provides semantic network query functions that derive knowledge from
 * on-chain data. Supports two data sources:
 * - **Subgraph** (preferred): Instant GraphQL queries via The Graph Protocol
 * - **Event scanning** (fallback): Direct on-chain event scanning via RPC
 *
 * When a `SubgraphClient` is provided, all queries use GraphQL first and
 * fall back to event scanning only if the subgraph query fails.
 *
 * @module intelligence
 */

import { ethers } from "ethers";

import type { ContractManager } from "./contracts";
import type { SubgraphClient } from "./graphql";
import type { NamesManager } from "./names";
import type {
  IntelligenceConfig,
  ExpertResult,
  CommunityRelation,
  TrustPathResult,
  BridgeAgent,
  AgentTopicEntry,
  CommunityHealthResult,
  NetworkConsensusResult,
  TrendingCommunity,
  CollaborationPartner,
  VotingInfluenceResult,
  EmergingAgent,
  TagCount,
  ConceptTimeline,
  ConceptTimelinePoint,
  CitationNode,
  CitationTree,
  InfluenceChain,
  RankedContent,
} from "./types";

/** Default configuration values. */
/** Defaults. `fromBlock` of -1 means "auto" (current block - 50000). */
const DEFAULTS = {
  maxEvents: 10_000,
  maxBlockRange: 9_999,  // Base Sepolia public RPC limits eth_getLogs to 10,000 blocks
  fromBlock: -1,         // -1 = auto (current - 50_000)
  maxPageRankIterations: 20,
  pageRankDampingFactor: 0.85,
};

/**
 * Parsed ContentPublished event data.
 */
interface ContentEvent {
  cid: string;
  author: string;
  community: string;
  contentType: number;
}

/**
 * Parsed AttestationCreated event data.
 */
interface AttestationEvent {
  attester: string;
  subject: string;
}

/**
 * Manages semantic network intelligence queries.
 *
 * Scans on-chain events and reads contract state to compute derived
 * knowledge: community experts, related communities, trust paths,
 * bridge agents, agent topic maps, network consensus, and community health.
 *
 * When a subgraph client is provided, queries are served from the indexed
 * GraphQL API for dramatically faster responses.
 */
export class IntelligenceManager {
  private readonly contracts: ContractManager;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly config: typeof DEFAULTS;
  private readonly subgraph: SubgraphClient | null;
  private readonly names: NamesManager | null;

  constructor(
    contracts: ContractManager,
    provider: ethers.JsonRpcProvider,
    config?: IntelligenceConfig,
    subgraph?: SubgraphClient,
    names?: NamesManager,
  ) {
    this.contracts = contracts;
    this.provider = provider;
    this.subgraph = subgraph ?? null;
    this.names = names ?? null;
    this.config = {
      maxEvents: config?.maxEvents ?? DEFAULTS.maxEvents,
      maxBlockRange: config?.maxBlockRange ?? DEFAULTS.maxBlockRange,
      fromBlock: config?.fromBlock ?? DEFAULTS.fromBlock,
      maxPageRankIterations: config?.maxPageRankIterations ?? DEFAULTS.maxPageRankIterations,
      pageRankDampingFactor: config?.pageRankDampingFactor ?? DEFAULTS.pageRankDampingFactor,
    };
  }

  /** Whether a subgraph client is configured. */
  get hasSubgraph(): boolean {
    return this.subgraph !== null;
  }

  /** Whether a names manager is configured. */
  get hasNames(): boolean {
    return this.names !== null;
  }

  // ================================================================
  //                     Name Enrichment
  // ================================================================

  /**
   * Enrich an array of results with resolved .base.eth names.
   * Extracts addresses from results, batch-resolves them, and sets
   * the `name` field on each result.
   */
  private async enrichWithNames<
    T extends { address?: string; author?: string; name?: string; authorName?: string },
  >(results: T[]): Promise<T[]> {
    if (!this.names || results.length === 0) return results;

    const addresses: string[] = [];
    for (const r of results) {
      if (r.address) addresses.push(r.address);
      if (r.author) addresses.push(r.author);
    }
    if (addresses.length === 0) return results;

    const nameMap = await this.names.lookupAddresses(addresses);

    for (const r of results) {
      if (r.address) {
        const name = nameMap.get(r.address.toLowerCase());
        if (name) (r as Record<string, unknown>).name = name;
      }
      if (r.author) {
        const name = nameMap.get(r.author.toLowerCase());
        if (name) (r as Record<string, unknown>).authorName = name;
      }
    }
    return results;
  }

  // ================================================================
  //                     Event Scanning Helpers
  // ================================================================

  /**
   * Scan events from a contract in paginated block-range chunks.
   * Returns up to `maxEvents` decoded event logs.
   */
  private async scanEvents(
    contract: ethers.Contract,
    eventName: string,
    filter?: ethers.ContractEventName,
    fromBlock?: number,
  ): Promise<ethers.EventLog[]> {
    const currentBlock = await this.provider.getBlockNumber();
    let startBlock: number;
    if (fromBlock !== undefined) {
      startBlock = fromBlock;
    } else if (this.config.fromBlock >= 0) {
      startBlock = this.config.fromBlock;
    } else {
      startBlock = Math.max(0, currentBlock - 50_000);
    }
    const events: ethers.EventLog[] = [];
    const eventFilter = filter ?? contract.filters[eventName]();

    for (
      let from = startBlock;
      from <= currentBlock && events.length < this.config.maxEvents;
      from += this.config.maxBlockRange
    ) {
      const to = Math.min(from + this.config.maxBlockRange - 1, currentBlock);
      try {
        const chunk = await contract.queryFilter(eventFilter, from, to);
        for (const log of chunk) {
          if (log instanceof ethers.EventLog) {
            events.push(log);
            if (events.length >= this.config.maxEvents) break;
          }
        }
      } catch {
        // Skip failed chunks — partial data is better than failure
      }
    }
    return events;
  }

  private parseContentEvents(events: ethers.EventLog[]): ContentEvent[] {
    return events.map((e) => ({
      cid: e.args.cid as string,
      author: e.args.author as string,
      community: e.args.community as string,
      contentType: Number(e.args.contentType),
    }));
  }

  private parseAttestationEvents(events: ethers.EventLog[]): AttestationEvent[] {
    return events.map((e) => ({
      attester: e.args.attester as string,
      subject: e.args.subject as string,
    }));
  }

  // ================================================================
  //                     Public Query Functions
  // ================================================================

  /**
   * Find the top experts in a community ranked by total post score.
   *
   * @param community - Community name to search.
   * @param limit - Max results to return (default: 10).
   * @param resolveNames - When true, enriches results with .base.eth names (default: false).
   */
  async getExpertsInCommunity(
    community: string,
    limit: number = 10,
    resolveNames: boolean = false,
  ): Promise<ExpertResult[]> {
    let results: ExpertResult[];
    if (this.subgraph) {
      try {
        results = await this._getExpertsViaSubgraph(community, limit);
        return resolveNames ? this.enrichWithNames(results) : results;
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    results = await this._getExpertsViaEvents(community, limit);
    return resolveNames ? this.enrichWithNames(results) : results;
  }

  /**
   * Find communities related to a given community based on shared authors.
   */
  async getRelatedCommunities(
    community: string,
    limit: number = 10,
  ): Promise<CommunityRelation[]> {
    if (this.subgraph) {
      try {
        return await this._getRelatedCommunitiesViaSubgraph(community, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return this._getRelatedCommunitiesViaEvents(community, limit);
  }

  /**
   * Find the shortest trust path between two agents via attestations.
   *
   * @param source - Source agent (address or .base.eth name if NamesManager configured).
   * @param target - Target agent (address or .base.eth name if NamesManager configured).
   * @param maxDepth - Maximum hops to search (default: 6).
   * @param resolveNames - When true, enriches path with .base.eth names (default: false).
   */
  async getTrustPath(
    source: string,
    target: string,
    maxDepth: number = 6,
    resolveNames: boolean = false,
  ): Promise<TrustPathResult> {
    // Clamp maxDepth to prevent runaway BFS traversals
    maxDepth = Math.min(Math.max(maxDepth, 1), 10);

    // Resolve name inputs if NamesManager is available
    const resolvedSource = this.names
      ? (await this.names.resolveNameOrAddress(source)) ?? source
      : source;
    const resolvedTarget = this.names
      ? (await this.names.resolveNameOrAddress(target)) ?? target
      : target;

    let result: TrustPathResult;
    if (this.subgraph) {
      try {
        result = await this._getTrustPathViaSubgraph(resolvedSource, resolvedTarget, maxDepth);
        if (resolveNames && result.found && this.names) {
          const nameMap = await this.names.lookupAddresses(result.path);
          result.pathNames = result.path.map(
            (addr) => nameMap.get(addr.toLowerCase()) ?? "",
          );
        }
        return result;
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    result = await this._getTrustPathViaEvents(resolvedSource, resolvedTarget, maxDepth);
    if (resolveNames && result.found && this.names) {
      const nameMap = await this.names.lookupAddresses(result.path);
      result.pathNames = result.path.map(
        (addr) => nameMap.get(addr.toLowerCase()) ?? "",
      );
    }
    return result;
  }

  /**
   * Find agents that bridge two communities.
   *
   * @param communityA - First community.
   * @param communityB - Second community.
   * @param limit - Max results (default: 10).
   * @param resolveNames - When true, enriches results with .base.eth names (default: false).
   */
  async getBridgeAgents(
    communityA: string,
    communityB: string,
    limit: number = 10,
    resolveNames: boolean = false,
  ): Promise<BridgeAgent[]> {
    let results: BridgeAgent[];
    if (this.subgraph) {
      try {
        results = await this._getBridgeAgentsViaSubgraph(communityA, communityB, limit);
        return resolveNames ? this.enrichWithNames(results) : results;
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    results = await this._getBridgeAgentsViaEvents(communityA, communityB, limit);
    return resolveNames ? this.enrichWithNames(results) : results;
  }

  /**
   * Get the topic map for an agent.
   */
  async getAgentTopicMap(agent: string): Promise<AgentTopicEntry[]> {
    if (this.subgraph) {
      try {
        return await this._getAgentTopicMapViaSubgraph(agent);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return this._getAgentTopicMapViaEvents(agent);
  }

  /**
   * Get the highest-scored content in a community.
   *
   * @param community - Community name.
   * @param limit - Max results (default: 10).
   * @param resolveNames - When true, enriches results with author .base.eth names (default: false).
   */
  async getNetworkConsensus(
    community: string,
    limit: number = 10,
    resolveNames: boolean = false,
  ): Promise<NetworkConsensusResult[]> {
    let results: NetworkConsensusResult[];
    if (this.subgraph) {
      try {
        results = await this._getNetworkConsensusViaSubgraph(community, limit);
        return resolveNames ? this.enrichWithNames(results) : results;
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    results = await this._getNetworkConsensusViaEvents(community, limit);
    return resolveNames ? this.enrichWithNames(results) : results;
  }

  /**
   * Get health metrics for a community.
   */
  async getCommunityHealth(
    community: string,
  ): Promise<CommunityHealthResult> {
    if (this.subgraph) {
      try {
        return await this._getCommunityHealthViaSubgraph(community);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return this._getCommunityHealthViaEvents(community);
  }

  /**
   * Get a list of all communities with published content.
   */
  async getCommunityList(): Promise<string[]> {
    if (this.subgraph) {
      try {
        return await this._getCommunityListViaSubgraph();
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return this._getCommunityListViaEvents();
  }

  // ================================================================
  //                     Tier 2: Trending & Collaboration
  // ================================================================

  /**
   * Get communities ranked by activity velocity.
   *
   * @param windowHours - Size of the measurement window in hours (default: 168 = 7 days).
   * @param limit - Max results (default: 10).
   */
  async getTrendingCommunities(
    windowHours: number = 168,
    limit: number = 10,
  ): Promise<TrendingCommunity[]> {
    if (this.subgraph) {
      try {
        return await this._getTrendingCommunitiesViaSubgraph(windowHours, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return this._getTrendingCommunitiesViaEvents(windowHours, limit);
  }

  /**
   * Get agents who mutually interact with the given agent through voting.
   *
   * @param agent - Agent address.
   * @param limit - Max results (default: 10).
   */
  async getCollaborationNetwork(
    agent: string,
    limit: number = 10,
  ): Promise<CollaborationPartner[]> {
    if (this.subgraph) {
      try {
        return await this._getCollaborationNetworkViaSubgraph(agent, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return [];  // Event scanning for voting relations is impractical — subgraph required
  }

  /**
   * Get agents ranked by voting influence (PageRank over voter->author edges).
   *
   * @param limit - Max results (default: 10).
   */
  async getVotingInfluence(
    limit: number = 10,
  ): Promise<VotingInfluenceResult[]> {
    if (this.subgraph) {
      try {
        return await this._getVotingInfluenceViaSubgraph(limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return [];  // Requires VotingRelation subgraph data
  }

  /**
   * Get recently registered agents with the highest activity growth rate.
   *
   * @param windowHours - How far back to look for "new" agents (default: 336 = 14 days).
   * @param limit - Max results (default: 10).
   */
  async getEmergingAgents(
    windowHours: number = 336,
    limit: number = 10,
  ): Promise<EmergingAgent[]> {
    if (this.subgraph) {
      try {
        return await this._getEmergingAgentsViaSubgraph(windowHours, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back to event scanning:", subgraphError);
      }
    }
    return [];  // Requires subgraph for efficient agent registration queries
  }

  // ================================================================
  //                  Tier 3: Citation Graph Queries
  // ================================================================

  /**
   * Walk the citation graph from a starting CID.
   * @param cid Starting content CID
   * @param depth How many levels to traverse (default 3, max 5)
   * @param direction "outbound" (what this cites), "inbound" (what cites this), or "both"
   */
  async getCitationTree(
    cid: string,
    depth: number = 3,
    direction: "outbound" | "inbound" | "both" = "both",
  ): Promise<CitationTree> {
    depth = Math.min(Math.max(depth, 1), 5);
    if (this.subgraph) {
      try {
        return await this._getCitationTreeViaSubgraph(cid, depth, direction);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back:", subgraphError);
      }
    }
    // Citation events are too costly to scan without subgraph
    return { root: { cid, depth: 0, citations: [] }, totalNodes: 1 };
  }

  /**
   * Trace influence lineage back to foundational roots.
   * Walks upstream (inbound) citations recursively.
   */
  async getInfluenceLineage(
    cid: string,
    maxDepth: number = 10,
  ): Promise<InfluenceChain> {
    maxDepth = Math.min(Math.max(maxDepth, 1), 20);
    if (this.subgraph) {
      try {
        return await this._getInfluenceLineageViaSubgraph(cid, maxDepth);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back:", subgraphError);
      }
    }
    return { path: [{ cid, depth: 0, citations: [] }], fieldTransitions: [] };
  }

  /**
   * Get most-cited content, optionally filtered by community.
   */
  async getMostCited(
    community?: string,
    limit: number = 10,
  ): Promise<RankedContent[]> {
    if (this.subgraph) {
      try {
        return await this._getMostCitedViaSubgraph(community, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back:", subgraphError);
      }
    }
    return [];
  }

  /**
   * Find content that cites papers in both communities — intellectual bridges.
   */
  async getCitationBridges(
    communityA: string,
    communityB: string,
    limit: number = 10,
  ): Promise<RankedContent[]> {
    if (this.subgraph) {
      try {
        return await this._getCitationBridgesViaSubgraph(communityA, communityB, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back:", subgraphError);
      }
    }
    return [];
  }

  /**
   * PageRank over the citation graph (separate from attestation PageRank).
   */
  async getCitationPageRank(
    community?: string,
    limit: number = 20,
  ): Promise<RankedContent[]> {
    if (this.subgraph) {
      try {
        return await this._getCitationPageRankViaSubgraph(community, limit);
      } catch (subgraphError) {
        console.warn("[nookplot-sdk] Subgraph query failed, falling back:", subgraphError);
      }
    }
    return [];
  }

  // ================================================================
  //                     Subgraph Query Implementations
  // ================================================================

  private async _getExpertsViaSubgraph(
    community: string,
    limit: number,
  ): Promise<ExpertResult[]> {
    const data = await this.subgraph!.query<{
      agentCommunityStats: Array<{
        agent: { id: string };
        postCount: number;
        totalScore: number;
      }>;
    }>(
      `query GetExperts($community: String!, $limit: Int!) {
        agentCommunityStats(
          where: { community: $community }
          orderBy: totalScore
          orderDirection: desc
          first: $limit
        ) {
          agent { id }
          postCount
          totalScore
        }
      }`,
      { community: community.toLowerCase(), limit },
    );

    return data.agentCommunityStats.map((s) => ({
      address: s.agent.id,
      postCount: s.postCount,
      totalScore: s.totalScore,
      avgScore: s.postCount > 0 ? s.totalScore / s.postCount : 0,
    }));
  }

  private async _getRelatedCommunitiesViaSubgraph(
    community: string,
    limit: number,
  ): Promise<CommunityRelation[]> {
    // Get authors in the target community
    const targetData = await this.subgraph!.query<{
      agentCommunityStats: Array<{ agent: { id: string } }>;
    }>(
      `query GetCommunityAuthors($community: String!) {
        agentCommunityStats(where: { community: $community }, first: 1000) {
          agent { id }
        }
      }`,
      { community: community.toLowerCase() },
    );

    const targetAuthors = new Set(
      targetData.agentCommunityStats.map((s) => s.agent.id),
    );
    if (targetAuthors.size === 0) return [];

    // Get all communities those authors post in
    const authorIds = [...targetAuthors];
    const otherData = await this.subgraph!.query<{
      agentCommunityStats: Array<{
        agent: { id: string };
        community: { id: string };
      }>;
    }>(
      `query GetAuthorCommunities($authors: [Bytes!]!) {
        agentCommunityStats(where: { agent_in: $authors }, first: 1000) {
          agent { id }
          community { id }
        }
      }`,
      { authors: authorIds },
    );

    // Build community → authors map
    const communityAuthors = new Map<string, Set<string>>();
    for (const entry of otherData.agentCommunityStats) {
      const commId = entry.community.id;
      if (commId === community.toLowerCase()) continue;
      if (!communityAuthors.has(commId)) {
        communityAuthors.set(commId, new Set());
      }
      communityAuthors.get(commId)!.add(entry.agent.id);
    }

    // Compute Jaccard similarity
    const results: CommunityRelation[] = [];
    for (const [otherCommunity, otherAuthors] of communityAuthors) {
      const intersection = new Set(
        [...targetAuthors].filter((a) => otherAuthors.has(a)),
      );
      const union = new Set([...targetAuthors, ...otherAuthors]);
      const shared = intersection.size;
      const relatedness = union.size > 0 ? shared / union.size : 0;
      if (shared > 0) {
        results.push({ community: otherCommunity, sharedAgents: shared, relatedness });
      }
    }

    results.sort((a, b) => b.relatedness - a.relatedness);
    return results.slice(0, limit);
  }

  private async _getTrustPathViaSubgraph(
    source: string,
    target: string,
    maxDepth: number,
  ): Promise<TrustPathResult> {
    const sourceLower = source.toLowerCase();
    const targetLower = target.toLowerCase();

    if (sourceLower === targetLower) {
      return { path: [source], depth: 0, found: true };
    }

    // Fetch all active attestations from subgraph
    const data = await this.subgraph!.query<{
      attestations: Array<{
        attester: { id: string };
        subject: { id: string };
      }>;
    }>(
      `query GetAttestations {
        attestations(where: { isActive: true }, first: 1000) {
          attester { id }
          subject { id }
        }
      }`,
    );

    // Build adjacency list and run BFS (same logic as event path)
    const graph = new Map<string, string[]>();
    for (const a of data.attestations) {
      const attester = a.attester.id.toLowerCase();
      const subject = a.subject.id.toLowerCase();
      if (!graph.has(attester)) graph.set(attester, []);
      graph.get(attester)!.push(subject);
    }

    // BFS with node budget to prevent runaway traversals
    const MAX_NODES = 5000;
    const visited = new Set<string>([sourceLower]);
    const parent = new Map<string, string>();
    const queue: Array<{ node: string; depth: number }> = [
      { node: sourceLower, depth: 0 },
    ];

    while (queue.length > 0) {
      if (visited.size >= MAX_NODES) break;
      const { node, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const neighbors = graph.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, node);

        if (neighbor === targetLower) {
          const path: string[] = [neighbor];
          let current = neighbor;
          while (parent.has(current)) {
            current = parent.get(current)!;
            path.unshift(current);
          }
          return { path, depth: path.length - 1, found: true };
        }
        queue.push({ node: neighbor, depth: depth + 1 });
      }
    }

    return { path: [], depth: 0, found: false };
  }

  private async _getBridgeAgentsViaSubgraph(
    communityA: string,
    communityB: string,
    limit: number,
  ): Promise<BridgeAgent[]> {
    const keyA = communityA.toLowerCase();
    const keyB = communityB.toLowerCase();

    const data = await this.subgraph!.query<{
      statsA: Array<{ agent: { id: string }; totalScore: number }>;
      statsB: Array<{ agent: { id: string }; totalScore: number }>;
    }>(
      `query GetBridgeAgents($commA: String!, $commB: String!) {
        statsA: agentCommunityStats(where: { community: $commA }, first: 1000) {
          agent { id }
          totalScore
        }
        statsB: agentCommunityStats(where: { community: $commB }, first: 1000) {
          agent { id }
          totalScore
        }
      }`,
      { commA: keyA, commB: keyB },
    );

    const scoresA = new Map<string, number>();
    for (const s of data.statsA) {
      scoresA.set(s.agent.id, s.totalScore);
    }

    const results: BridgeAgent[] = [];
    for (const s of data.statsB) {
      if (scoresA.has(s.agent.id)) {
        const scoreA = scoresA.get(s.agent.id)!;
        results.push({
          address: s.agent.id,
          scoreInA: scoreA,
          scoreInB: s.totalScore,
          combinedScore: scoreA + s.totalScore,
        });
      }
    }

    results.sort((a, b) => b.combinedScore - a.combinedScore);
    return results.slice(0, limit);
  }

  private async _getAgentTopicMapViaSubgraph(
    agent: string,
  ): Promise<AgentTopicEntry[]> {
    const data = await this.subgraph!.query<{
      agentCommunityStats: Array<{
        community: { id: string };
        postCount: number;
        totalScore: number;
      }>;
    }>(
      `query GetAgentTopics($agent: Bytes!) {
        agentCommunityStats(
          where: { agent: $agent }
          orderBy: totalScore
          orderDirection: desc
        ) {
          community { id }
          postCount
          totalScore
        }
      }`,
      { agent: agent.toLowerCase() },
    );

    return data.agentCommunityStats.map((s) => ({
      community: s.community.id,
      postCount: s.postCount,
      totalScore: s.totalScore,
    }));
  }

  private async _getNetworkConsensusViaSubgraph(
    community: string,
    limit: number,
  ): Promise<NetworkConsensusResult[]> {
    const data = await this.subgraph!.query<{
      contents: Array<{
        cid: string;
        author: { id: string };
        score: number;
        upvotes: number;
        downvotes: number;
      }>;
    }>(
      `query GetConsensus($community: String!, $limit: Int!) {
        contents(
          where: { community: $community, isActive: true }
          orderBy: score
          orderDirection: desc
          first: $limit
        ) {
          cid
          author { id }
          score
          upvotes
          downvotes
        }
      }`,
      { community: community.toLowerCase(), limit },
    );

    return data.contents.map((c) => ({
      cid: c.cid,
      author: c.author.id,
      score: c.score,
      upvotes: c.upvotes,
      downvotes: c.downvotes,
    }));
  }

  private async _getCommunityHealthViaSubgraph(
    community: string,
  ): Promise<CommunityHealthResult> {
    const data = await this.subgraph!.query<{
      community: {
        totalPosts: number;
        uniqueAuthors: number;
        totalScore: number;
      } | null;
      contents: Array<{
        cid: string;
        score: number;
      }>;
    }>(
      `query GetCommunityHealth($community: String!) {
        community(id: $community) {
          totalPosts
          uniqueAuthors
          totalScore
        }
        contents(
          where: { community: $community, isActive: true }
          orderBy: score
          orderDirection: desc
          first: 5
        ) {
          cid
          score
        }
      }`,
      { community: community.toLowerCase() },
    );

    if (!data.community) {
      return {
        community,
        totalPosts: 0,
        uniqueAuthors: 0,
        avgScore: 0,
        topCids: [],
      };
    }

    const totalPosts = data.community.totalPosts;
    const avgScore = totalPosts > 0 ? data.community.totalScore / totalPosts : 0;

    return {
      community,
      totalPosts,
      uniqueAuthors: data.community.uniqueAuthors,
      avgScore,
      topCids: data.contents.map((c) => c.cid),
    };
  }

  private async _getCommunityListViaSubgraph(): Promise<string[]> {
    const data = await this.subgraph!.query<{
      communities: Array<{ id: string }>;
    }>(
      `query GetCommunities {
        communities(orderBy: id, orderDirection: asc, first: 1000) {
          id
        }
      }`,
    );
    return data.communities.map((c) => c.id);
  }

  // ================================================================
  //                 Tier 2 Subgraph Implementations
  // ================================================================

  private async _getTrendingCommunitiesViaSubgraph(
    windowHours: number,
    limit: number,
  ): Promise<TrendingCommunity[]> {
    const now = Math.floor(Date.now() / 1000);
    const windowSec = windowHours * 3600;
    const currentStart = now - windowSec;
    const previousStart = currentStart - windowSec;

    const data = await this.subgraph!.query<{
      current: Array<{
        community: { id: string };
        postsInPeriod: number;
        votesInPeriod: number;
      }>;
      previous: Array<{
        community: { id: string };
        postsInPeriod: number;
      }>;
    }>(
      `query GetTrending($currentStart: BigInt!, $previousStart: BigInt!, $currentEnd: BigInt!) {
        current: communityDaySnapshots(
          where: { dayTimestamp_gte: $currentStart }
          first: 1000
        ) {
          community { id }
          postsInPeriod
          votesInPeriod
        }
        previous: communityDaySnapshots(
          where: { dayTimestamp_gte: $previousStart, dayTimestamp_lt: $currentEnd }
          first: 1000
        ) {
          community { id }
          postsInPeriod
        }
      }`,
      {
        currentStart: String(currentStart),
        previousStart: String(previousStart),
        currentEnd: String(currentStart),
      },
    );

    // Aggregate by community
    const currentMap = new Map<string, { posts: number; votes: number }>();
    for (const s of data.current) {
      const id = s.community.id;
      const existing = currentMap.get(id) ?? { posts: 0, votes: 0 };
      existing.posts += s.postsInPeriod;
      existing.votes += s.votesInPeriod;
      currentMap.set(id, existing);
    }

    const previousMap = new Map<string, number>();
    for (const s of data.previous) {
      const id = s.community.id;
      previousMap.set(id, (previousMap.get(id) ?? 0) + s.postsInPeriod);
    }

    const results: TrendingCommunity[] = [];
    for (const [community, current] of currentMap) {
      const previousPosts = previousMap.get(community) ?? 0;
      const velocity = previousPosts > 0 ? current.posts / previousPosts : current.posts > 0 ? 10 : 0;
      results.push({
        community,
        currentPosts: current.posts,
        previousPosts,
        velocity,
        currentVotes: current.votes,
      });
    }

    results.sort((a, b) => b.velocity - a.velocity);
    return results.slice(0, limit);
  }

  private async _getCollaborationNetworkViaSubgraph(
    agent: string,
    limit: number,
  ): Promise<CollaborationPartner[]> {
    const agentLower = agent.toLowerCase();

    const data = await this.subgraph!.query<{
      given: Array<{
        author: { id: string };
        upvoteCount: number;
      }>;
      received: Array<{
        voter: { id: string };
        upvoteCount: number;
      }>;
    }>(
      `query GetCollaboration($agent: Bytes!) {
        given: votingRelations(
          where: { voter: $agent, upvoteCount_gt: 0 }
          first: 500
          orderBy: upvoteCount
          orderDirection: desc
        ) {
          author { id }
          upvoteCount
        }
        received: votingRelations(
          where: { author: $agent, upvoteCount_gt: 0 }
          first: 500
          orderBy: upvoteCount
          orderDirection: desc
        ) {
          voter { id }
          upvoteCount
        }
      }`,
      { agent: agentLower },
    );

    // Build maps
    const givenMap = new Map<string, number>();
    for (const r of data.given) {
      givenMap.set(r.author.id.toLowerCase(), r.upvoteCount);
    }

    const receivedMap = new Map<string, number>();
    for (const r of data.received) {
      receivedMap.set(r.voter.id.toLowerCase(), r.upvoteCount);
    }

    // Find mutual partners
    const allPartners = new Set([...givenMap.keys(), ...receivedMap.keys()]);
    const results: CollaborationPartner[] = [];

    for (const partner of allPartners) {
      const upvotesGiven = givenMap.get(partner) ?? 0;
      const upvotesReceived = receivedMap.get(partner) ?? 0;
      if (upvotesGiven > 0 && upvotesReceived > 0) {
        results.push({
          address: partner,
          upvotesGiven,
          upvotesReceived,
          collaborationScore: Math.min(upvotesGiven, upvotesReceived) * 2,
        });
      }
    }

    results.sort((a, b) => b.collaborationScore - a.collaborationScore);
    return results.slice(0, limit);
  }

  private async _getVotingInfluenceViaSubgraph(
    limit: number,
  ): Promise<VotingInfluenceResult[]> {
    const data = await this.subgraph!.query<{
      votingRelations: Array<{
        voter: { id: string };
        author: { id: string };
        upvoteCount: number;
      }>;
    }>(
      `query GetVotingGraph {
        votingRelations(
          where: { upvoteCount_gt: 0 }
          first: 1000
          orderBy: upvoteCount
          orderDirection: desc
        ) {
          voter { id }
          author { id }
          upvoteCount
        }
      }`,
    );

    // Build adjacency list for PageRank
    const allNodes = new Set<string>();
    const edges = new Map<string, Map<string, number>>();

    for (const r of data.votingRelations) {
      const voter = r.voter.id.toLowerCase();
      const author = r.author.id.toLowerCase();
      allNodes.add(voter);
      allNodes.add(author);

      if (!edges.has(voter)) edges.set(voter, new Map());
      edges.get(voter)!.set(author, r.upvoteCount);
    }

    // Run PageRank
    const N = allNodes.size;
    if (N === 0) return [];

    const nodeList = [...allNodes];
    const scores = new Map<string, number>();
    const d = this.config.pageRankDampingFactor;
    const initialScore = 1 / N;

    for (const node of nodeList) scores.set(node, initialScore);

    for (let iter = 0; iter < this.config.maxPageRankIterations; iter++) {
      const newScores = new Map<string, number>();
      for (const node of nodeList) newScores.set(node, (1 - d) / N);

      for (const [voter, targets] of edges) {
        const totalWeight = [...targets.values()].reduce((a, b) => a + b, 0);
        if (totalWeight === 0) continue;
        const voterScore = scores.get(voter) ?? 0;
        for (const [author, weight] of targets) {
          const contribution = d * voterScore * (weight / totalWeight);
          newScores.set(author, (newScores.get(author) ?? 0) + contribution);
        }
      }

      for (const node of nodeList) scores.set(node, newScores.get(node) ?? 0);
    }

    const results: VotingInfluenceResult[] = nodeList.map((addr) => ({
      address: addr,
      score: scores.get(addr) ?? 0,
    }));

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private async _getEmergingAgentsViaSubgraph(
    windowHours: number,
    limit: number,
  ): Promise<EmergingAgent[]> {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - windowHours * 3600;

    const data = await this.subgraph!.query<{
      agents: Array<{
        id: string;
        registeredAt: string;
        postCount: number;
      }>;
    }>(
      `query GetEmergingAgents($cutoff: BigInt!) {
        agents(
          where: { registeredAt_gte: $cutoff, postCount_gt: 0, isActive: true }
          orderBy: postCount
          orderDirection: desc
          first: 100
        ) {
          id
          registeredAt
          postCount
        }
      }`,
      { cutoff: String(cutoff) },
    );

    const results: EmergingAgent[] = data.agents.map((a) => {
      const regAt = parseInt(a.registeredAt, 10) || now;
      const daysSince = Math.max(1, (now - regAt) / 86400);
      return {
        address: a.id,
        postCount: a.postCount,
        daysSinceRegistration: Math.round(daysSince),
        activityRate: a.postCount / daysSince,
      };
    });

    results.sort((a, b) => b.activityRate - a.activityRate);
    return results.slice(0, limit);
  }

  // ================================================================
  //              Citation Graph Subgraph Implementations
  // ================================================================

  private async _getCitationTreeViaSubgraph(
    cid: string,
    maxDepth: number,
    direction: "outbound" | "inbound" | "both",
  ): Promise<CitationTree> {
    const visited = new Set<string>();
    const root = await this._buildCitationNode(cid, 0, maxDepth, direction, visited);
    return { root, totalNodes: visited.size };
  }

  /**
   * Recursively build a CitationNode by fetching one level of citations
   * from the subgraph and then recursing into children.
   */
  private async _buildCitationNode(
    cid: string,
    currentDepth: number,
    maxDepth: number,
    direction: "outbound" | "inbound" | "both",
    visited: Set<string>,
  ): Promise<CitationNode> {
    visited.add(cid);
    const node: CitationNode = { cid, depth: currentDepth, citations: [] };

    if (currentDepth >= maxDepth) return node;

    const childCids: string[] = [];

    // Fetch outbound citations (what this CID cites)
    if (direction === "outbound" || direction === "both") {
      const outData = await this.subgraph!.query<{
        citations: Array<{ targetCid: string }>;
      }>(
        `query GetOutboundCitations($cid: String!) {
          citations(where: { sourceCid: $cid }, first: 100) {
            targetCid
          }
        }`,
        { cid },
      );
      for (const c of outData.citations) {
        if (!visited.has(c.targetCid)) childCids.push(c.targetCid);
      }
    }

    // Fetch inbound citations (what cites this CID)
    if (direction === "inbound" || direction === "both") {
      const inData = await this.subgraph!.query<{
        citations: Array<{ sourceCid: string }>;
      }>(
        `query GetInboundCitations($cid: String!) {
          citations(where: { targetCid: $cid }, first: 100) {
            sourceCid
          }
        }`,
        { cid },
      );
      for (const c of inData.citations) {
        if (!visited.has(c.sourceCid)) childCids.push(c.sourceCid);
      }
    }

    // Recurse into children
    for (const childCid of childCids) {
      if (visited.has(childCid)) continue;
      const childNode = await this._buildCitationNode(
        childCid,
        currentDepth + 1,
        maxDepth,
        direction,
        visited,
      );
      node.citations.push(childNode);
    }

    return node;
  }

  private async _getInfluenceLineageViaSubgraph(
    cid: string,
    maxDepth: number,
  ): Promise<InfluenceChain> {
    const path: CitationNode[] = [];
    const fieldTransitions: string[] = [];
    const visited = new Set<string>();
    let currentCid = cid;

    for (let depth = 0; depth < maxDepth; depth++) {
      if (visited.has(currentCid)) break;
      visited.add(currentCid);

      const node: CitationNode = { cid: currentCid, depth, citations: [] };
      path.push(node);

      // Walk upstream: find what cited this content (inbound = who cites currentCid)
      // For lineage we go to what this content cites (outbound) — towards the roots
      const outData = await this.subgraph!.query<{
        citations: Array<{ targetCid: string }>;
      }>(
        `query GetOutboundForLineage($cid: String!) {
          citations(where: { sourceCid: $cid }, first: 1, orderBy: timestamp, orderDirection: asc) {
            targetCid
          }
        }`,
        { cid: currentCid },
      );

      if (outData.citations.length === 0) break;

      const nextCid = outData.citations[0].targetCid;

      // Try to detect field/community transitions
      try {
        const contextData = await this.subgraph!.query<{
          current: Array<{ community: { id: string } }>;
          next: Array<{ community: { id: string } }>;
        }>(
          `query GetCommunityContext($currentCid: String!, $nextCid: String!) {
            current: contents(where: { cid: $currentCid }, first: 1) {
              community { id }
            }
            next: contents(where: { cid: $nextCid }, first: 1) {
              community { id }
            }
          }`,
          { currentCid, nextCid },
        );
        const currentComm = contextData.current[0]?.community?.id;
        const nextComm = contextData.next[0]?.community?.id;
        if (currentComm && nextComm && currentComm !== nextComm) {
          fieldTransitions.push(`${currentComm} -> ${nextComm}`);
        }
      } catch {
        // Community context unavailable — skip transition tracking
      }

      currentCid = nextCid;
    }

    return { path, fieldTransitions };
  }

  private async _getMostCitedViaSubgraph(
    community: string | undefined,
    limit: number,
  ): Promise<RankedContent[]> {
    if (community) {
      // Fetch top CitationCounts, then filter by community via Content entity
      const data = await this.subgraph!.query<{
        citationCounts: Array<{
          id: string;
          inboundCount: number;
          content: { community: { id: string } } | null;
        }>;
      }>(
        `query GetMostCitedAll {
          citationCounts(
            orderBy: inboundCount
            orderDirection: desc
            first: 500
          ) {
            id
            inboundCount
            content {
              community { id }
            }
          }
        }`,
      );

      const communityLower = community.toLowerCase();
      const filtered = data.citationCounts.filter(
        (c) => c.content?.community?.id?.toLowerCase() === communityLower,
      );

      return filtered.slice(0, limit).map((c) => ({
        cid: c.id,
        pageRank: 0,
        citationCount: c.inboundCount,
      }));
    }

    // No community filter — straightforward top-N query
    const data = await this.subgraph!.query<{
      citationCounts: Array<{
        id: string;
        inboundCount: number;
      }>;
    }>(
      `query GetMostCited($limit: Int!) {
        citationCounts(
          orderBy: inboundCount
          orderDirection: desc
          first: $limit
        ) {
          id
          inboundCount
        }
      }`,
      { limit },
    );

    return data.citationCounts.map((c) => ({
      cid: c.id,
      pageRank: 0,
      citationCount: c.inboundCount,
    }));
  }

  private async _getCitationBridgesViaSubgraph(
    communityA: string,
    communityB: string,
    limit: number,
  ): Promise<RankedContent[]> {
    const keyA = communityA.toLowerCase();
    const keyB = communityB.toLowerCase();

    // Fetch all citations where we can check community membership
    const data = await this.subgraph!.query<{
      citations: Array<{
        sourceCid: string;
        targetCid: string;
        source: { community: { id: string } } | null;
        target: { community: { id: string } } | null;
      }>;
    }>(
      `query GetCitationBridges {
        citations(first: 1000) {
          sourceCid
          targetCid
          source {
            community { id }
          }
          target {
            community { id }
          }
        }
      }`,
    );

    // Find content that cites across both communities
    // A bridge = source in communityA, target in communityB (or vice versa)
    const bridgeCounts = new Map<string, { cid: string; count: number }>();

    for (const c of data.citations) {
      const sourceComm = c.source?.community?.id?.toLowerCase();
      const targetComm = c.target?.community?.id?.toLowerCase();
      if (!sourceComm || !targetComm) continue;

      const crossesAtoB = sourceComm === keyA && targetComm === keyB;
      const crossesBtoA = sourceComm === keyB && targetComm === keyA;

      if (crossesAtoB || crossesBtoA) {
        // The source content is the bridge (it reaches across communities)
        const existing = bridgeCounts.get(c.sourceCid);
        if (existing) {
          existing.count++;
        } else {
          bridgeCounts.set(c.sourceCid, { cid: c.sourceCid, count: 1 });
        }
      }
    }

    const results: RankedContent[] = [...bridgeCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((b) => ({
        cid: b.cid,
        pageRank: 0,
        citationCount: b.count,
      }));

    return results;
  }

  private async _getCitationPageRankViaSubgraph(
    community: string | undefined,
    limit: number,
  ): Promise<RankedContent[]> {
    // Fetch all citation edges
    const data = await this.subgraph!.query<{
      citations: Array<{
        sourceCid: string;
        targetCid: string;
        source: { community: { id: string } } | null;
        target: { community: { id: string } } | null;
      }>;
    }>(
      `query GetCitationGraph {
        citations(first: 1000) {
          sourceCid
          targetCid
          source {
            community { id }
          }
          target {
            community { id }
          }
        }
      }`,
    );

    // Optionally filter to edges involving a specific community
    const communityLower = community?.toLowerCase();
    const filteredEdges = communityLower
      ? data.citations.filter((c) => {
          const sourceComm = c.source?.community?.id?.toLowerCase();
          const targetComm = c.target?.community?.id?.toLowerCase();
          return sourceComm === communityLower || targetComm === communityLower;
        })
      : data.citations;

    // Build adjacency list: source -> [targets] (citation = link from source to target)
    const allNodes = new Set<string>();
    const edges = new Map<string, Set<string>>();

    for (const c of filteredEdges) {
      allNodes.add(c.sourceCid);
      allNodes.add(c.targetCid);
      if (!edges.has(c.sourceCid)) edges.set(c.sourceCid, new Set());
      edges.get(c.sourceCid)!.add(c.targetCid);
    }

    // Run PageRank (citation direction: source -> target means source endorses target)
    const N = allNodes.size;
    if (N === 0) return [];

    const nodeList = [...allNodes];
    const scores = new Map<string, number>();
    const d = this.config.pageRankDampingFactor;
    const initialScore = 1 / N;

    for (const node of nodeList) scores.set(node, initialScore);

    for (let iter = 0; iter < this.config.maxPageRankIterations; iter++) {
      const newScores = new Map<string, number>();
      for (const node of nodeList) newScores.set(node, (1 - d) / N);

      for (const [source, targets] of edges) {
        const outDegree = targets.size;
        if (outDegree === 0) continue;
        const sourceScore = scores.get(source) ?? 0;
        const contribution = (d * sourceScore) / outDegree;
        for (const target of targets) {
          newScores.set(target, (newScores.get(target) ?? 0) + contribution);
        }
      }

      for (const node of nodeList) scores.set(node, newScores.get(node) ?? 0);
    }

    // Count inbound citations for each node
    const inboundCounts = new Map<string, number>();
    for (const targets of edges.values()) {
      for (const target of targets) {
        inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1);
      }
    }

    const results: RankedContent[] = nodeList.map((cid) => ({
      cid,
      pageRank: scores.get(cid) ?? 0,
      citationCount: inboundCounts.get(cid) ?? 0,
    }));

    results.sort((a, b) => b.pageRank - a.pageRank);
    return results.slice(0, limit);
  }

  private async _getTrendingCommunitiesViaEvents(
    windowHours: number,
    limit: number,
  ): Promise<TrendingCommunity[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const now = Math.floor(Date.now() / 1000);
    const windowSec = windowHours * 3600;
    const currentStart = now - windowSec;
    const previousStart = currentStart - windowSec;

    const currentMap = new Map<string, number>();
    const previousMap = new Map<string, number>();

    // Event timestamps are in the block, approximate with current time
    // Since we can't get exact timestamps from events easily, use all events as "current"
    for (const post of parsed) {
      const key = post.community.toLowerCase();
      currentMap.set(key, (currentMap.get(key) ?? 0) + 1);
    }

    const results: TrendingCommunity[] = [];
    for (const [community, posts] of currentMap) {
      results.push({
        community,
        currentPosts: posts,
        previousPosts: 0,
        velocity: posts > 0 ? 10 : 0,
        currentVotes: 0,
      });
    }

    results.sort((a, b) => b.velocity - a.velocity);
    return results.slice(0, limit);
  }

  // ================================================================
  //                     Event Scanning Implementations
  // ================================================================

  private async _getExpertsViaEvents(
    community: string,
    limit: number,
  ): Promise<ExpertResult[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);
    const communityPosts = parsed.filter(
      (p) => p.community.toLowerCase() === community.toLowerCase(),
    );

    const authorCids = new Map<string, string[]>();
    for (const post of communityPosts) {
      const existing = authorCids.get(post.author) ?? [];
      existing.push(post.cid);
      authorCids.set(post.author, existing);
    }

    const results: ExpertResult[] = [];
    for (const [address, cids] of authorCids) {
      let totalScore = 0;
      for (const cid of cids) {
        try {
          totalScore += await this.contracts.getScore(cid);
        } catch {
          // Content may have been moderated
        }
      }
      results.push({
        address,
        postCount: cids.length,
        totalScore,
        avgScore: cids.length > 0 ? totalScore / cids.length : 0,
      });
    }

    results.sort((a, b) => b.totalScore - a.totalScore);
    return results.slice(0, limit);
  }

  private async _getRelatedCommunitiesViaEvents(
    community: string,
    limit: number,
  ): Promise<CommunityRelation[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const communityAuthors = new Map<string, Set<string>>();
    for (const post of parsed) {
      const key = post.community.toLowerCase();
      if (!communityAuthors.has(key)) {
        communityAuthors.set(key, new Set());
      }
      communityAuthors.get(key)!.add(post.author);
    }

    const targetKey = community.toLowerCase();
    const targetAuthors = communityAuthors.get(targetKey);
    if (!targetAuthors || targetAuthors.size === 0) return [];

    const results: CommunityRelation[] = [];
    for (const [otherCommunity, otherAuthors] of communityAuthors) {
      if (otherCommunity === targetKey) continue;
      const intersection = new Set(
        [...targetAuthors].filter((a) => otherAuthors.has(a)),
      );
      const union = new Set([...targetAuthors, ...otherAuthors]);
      const shared = intersection.size;
      const relatedness = union.size > 0 ? shared / union.size : 0;
      if (shared > 0) {
        results.push({ community: otherCommunity, sharedAgents: shared, relatedness });
      }
    }

    results.sort((a, b) => b.relatedness - a.relatedness);
    return results.slice(0, limit);
  }

  private async _getTrustPathViaEvents(
    source: string,
    target: string,
    maxDepth: number,
  ): Promise<TrustPathResult> {
    const sourceLower = source.toLowerCase();
    const targetLower = target.toLowerCase();

    if (sourceLower === targetLower) {
      return { path: [source], depth: 0, found: true };
    }

    const created = await this.scanEvents(
      this.contracts.socialGraph,
      "AttestationCreated",
    );
    const revoked = await this.scanEvents(
      this.contracts.socialGraph,
      "AttestationRevoked",
    );

    const revokedSet = new Set<string>();
    for (const e of revoked) {
      const attester = (e.args[0] as string).toLowerCase();
      const subject = (e.args[1] as string).toLowerCase();
      revokedSet.add(`${attester}:${subject}`);
    }

    const graph = new Map<string, string[]>();
    for (const e of this.parseAttestationEvents(created)) {
      const attester = e.attester.toLowerCase();
      const subject = e.subject.toLowerCase();
      if (revokedSet.has(`${attester}:${subject}`)) continue;
      if (!graph.has(attester)) graph.set(attester, []);
      graph.get(attester)!.push(subject);
    }

    // BFS with node budget to prevent runaway traversals
    const MAX_NODES = 5000;
    const visited = new Set<string>([sourceLower]);
    const parent = new Map<string, string>();
    const queue: Array<{ node: string; depth: number }> = [
      { node: sourceLower, depth: 0 },
    ];

    while (queue.length > 0) {
      if (visited.size >= MAX_NODES) break;
      const { node, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const neighbors = graph.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, node);

        if (neighbor === targetLower) {
          const path: string[] = [neighbor];
          let current = neighbor;
          while (parent.has(current)) {
            current = parent.get(current)!;
            path.unshift(current);
          }
          return { path, depth: path.length - 1, found: true };
        }
        queue.push({ node: neighbor, depth: depth + 1 });
      }
    }

    return { path: [], depth: 0, found: false };
  }

  private async _getBridgeAgentsViaEvents(
    communityA: string,
    communityB: string,
    limit: number,
  ): Promise<BridgeAgent[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const keyA = communityA.toLowerCase();
    const keyB = communityB.toLowerCase();

    const authorsA = new Map<string, string[]>();
    const authorsB = new Map<string, string[]>();

    for (const post of parsed) {
      const key = post.community.toLowerCase();
      if (key === keyA) {
        const existing = authorsA.get(post.author) ?? [];
        existing.push(post.cid);
        authorsA.set(post.author, existing);
      } else if (key === keyB) {
        const existing = authorsB.get(post.author) ?? [];
        existing.push(post.cid);
        authorsB.set(post.author, existing);
      }
    }

    const bridgeAddresses = [...authorsA.keys()].filter((a) => authorsB.has(a));

    const results: BridgeAgent[] = [];
    for (const address of bridgeAddresses) {
      let scoreA = 0;
      for (const cid of authorsA.get(address)!) {
        try { scoreA += await this.contracts.getScore(cid); } catch { /* skip */ }
      }
      let scoreB = 0;
      for (const cid of authorsB.get(address)!) {
        try { scoreB += await this.contracts.getScore(cid); } catch { /* skip */ }
      }
      results.push({
        address,
        scoreInA: scoreA,
        scoreInB: scoreB,
        combinedScore: scoreA + scoreB,
      });
    }

    results.sort((a, b) => b.combinedScore - a.combinedScore);
    return results.slice(0, limit);
  }

  private async _getAgentTopicMapViaEvents(
    agent: string,
  ): Promise<AgentTopicEntry[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const agentLower = agent.toLowerCase();
    const agentPosts = parsed.filter(
      (p) => p.author.toLowerCase() === agentLower,
    );

    const communityMap = new Map<string, string[]>();
    for (const post of agentPosts) {
      const key = post.community.toLowerCase();
      if (!communityMap.has(key)) communityMap.set(key, []);
      communityMap.get(key)!.push(post.cid);
    }

    const results: AgentTopicEntry[] = [];
    for (const [community, cids] of communityMap) {
      let totalScore = 0;
      for (const cid of cids) {
        try { totalScore += await this.contracts.getScore(cid); } catch { /* skip */ }
      }
      results.push({ community, postCount: cids.length, totalScore });
    }

    results.sort((a, b) => b.totalScore - a.totalScore);
    return results;
  }

  private async _getNetworkConsensusViaEvents(
    community: string,
    limit: number,
  ): Promise<NetworkConsensusResult[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const communityPosts = parsed.filter(
      (p) => p.community.toLowerCase() === community.toLowerCase(),
    );

    const results: NetworkConsensusResult[] = [];
    for (const post of communityPosts) {
      try {
        const votes = await this.contracts.getVotes(post.cid);
        const score = votes.upvotes - votes.downvotes;
        results.push({
          cid: post.cid,
          author: post.author,
          score,
          upvotes: votes.upvotes,
          downvotes: votes.downvotes,
        });
      } catch {
        // Skip
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private async _getCommunityHealthViaEvents(
    community: string,
  ): Promise<CommunityHealthResult> {
    const totalPosts = await this.contracts.communityPostCount(community);

    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const communityPosts = parsed.filter(
      (p) => p.community.toLowerCase() === community.toLowerCase(),
    );

    const uniqueAuthors = new Set(communityPosts.map((p) => p.author)).size;

    const sampleCids = communityPosts.slice(0, 50).map((p) => p.cid);
    const scored: Array<{ cid: string; score: number }> = [];
    for (const cid of sampleCids) {
      try {
        const score = await this.contracts.getScore(cid);
        scored.push({ cid, score });
      } catch {
        // Skip
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const avgScore =
      scored.length > 0
        ? scored.reduce((sum, s) => sum + s.score, 0) / scored.length
        : 0;
    const topCids = scored.slice(0, 5).map((s) => s.cid);

    return { community, totalPosts, uniqueAuthors, avgScore, topCids };
  }

  private async _getCommunityListViaEvents(): Promise<string[]> {
    const events = await this.scanEvents(
      this.contracts.contentIndex,
      "ContentPublished",
    );
    const parsed = this.parseContentEvents(events);

    const communities = new Set<string>();
    for (const post of parsed) {
      communities.add(post.community);
    }
    return [...communities].sort();
  }
}

// ================================================================
//           PURE FUNCTIONS — Tag Cloud & Concept Timeline
// ================================================================

/**
 * Post shape expected by the pure tag/concept functions.
 * Matches the PostDocument structure from IPFS.
 */
interface TaggablePost {
  content: { tags?: string[] };
  timestamp: number;
  /** Optional external score (from subgraph, not part of IPFS doc). */
  score?: number;
}

/**
 * Compute a tag cloud from an array of already-fetched posts.
 *
 * This is a pure function — no network calls. Pass in posts that have
 * already been fetched from IPFS. Each post's `content.tags` array is
 * extracted and aggregated by frequency.
 *
 * @param posts - Array of post documents with tags
 * @param limit - Maximum number of tags to return (default: 30)
 * @returns Tags sorted by count (descending)
 */
export function getTagCloud(posts: TaggablePost[], limit = 30): TagCount[] {
  const tagMap = new Map<string, { count: number; totalScore: number }>();

  for (const post of posts) {
    const tags = post.content.tags;
    if (!tags || tags.length === 0) continue;

    const score = post.score ?? 0;

    for (const rawTag of tags) {
      // Sanitize: strip control chars, RTL overrides, zero-width chars; limit to 50 chars
      const tag = rawTag
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
        .trim()
        .toLowerCase()
        .slice(0, 50);
      if (!tag) continue;

      const existing = tagMap.get(tag);
      if (existing) {
        existing.count++;
        existing.totalScore += score;
      } else {
        tagMap.set(tag, { count: 1, totalScore: score });
      }
    }
  }

  const results: TagCount[] = [];
  for (const [tag, data] of tagMap) {
    results.push({ tag, count: data.count, totalScore: data.totalScore });
  }

  results.sort((a, b) => b.count - a.count);
  return results.slice(0, limit);
}

/**
 * Compute a concept timeline — how a specific tag's usage evolved over time.
 *
 * Pure function — no network calls. Groups posts containing the given tag
 * by day and returns daily counts + scores.
 *
 * @param posts - Array of post documents with tags and timestamps
 * @param tag - The tag to track
 * @returns Timeline with daily data points (earliest first)
 */
export function getConceptTimeline(
  posts: TaggablePost[],
  tag: string,
): ConceptTimeline {
  const normalizedTag = tag.trim().toLowerCase();
  const dayMap = new Map<number, { count: number; totalScore: number }>();
  const SECONDS_PER_DAY = 86400;

  for (const post of posts) {
    const tags = post.content.tags;
    if (!tags) continue;

    const hasTag = tags.some((t) => t.trim().toLowerCase() === normalizedTag);
    if (!hasTag) continue;

    const dayTimestamp =
      Math.floor(post.timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const score = post.score ?? 0;

    const existing = dayMap.get(dayTimestamp);
    if (existing) {
      existing.count++;
      existing.totalScore += score;
    } else {
      dayMap.set(dayTimestamp, { count: 1, totalScore: score });
    }
  }

  const points: ConceptTimelinePoint[] = [];
  for (const [timestamp, data] of dayMap) {
    points.push({
      timestamp,
      count: data.count,
      totalScore: data.totalScore,
    });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);

  const totalPosts = points.reduce((sum, p) => sum + p.count, 0);

  return { tag: normalizedTag, points, totalPosts };
}
