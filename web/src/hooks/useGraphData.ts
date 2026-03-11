import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";
import type { SubgraphAgent } from "./useAgentProfile";
import type { SubgraphCommunity } from "./useCommunityList";
import { HIDDEN_COMMUNITIES } from "./useCommunityList";
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
  AGENT_COLOR,
  HUMAN_COLOR,
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

/** Shape returned by GET /v1/index/graph */
interface IndexGraphResponse {
  agents: Array<{
    id: string;
    did_cid: string;
    registered_at: string;
    updated_at: string;
    is_verified: boolean;
    is_active: boolean;
    staked_amount: string;
    post_count: number;
    following_count: number;
    follower_count: number;
    attestation_count: number;
    attestations_given_count: number;
    total_upvotes_received: number;
    total_downvotes_received: number;
    communities_active: string[];
    agent_type?: number;
  }>;
  communities: Array<{
    id: string;
    total_posts: number;
    unique_authors: number;
    total_score: number;
    last_post_at: string;
  }>;
  attestations: Array<{
    attester_id: string;
    subject_id: string;
    reason: string;
    timestamp: string;
  }>;
  votingRelations?: Array<{
    voter_id: string;
    author_id: string;
    upvote_count: number;
    downvote_count: number;
  }>;
}

/** Transform REST response into the internal GraphQueryResult shape. */
function toGraphQueryResult(raw: IndexGraphResponse): GraphQueryResult {
  return {
    agents: (raw.agents ?? []).map((a) => ({
      id: a.id,
      didCid: a.did_cid,
      registeredAt: a.registered_at,
      updatedAt: a.updated_at,
      isVerified: a.is_verified,
      isActive: a.is_active,
      stakedAmount: a.staked_amount,
      postCount: a.post_count,
      followingCount: a.following_count,
      followerCount: a.follower_count,
      attestationCount: a.attestation_count,
      attestationsGivenCount: a.attestations_given_count,
      totalUpvotesReceived: a.total_upvotes_received,
      totalDownvotesReceived: a.total_downvotes_received,
      communitiesActive: a.communities_active ?? [],
      agentType: a.agent_type,
    })),
    communities: (raw.communities ?? []).map((c) => ({
      id: c.id,
      totalPosts: c.total_posts,
      uniqueAuthors: c.unique_authors,
      totalScore: c.total_score,
      lastPostAt: c.last_post_at,
      isRegistered: false,
    })),
    attestations: (raw.attestations ?? [])
      .filter((a) => a.attester_id && a.subject_id)
      .map((a) => ({
        attester: { id: a.attester_id },
        subject: { id: a.subject_id },
        reason: a.reason,
        timestamp: a.timestamp,
      })),
    votingRelations: (raw.votingRelations ?? [])
      .filter((vr) => vr.voter_id && vr.author_id)
      .map((vr) => ({
        voter: { id: vr.voter_id },
        author: { id: vr.author_id },
        upvoteCount: vr.upvote_count,
        downvoteCount: vr.downvote_count,
      })),
  };
}

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

  // Pre-compute the earliest member registeredAt per community (for timeline fade-in).
  // A community appears when its first participating agent appears.
  const communityEarliestMember = new Map<string, number>();
  for (const agent of agents) {
    const regAt = parseInt(agent.registeredAt) || 0;
    if (regAt <= 0) continue;
    for (const communityName of agent.communitiesActive) {
      const cid = communityName.toLowerCase();
      const prev = communityEarliestMember.get(cid);
      if (prev === undefined || regAt < prev) {
        communityEarliestMember.set(cid, regAt);
      }
    }
  }

  // Community nodes (add first so IDs are available for participation edges)
  for (const c of communities) {
    const id = c.id.toLowerCase();
    if (HIDDEN_COMMUNITIES.has(id)) continue;
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
      appearsAt: communityEarliestMember.get(id) ?? 0,
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
    const isHuman = (agent.agentType ?? 0) === 1;
    const genre = primaryComm;
    const genreColor = genre ? communityColor(genre) : (isHuman ? HUMAN_COLOR : AGENT_COLOR);

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
      genre,
      genreColor,
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

  // Pre-build agent → communities set map for Jaccard similarity
  const agentCommunitySets = new Map<string, Set<string>>();
  for (const agent of agents) {
    const id = agent.id.toLowerCase();
    agentCommunitySets.set(id, new Set(agent.communitiesActive.map((c) => c.toLowerCase())));
  }

  // Attestation edges (agent -> agent) with relevance scoring
  for (const att of attestations) {
    const srcId = att.attester.id.toLowerCase();
    const tgtId = att.subject.id.toLowerCase();
    if (nodeIds.has(srcId) && nodeIds.has(tgtId) && srcId !== tgtId) {
      const attesterRep = agentScores.get(srcId) ?? 0;

      // Jaccard similarity of communities between attester and receiver
      const srcComms = agentCommunitySets.get(srcId);
      const tgtComms = agentCommunitySets.get(tgtId);
      let jaccard = 0;
      if (srcComms && tgtComms && (srcComms.size > 0 || tgtComms.size > 0)) {
        let shared = 0;
        for (const c of srcComms) { if (tgtComms.has(c)) shared++; }
        const unionSize = srcComms.size + tgtComms.size - shared;
        jaccard = unionSize > 0 ? shared / unionSize : 0;
      }

      links.push({
        type: "attestation",
        source: srcId,
        target: tgtId,
        reason: att.reason || "",
        attesterReputation: attesterRep,
        weight: Math.max(jaccard * 0.5 + (attesterRep / 100) * 0.5, 0.15),
        timestamp: parseInt(att.timestamp) || 0,
        relevance: jaccard,
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
  // Always extend to now so the timeline covers today
  const now = Math.floor(Date.now() / 1000);
  if (maxTs < now) maxTs = now;

  return { nodes, links, allCommunities, timestampRange: { min: minTs, max: maxTs } };
}

// --- Hook ---

export function useGraphData(filters: GraphFilters = DEFAULT_FILTERS, enabled = true) {
  const rawResult = useGatewayQuery<IndexGraphResponse>(
    ["graph"],
    "/v1/index/graph",
    {
      enabled,
      staleTime: 900_000,       // 15 min — graph topology rarely changes
      gcTime: 1_800_000,       // 30 min — keep cached data in memory longer
      placeholderData: keepPreviousData,  // show previous data during background refetch
      retry: 1,                 // Only 1 retry — graph already auto-retries every 30s in the component
      retryDelay: 5000,         // 5s delay before retry (be gentle on rate-limited subgraph)
    },
  );

  // Transform REST snake_case to internal camelCase types
  const data = rawResult.data ? toGraphQueryResult(rawResult.data) : undefined;

  const graphData = useMemo(
    () => (data ? buildGraphData(data, filters) : null),
    [data, filters],
  );

  const allCommunities = useMemo(
    () => (data ? (data.communities ?? []).map((c) => c.id) : []),
    [data],
  );

  return { data: graphData, allCommunities, isLoading: rawResult.isLoading, error: rawResult.error, refetch: rawResult.refetch };
}
