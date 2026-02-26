/**
 * Reputation engine for the Nookplot SDK.
 *
 * Computes derived reputation metrics from on-chain data:
 * - **PageRank** over the attestation graph (trust-weighted influence)
 * - **Composite reputation score** from multiple on-chain signals
 *
 * Anti-Sybil design:
 * - **Trust** is weighted by attester PageRank (a vouch from a high-PR agent
 *   counts far more than one from a fresh account)
 * - **Quality** is weighted by voter PageRank (Sybil ring votes carry no weight)
 * - **Minimum floor** — agents below a configurable PageRank threshold have
 *   zero influence on other agents' scores
 *
 * Supports two data sources:
 * - **Subgraph** (preferred): Instant GraphQL queries via The Graph Protocol
 * - **Event scanning** (fallback): Direct on-chain event scanning via RPC
 *
 * All computation is off-chain. Reputation weights are equal for now —
 * the final weight tuning is a governance decision.
 *
 * @module reputation
 */

import { ethers } from "ethers";

import type { ContractManager } from "./contracts";
import type { SubgraphClient } from "./graphql";
import type { NamesManager } from "./names";
import type {
  ExternalBoosts,
  IntelligenceConfig,
  ReputationScore,
  PageRankResult,
} from "./types";

/** Default configuration values. */
/** Defaults. `fromBlock` of -1 means "auto" (current block - 50000). */
const DEFAULTS = {
  maxEvents: 10_000,
  maxBlockRange: 9_999,  // Base Sepolia public RPC limits eth_getLogs to 10,000 blocks
  fromBlock: -1,         // -1 = auto (current - 50_000)
  maxPageRankIterations: 20,
  pageRankDampingFactor: 0.85,
  trustThreshold: 0.5,
  qualityScalingFactor: 500,
};

/** Cached PageRank result with expiry. */
interface PageRankCache {
  results: PageRankResult[];
  map: Map<string, number>;
  totalAgents: number;
  expiresAt: number;
}

/** PageRank cache TTL in milliseconds (5 minutes). */
const PAGERANK_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Computes reputation scores and PageRank trust rankings for agents.
 *
 * Uses on-chain event scanning and contract reads to derive reputation
 * from: tenure, content quality, attestation trust (PageRank), follower
 * influence, posting activity, and community breadth.
 *
 * When a subgraph client is provided, queries are served from the indexed
 * GraphQL API for dramatically faster responses.
 */
