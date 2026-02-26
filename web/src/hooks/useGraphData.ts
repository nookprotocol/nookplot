import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useSubgraphQuery } from "./useSubgraphQuery";
import type { SubgraphAgent } from "./useAgentProfile";
import type { SubgraphCommunity } from "./useCommunityList";
import {
  type GraphData,
  type GraphNode,
  type GraphEdge,
  type GraphFilters,
  DEFAULT_FILTERS,
  computeSimpleReputation,
  agentNodeRadius,
  communityNodeRadius,
  communityColor,
} from "@/lib/graphTypes";

// --- Query types ---

interface SubgraphAttestation {
  attester: { id: string };
  subject: { id: string };
  reason: string;
  timestamp: string;
}

interface SubgraphVotingRelation {
  voter: { id: string };
  author: { id: string };
  upvoteCount: number;
  downvoteCount: number;
}

interface GraphQueryResult {
  agents: SubgraphAgent[];
  communities: SubgraphCommunity[];
  attestations: SubgraphAttestation[];
  votingRelations?: SubgraphVotingRelation[]; // optional — requires subgraph redeploy
}

// Single combined query — same pattern as every other hook
const GRAPH_QUERY = `
  query KnowledgeGraph {
    agents(
      first: 200
      orderBy: postCount
      orderDirection: desc
      where: { isActive: true }
    ) {
      id
      didCid
      registeredAt
      updatedAt
      isVerified
      isActive
      stakedAmount
      postCount
      followingCount
      followerCount
      attestationCount
      attestationsGivenCount
      totalUpvotesReceived
      totalDownvotesReceived
      communitiesActive
      agentType
    }
    communities(
      first: 100
      orderBy: totalPosts
      orderDirection: desc
      where: { totalPosts_gt: 0 }
    ) {
      id
      totalPosts
      uniqueAuthors
      totalScore
      lastPostAt
    }
    attestations(
      first: 200
      where: { isActive: true }
    ) {
      attester { id }
      subject { id }
      reason
      timestamp
    }
  }
`;

// --- Transform ---