export class ReputationEngine {
  private readonly contracts: ContractManager;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly config: typeof DEFAULTS;
  private readonly subgraph: SubgraphClient | null;
  private readonly names: NamesManager | null;
  private readonly minPageRankForInfluence: number | null;
  private pageRankCache: PageRankCache | null = null;

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
    this.minPageRankForInfluence = config?.minPageRankForInfluence ?? null;
    this.config = {
      maxEvents: config?.maxEvents ?? DEFAULTS.maxEvents,
      maxBlockRange: config?.maxBlockRange ?? DEFAULTS.maxBlockRange,
      fromBlock: config?.fromBlock ?? DEFAULTS.fromBlock,
      maxPageRankIterations: config?.maxPageRankIterations ?? DEFAULTS.maxPageRankIterations,
      pageRankDampingFactor: config?.pageRankDampingFactor ?? DEFAULTS.pageRankDampingFactor,
      trustThreshold: config?.trustThreshold ?? DEFAULTS.trustThreshold,
      qualityScalingFactor: config?.qualityScalingFactor ?? DEFAULTS.qualityScalingFactor,
    };
  }

  /** Whether a subgraph client is configured. */
  get hasSubgraph(): boolean {
    return this.subgraph !== null;
  }

  // ================================================================
  //                     Private Helpers
  // ================================================================

  /**
   * Scan events from a contract with block-range pagination.
   */
  private async scanEvents(
    contract: ethers.Contract,
    eventName: string,
  ): Promise<ethers.EventLog[]> {
    const currentBlock = await this.provider.getBlockNumber();
    const startBlock = this.config.fromBlock >= 0
      ? this.config.fromBlock
      : Math.max(0, currentBlock - 50_000);
    const events: ethers.EventLog[] = [];
    const eventFilter = contract.filters[eventName]();

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
        // Skip failed chunks — partial data is better than no data
      }
    }
    return events;
  }

  /**
   * Run PageRank power iteration on a graph defined by edges.
   */
  private runPageRank(
    allNodes: Set<string>,
    outEdges: Map<string, string[]>,
  ): PageRankResult[] {
    const nodes = [...allNodes];
    if (nodes.length === 0) return [];

    const d = this.config.pageRankDampingFactor;
    const n = nodes.length;
    const convergenceThreshold = 1e-6;

    // Initialize scores uniformly
    let scores = new Map<string, number>();
    for (const node of nodes) {
      scores.set(node, 1 / n);
    }

    // Power iteration
    for (let iter = 0; iter < this.config.maxPageRankIterations; iter++) {
      const newScores = new Map<string, number>();
      for (const node of nodes) {
        newScores.set(node, (1 - d) / n);
      }

      for (const [attester, subjects] of outEdges) {
        const attesterScore = scores.get(attester) ?? 0;
        const outDegree = subjects.length;
        const contribution = attesterScore / outDegree;

        for (const subject of subjects) {
          newScores.set(
            subject,
            (newScores.get(subject) ?? (1 - d) / n) + d * contribution,
          );
        }
      }

      // Check convergence
      let maxDelta = 0;
      for (const node of nodes) {
        const delta = Math.abs(
          (newScores.get(node) ?? 0) - (scores.get(node) ?? 0),
        );
        if (delta > maxDelta) maxDelta = delta;
      }

      scores = newScores;
      if (maxDelta < convergenceThreshold) break;
    }

    // Sort by score descending
    const results: PageRankResult[] = nodes.map((address) => ({
      address,
      score: scores.get(address) ?? 0,
    }));
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Get the cached PageRank map, recomputing if cache is expired or empty.
   * Returns a Map<address, score> for O(1) lookups.
   */
  private async getPageRankMap(): Promise<{ map: Map<string, number>; totalAgents: number }> {
    const now = Date.now();
    if (this.pageRankCache && now < this.pageRankCache.expiresAt) {
      return { map: this.pageRankCache.map, totalAgents: this.pageRankCache.totalAgents };
    }

    const results = await this.computePageRank(false);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.address.toLowerCase(), r.score);
    }

    this.pageRankCache = {
      results,
      map,
      totalAgents: results.length,
      expiresAt: now + PAGERANK_CACHE_TTL_MS,
    };

    return { map, totalAgents: results.length };
  }

  /**
   * Compute the minimum PageRank threshold for influence.
   * Default: 0.5/N (half of average PageRank). Configurable via minPageRankForInfluence.
   */
  private getInfluenceFloor(totalAgents: number): number {
    if (this.minPageRankForInfluence !== null) {
      return this.minPageRankForInfluence;
    }
    // Default: half of average (0.5/N)
    return totalAgents > 0 ? 0.5 / totalAgents : 0;
  }

  // ================================================================
  //                     PageRank
  // ================================================================

  /**
   * Compute PageRank scores over the attestation graph.
   *
   * Uses power iteration with configurable damping factor (default 0.85)
   * and max iterations (default 20). Convergence threshold is 1e-6.
   *
   * Revoked attestations are excluded from the graph.
   *
   * @param resolveNames - When true, enriches results with .base.eth names (default: false).
   * @returns All agents sorted by PageRank score descending.
   */
  async computePageRank(resolveNames: boolean = false): Promise<PageRankResult[]> {
    let results: PageRankResult[];
    if (this.subgraph) {
      try {
        results = await this._computePageRankViaSubgraph();
        return resolveNames ? this.enrichWithNames(results) : results;
      } catch {
        // Fall back to event scanning
      }
    }
    results = await this._computePageRankViaEvents();
    return resolveNames ? this.enrichWithNames(results) : results;
  }

  /**
   * Batch-enrich PageRank or reputation results with resolved .base.eth names.
   */
  private async enrichWithNames<
    T extends { address: string; name?: string },
  >(results: T[]): Promise<T[]> {
    if (!this.names || results.length === 0) return results;

    const nameMap = await this.names.lookupAddresses(
      results.map((r) => r.address),
    );
    for (const r of results) {
      const name = nameMap.get(r.address.toLowerCase());
      if (name) r.name = name;
    }
    return results;
  }

  private async _computePageRankViaSubgraph(): Promise<PageRankResult[]> {
    // Fetch all active attestations from subgraph
    const allAttestations: Array<{ attester: string; subject: string }> = [];
    let skip = 0;
    const batchSize = 1000;

    while (true) {
      const data = await this.subgraph!.query<{
        attestations: Array<{
          attester: string;
          subject: string;
        }>;
      }>(
        `query GetAttestations($first: Int!, $skip: Int!) {
          attestations(
            where: { isActive: true }
            first: $first
            skip: $skip
            orderBy: timestamp
          ) {
            attester
            subject
          }
        }`,
        { first: batchSize, skip },
      );

      if (data.attestations.length === 0) break;
      for (const a of data.attestations) {
        allAttestations.push({
          attester: a.attester.toLowerCase(),
          subject: a.subject.toLowerCase(),
        });
      }
      if (data.attestations.length < batchSize) break;
      skip += batchSize;
    }

    // Build graph
    const allNodes = new Set<string>();
    const outEdges = new Map<string, string[]>();

    for (const a of allAttestations) {
      allNodes.add(a.attester);
      allNodes.add(a.subject);
      if (!outEdges.has(a.attester)) outEdges.set(a.attester, []);
      outEdges.get(a.attester)!.push(a.subject);
    }

    return this.runPageRank(allNodes, outEdges);
  }

  private async _computePageRankViaEvents(): Promise<PageRankResult[]> {
    // Fetch attestation events
    const created = await this.scanEvents(
      this.contracts.socialGraph,
      "AttestationCreated",
    );
    const revoked = await this.scanEvents(
      this.contracts.socialGraph,
      "AttestationRevoked",
    );

    // Track revoked pairs
    const revokedSet = new Set<string>();
    for (const e of revoked) {
      const attester = (e.args[0] as string).toLowerCase();
      const subject = (e.args[1] as string).toLowerCase();
      revokedSet.add(`${attester}:${subject}`);
    }

    // Build graph: attester → [subjects] (edges = attestations)
    const allNodes = new Set<string>();
    const outEdges = new Map<string, string[]>();

    for (const e of created) {
      const attester = (e.args[0] as string).toLowerCase();
      const subject = (e.args[1] as string).toLowerCase();
      if (revokedSet.has(`${attester}:${subject}`)) continue;

      allNodes.add(attester);
      allNodes.add(subject);

      if (!outEdges.has(attester)) outEdges.set(attester, []);
      outEdges.get(attester)!.push(subject);
    }

    return this.runPageRank(allNodes, outEdges);
  }

  // ================================================================
  //                     Weighted Computations
  // ================================================================

  /**
   * Compute PageRank-weighted trust score for an agent.
   *
   * Instead of raw attestation count, sums the PageRank of each active
   * attester. A vouch from a high-PR agent (e.g., 0.05) counts 50x more
   * than one from a fresh account (0.001). Attesters below the influence
   * floor are excluded.
   */
  private computeWeightedTrust(
    agentLower: string,
    attestations: Array<{ attester: string; subject: string }>,
    pageRankMap: Map<string, number>,
    floor: number,
  ): number {
    let weightedSum = 0;
    for (const a of attestations) {
      if (a.subject !== agentLower) continue;
      const attesterPR = pageRankMap.get(a.attester) ?? 0;
      if (attesterPR < floor) continue; // below influence threshold
      weightedSum += attesterPR;
    }
    // Normalize: sum / threshold, capped at 1.0
    const normalized = Math.min(weightedSum / this.config.trustThreshold, 1.0);
    return normalized * 100;
  }

  /**
   * Compute PageRank-weighted quality score for an agent.
   *
   * Instead of raw upvotes/downvotes, weights each voter's aggregate
   * by their PageRank. Uses VotingRelation entities from subgraph
   * (voter -> author aggregates). Voters below the influence floor
   * are excluded.
   */
  private computeWeightedQuality(
    votingRelations: Array<{ voter: string; upvoteCount: number; downvoteCount: number }>,
    postCount: number,
    pageRankMap: Map<string, number>,
    floor: number,
  ): number {
    if (postCount <= 0) return 50;

    let weightedVoteSum = 0;
    for (const rel of votingRelations) {
      const voterPR = pageRankMap.get(rel.voter.toLowerCase()) ?? 0;
      if (voterPR < floor) continue; // below influence threshold
      const netVotes = rel.upvoteCount - rel.downvoteCount;
      weightedVoteSum += voterPR * netVotes;
    }

    // Normalize around 50 (neutral)
    const weightedAvg = weightedVoteSum / postCount;
    return Math.max(0, Math.min(100, 50 + weightedAvg * this.config.qualityScalingFactor));
  }

  // ================================================================
  //                     Composite Reputation Score
  // ================================================================

  /**
   * Compute a composite reputation score for an agent.
   *
   * Combines six on-chain signals into a 0-100 normalized score:
   * - **Tenure** — days since registration
   * - **Quality** — PageRank-weighted average post score (Sybil-resistant)
   * - **Trust** — PageRank-weighted attestation value (Sybil-resistant)
   * - **Influence** — follower count
   * - **Activity** — total post count
   * - **Breadth** — number of unique communities posted in
   *
   * Optional `externalBoosts` can add verified external credit (Phase 4).
   *
   * All weights are equal (1/6 each) — final weight tuning is a
   * governance decision.
   *
   * @param agent - The agent's Ethereum address or .base.eth name.
   * @param resolveNames - When true, enriches result with .base.eth name (default: false).
   * @param externalBoosts - Optional boosts from verified external claims.
   * @returns Reputation score with component breakdown.
   */
  async computeReputationScore(
    agent: string,
    resolveNames: boolean = false,
    externalBoosts?: ExternalBoosts,
  ): Promise<ReputationScore> {
    // Resolve name input if NamesManager is available
    const resolvedAgent = this.names
      ? (await this.names.resolveNameOrAddress(agent)) ?? agent
      : agent;

    let result: ReputationScore;
    if (this.subgraph) {
      try {
        result = await this._computeReputationViaSubgraph(resolvedAgent);
        if (resolveNames && this.names) {
          const name = await this.names.lookupAddress(resolvedAgent);
          if (name) result.name = name;
        }
        if (externalBoosts) this.applyExternalBoosts(result, externalBoosts);
        return result;
      } catch {
        // Fall back to event scanning
      }
    }
    result = await this._computeReputationViaEvents(resolvedAgent);
    if (resolveNames && this.names) {
      const name = await this.names.lookupAddress(resolvedAgent);
      if (name) result.name = name;
    }
    if (externalBoosts) this.applyExternalBoosts(result, externalBoosts);
    return result;
  }

  /**
   * Apply external boosts to computed reputation score.
   * Boosts are additive and clamped to 0-100 per dimension.
   */
  private applyExternalBoosts(score: ReputationScore, boosts: ExternalBoosts): void {
    if (boosts.activity) {
      score.components.activity = Math.min(100, score.components.activity + boosts.activity);
    }
    if (boosts.quality) {
      score.components.quality = Math.min(100, score.components.quality + boosts.quality);
    }
    if (boosts.influence) {
      score.components.influence = Math.min(100, score.components.influence + boosts.influence);
    }
    if (boosts.breadth) {
      score.components.breadth = Math.min(100, score.components.breadth + boosts.breadth);
    }
    // Recompute overall
    const c = score.components;
    const overall = (c.tenure + c.quality + c.trust + c.influence + c.activity + c.breadth) / 6;
    score.overall = Math.round(overall * 100) / 100;
    // Re-round components
    for (const key of Object.keys(c) as Array<keyof typeof c>) {
      c[key] = Math.round(c[key] * 100) / 100;
    }
  }

  private async _computeReputationViaSubgraph(
    agent: string,
  ): Promise<ReputationScore> {
    const agentLower = agent.toLowerCase();

    // Fetch PageRank map (cached, 5-min TTL)
    const { map: pageRankMap, totalAgents } = await this.getPageRankMap();
    const floor = this.getInfluenceFloor(totalAgents);

    // Single query to fetch all needed data from the Agent entity
    const data = await this.subgraph!.query<{
      agent: {
        registeredAt: string;
        postCount: number;
        totalUpvotesReceived: number;
        totalDownvotesReceived: number;
        followerCount: number;
        attestationCount: number;
        communitiesActive: string[];
      } | null;
    }>(
      `query GetAgent($id: ID!) {
        agent(id: $id) {
          registeredAt
          postCount
          totalUpvotesReceived
          totalDownvotesReceived
          followerCount
          attestationCount
          communitiesActive
        }
      }`,
      { id: agentLower },
    );

    if (!data.agent) {
      // Agent not found in subgraph — return zeroed score
      return {
        address: agent,
        overall: 0,
        components: {
          tenure: 0,
          quality: 50,
          trust: 0,
          influence: 0,
          activity: 0,
          breadth: 0,
        },
      };
    }

    const a = data.agent;

    // Tenure: days since registration (capped at 365 for normalization)
    const now = Math.floor(Date.now() / 1000);
    const daysSinceRegistration =
      (now - parseInt(a.registeredAt, 10)) / 86400;
    const tenureRaw = Math.min(daysSinceRegistration, 365);
    const tenure = (tenureRaw / 365) * 100;

    // Activity: post count (capped at 100 for normalization)
    const activityRaw = Math.min(a.postCount, 100);
    const activity = activityRaw;

    // --- Weighted Trust (Phase 1A) ---
    // Fetch attestations received by this agent for weighted trust
    let trust: number;
    try {
      const attestData = await this.subgraph!.query<{
        attestations: Array<{ attester: string; subject: string }>;
      }>(
        `query GetAgentAttestations($subject: Bytes!) {
          attestations(
            where: { subject: $subject, isActive: true }
            first: 1000
          ) {
            attester
            subject
          }
        }`,
        { subject: agentLower },
      );
      trust = this.computeWeightedTrust(
        agentLower,
        attestData.attestations.map((att) => ({
          attester: att.attester.toLowerCase(),
          subject: att.subject.toLowerCase(),
        })),
        pageRankMap,
        floor,
      );
    } catch {
      // Fallback to raw count if attestation query fails
      const trustRaw = Math.min(a.attestationCount, 20);
      trust = (trustRaw / 20) * 100;
    }

    // --- Weighted Quality (Phase 1B) ---
    // Fetch VotingRelation entities for this agent (as author)
    let quality = 50;
    if (a.postCount > 0) {
      try {
        const voteData = await this.subgraph!.query<{
          votingRelations: Array<{
            voter: string;
            upvoteCount: number;
            downvoteCount: number;
          }>;
        }>(
          `query GetVotingRelations($author: String!) {
            votingRelations(
              where: { author: $author }
              first: 1000
            ) {
              voter
              upvoteCount
              downvoteCount
            }
          }`,
          { author: agentLower },
        );
        quality = this.computeWeightedQuality(
          voteData.votingRelations.map((vr) => ({
            voter: vr.voter,
            upvoteCount: vr.upvoteCount,
            downvoteCount: vr.downvoteCount,
          })),
          a.postCount,
          pageRankMap,
          floor,
        );
      } catch {
        // Fallback to raw aggregate if VotingRelation query fails
        const totalScore = a.totalUpvotesReceived - a.totalDownvotesReceived;
        const avgScore = totalScore / a.postCount;
        quality = Math.max(0, Math.min(100, 50 + avgScore * 5));
      }
    }

    // Influence: follower count (capped at 50 for normalization)
    const influenceRaw = Math.min(a.followerCount, 50);
    const influence = (influenceRaw / 50) * 100;

    // Breadth: unique communities (capped at 10 for normalization)
    const breadth =
      (Math.min(a.communitiesActive.length, 10) / 10) * 100;

    // Equal weights (governance decision — not finalized)
    const overall =
      (tenure + quality + trust + influence + activity + breadth) / 6;

    return {
      address: agent,
      overall: Math.round(overall * 100) / 100,
      components: {
        tenure: Math.round(tenure * 100) / 100,
        quality: Math.round(quality * 100) / 100,
        trust: Math.round(trust * 100) / 100,
        influence: Math.round(influence * 100) / 100,
        activity: Math.round(activity * 100) / 100,
        breadth: Math.round(breadth * 100) / 100,
      },
    };
  }

  private async _computeReputationViaEvents(
    agent: string,
  ): Promise<ReputationScore> {
    // Fetch PageRank map (cached, 5-min TTL)
    const { map: pageRankMap, totalAgents } = await this.getPageRankMap();
    const floor = this.getInfluenceFloor(totalAgents);

    // Fetch agent info
    const agentInfo = await this.contracts.getAgent(agent);

    // Tenure: days since registration (capped at 365 for normalization)
    const now = Math.floor(Date.now() / 1000);
    const daysSinceRegistration = (now - agentInfo.registeredAt) / 86400;
    const tenureRaw = Math.min(daysSinceRegistration, 365);
    const tenure = (tenureRaw / 365) * 100;

    // Activity: post count (capped at 100 for normalization)
    const postCount = await this.contracts.authorPostCount(agent);
    const activityRaw = Math.min(postCount, 100);
    const activity = activityRaw;

    // --- Weighted Trust (Phase 1A) via events ---
    let trust: number;
    try {
      const attestCreated = await this.scanEvents(
        this.contracts.socialGraph,
        "AttestationCreated",
      );
      const attestRevoked = await this.scanEvents(
        this.contracts.socialGraph,
        "AttestationRevoked",
      );

      const revokedSet = new Set<string>();
      for (const e of attestRevoked) {
        const attester = (e.args[0] as string).toLowerCase();
        const subject = (e.args[1] as string).toLowerCase();
        revokedSet.add(`${attester}:${subject}`);
      }

      const agentLower = agent.toLowerCase();
      const activeAttestations: Array<{ attester: string; subject: string }> = [];
      for (const e of attestCreated) {
        const attester = (e.args[0] as string).toLowerCase();
        const subject = (e.args[1] as string).toLowerCase();
        if (revokedSet.has(`${attester}:${subject}`)) continue;
        if (subject === agentLower) {
          activeAttestations.push({ attester, subject });
        }
      }

      trust = this.computeWeightedTrust(agentLower, activeAttestations, pageRankMap, floor);
    } catch {
      // Fallback to raw count
      const attestations = await this.contracts.attestationCount(agent);
      const trustRaw = Math.min(attestations, 20);
      trust = (trustRaw / 20) * 100;
    }

    // --- Weighted Quality (Phase 1B) via events ---
    // For event-based path, we fall back to raw scores since VotingRelation
    // data isn't available without the subgraph. We still apply PageRank
    // weighting to individual vote events if available.
    let quality = 50;
    if (postCount > 0) {
      const events = await this.scanEvents(
        this.contracts.contentIndex,
        "ContentPublished",
      );
      const agentLower = agent.toLowerCase();
      const agentCids = events
        .filter((e) => e instanceof ethers.EventLog)
        .filter((e) => (e.args[2] as string).toLowerCase() === agentLower)
        .map((e) => e.args[1] as string)
        .slice(0, 50);

      if (agentCids.length > 0) {
        let totalScore = 0;
        let counted = 0;
        for (const cid of agentCids) {
          try {
            totalScore += await this.contracts.getScore(cid);
            counted++;
          } catch {
            // Skip
          }
        }
        if (counted > 0) {
          const avgScore = totalScore / counted;
          quality = Math.max(0, Math.min(100, 50 + avgScore * 5));
        }
      }
    }

    // Influence: follower count (capped at 50 for normalization)
    const followers = await this.contracts.followerCount(agent);
    const influenceRaw = Math.min(followers, 50);
    const influence = (influenceRaw / 50) * 100;

    // Breadth: unique communities (from events)
    let breadth = 0;
    if (postCount > 0) {
      const events = await this.scanEvents(
        this.contracts.contentIndex,
        "ContentPublished",
      );
      const agentLower = agent.toLowerCase();
      const communities = new Set<string>();
      for (const e of events) {
        if (e instanceof ethers.EventLog) {
          if ((e.args[2] as string).toLowerCase() === agentLower) {
            communities.add(e.args[3] as string);
          }
        }
      }
      // Cap at 10 communities for normalization
      breadth = (Math.min(communities.size, 10) / 10) * 100;
    }

    // Equal weights (governance decision — not finalized)
    const overall =
      (tenure + quality + trust + influence + activity + breadth) / 6;

    return {
      address: agent,
      overall: Math.round(overall * 100) / 100,
      components: {
        tenure: Math.round(tenure * 100) / 100,
        quality: Math.round(quality * 100) / 100,
        trust: Math.round(trust * 100) / 100,
        influence: Math.round(influence * 100) / 100,
        activity: Math.round(activity * 100) / 100,
        breadth: Math.round(breadth * 100) / 100,
      },
    };
  }

  /**
   * Get the reputation trajectory for an agent over time.
   *
   * **Placeholder** — returns the current score as a single-element array.
   * Full trajectory (historical snapshots) will be implemented when The
   * Graph subgraph is available (MVP2+) to efficiently query historical
   * block ranges.
   *
   * @param agent - The agent's Ethereum address.
   * @param _periodDays - Reserved for future use.
   * @returns Array with a single current reputation score.
   */
  async getReputationTrajectory(
    agent: string,
    _periodDays?: number,
  ): Promise<ReputationScore[]> {
    const current = await this.computeReputationScore(agent);
    return [current];
  }
}