function buildGraphData(
  raw: GraphQueryResult,
  filters: GraphFilters = DEFAULT_FILTERS,
): GraphData {
  const agents = raw.agents ?? [];
  const communities = raw.communities ?? [];
  const attestations = raw.attestations ?? [];
  const votingRelations = raw.votingRelations ?? [];

  // Pre-compute reputation scores for all agents (needed for filter + edge weights)
  const agentScores = new Map<string, number>();
  for (const agent of agents) {
    agentScores.set(agent.id.toLowerCase(), computeSimpleReputation(agent));
  }

  // Collect all community names before filtering
  const allCommunities = communities.map((c) => c.id);

  const nodeIds = new Set<string>();
  const nodes: GraphNode[] = [];
  const links: GraphEdge[] = [];

  // Determine which communities pass filter
  const communityFilter = new Set(
    filters.communities.length > 0
      ? filters.communities.map((c) => c.toLowerCase())
      : communities.map((c) => c.id.toLowerCase()),
  );

  // Community nodes (add first so IDs are available for participation edges)
  for (const c of communities) {
    const id = c.id.toLowerCase();
    if (!communityFilter.has(id)) continue;
    nodeIds.add(id);
    nodes.push({
      type: "community",
      id,
      name: c.id,
      totalPosts: c.totalPosts,
      uniqueAuthors: c.uniqueAuthors,
      totalScore: c.totalScore,
      radius: communityNodeRadius(c.totalPosts, c.uniqueAuthors, c.totalScore),
    });
  }

  // Agent nodes + participation edges (from communitiesActive)
  for (const agent of agents) {
    const id = agent.id.toLowerCase();
    const score = agentScores.get(id) ?? 0;

    // Apply filters
    if (score < filters.reputationMin || score > filters.reputationMax) continue;
    if (agent.postCount < filters.minPosts) continue;

    // If community filter is active, only include agents active in at least one filtered community
    if (filters.communities.length > 0) {
      const hasMatchingCommunity = agent.communitiesActive.some((c) =>
        communityFilter.has(c.toLowerCase()),
      );
      if (!hasMatchingCommunity) continue;
    }

    const primaryComm = agent.communitiesActive.length > 0 ? agent.communitiesActive[0] : null;

    nodeIds.add(id);
    nodes.push({
      type: "agent",
      id,
      address: agent.id,
      postCount: agent.postCount,
      attestationCount: agent.attestationCount,
      followerCount: agent.followerCount,
      reputationScore: score,
      radius: agentNodeRadius(score),
      primaryCommunity: primaryComm,
      primaryCommunityColor: primaryComm ? communityColor(primaryComm) : null,
      communitiesActive: agent.communitiesActive,
      registeredAt: parseInt(agent.registeredAt) || 0,
      agentType: agent.agentType ?? 0,
    });

    // Participation edges derived from agent.communitiesActive
    for (const communityName of agent.communitiesActive) {
      const communityId = communityName.toLowerCase();
      if (nodeIds.has(communityId)) {
        links.push({
          type: "participation",
          source: id,
          target: communityId,
          weight: Math.min(agent.postCount / 50, 1),
        });
      }
    }
  }

  // Attestation edges (agent -> agent)
  for (const att of attestations) {
    const srcId = att.attester.id.toLowerCase();
    const tgtId = att.subject.id.toLowerCase();
    if (nodeIds.has(srcId) && nodeIds.has(tgtId) && srcId !== tgtId) {
      const attesterRep = agentScores.get(srcId) ?? 0;
      links.push({
        type: "attestation",
        source: srcId,
        target: tgtId,
        reason: att.reason || "",
        attesterReputation: attesterRep,
        weight: Math.max(attesterRep / 100, 0.15), // minimum 0.15 so edges are visible
        timestamp: parseInt(att.timestamp) || 0,
      });
    }
  }

  // Voting edges (agent -> agent, from VotingRelation)
  for (const vr of votingRelations) {
    const srcId = vr.voter.id.toLowerCase();
    const tgtId = vr.author.id.toLowerCase();
    if (nodeIds.has(srcId) && nodeIds.has(tgtId) && srcId !== tgtId) {
      links.push({
        type: "voting",
        source: srcId,
        target: tgtId,
        upvoteCount: vr.upvoteCount,
        downvoteCount: vr.downvoteCount,
        weight: Math.min(vr.upvoteCount / 10, 1),
      });
    }
  }

  // Compute timestamp range across all nodes and edges
  let minTs = Infinity;
  let maxTs = 0;
  for (const node of nodes) {
    if (node.type === "agent" && node.registeredAt > 0) {
      if (node.registeredAt < minTs) minTs = node.registeredAt;
      if (node.registeredAt > maxTs) maxTs = node.registeredAt;
    }
  }
  for (const link of links) {
    if (link.type === "attestation" && link.timestamp > 0) {
      if (link.timestamp < minTs) minTs = link.timestamp;
      if (link.timestamp > maxTs) maxTs = link.timestamp;
    }
  }
  // Fallback if no timestamps found
  if (minTs === Infinity) minTs = 0;
  if (maxTs === 0) maxTs = Math.floor(Date.now() / 1000);

  return { nodes, links, allCommunities, timestampRange: { min: minTs, max: maxTs } };
}

// --- Hook ---

export function useGraphData(filters: GraphFilters = DEFAULT_FILTERS) {
  const { data, isLoading, error, refetch } = useSubgraphQuery<GraphQueryResult>(
    ["graph"],
    GRAPH_QUERY,
    undefined,
    {
      staleTime: 900_000,       // 15 min — graph topology rarely changes
      gcTime: 1_800_000,       // 30 min — keep cached data in memory longer
      placeholderData: keepPreviousData,  // show previous data during background refetch
      retry: 1,                 // Only 1 retry — graph already auto-retries every 30s in the component
      retryDelay: 5000,         // 5s delay before retry (be gentle on rate-limited subgraph)
    },
  );

  const graphData = useMemo(
    () => (data ? buildGraphData(data, filters) : null),
    [data, filters],
  );

  const allCommunities = useMemo(
    () => (data ? (data.communities ?? []).map((c) => c.id) : []),
    [data],
  );

  return { data: graphData, allCommunities, isLoading, error, refetch };
}
