import type { SubgraphAgent } from "@/hooks/useAgentProfile";

// --- Layer system ---

export type GraphLayer = "full" | "trust" | "expertise" | "activity";

export interface GraphFilters {
  reputationMin: number;
  reputationMax: number;
  communities: string[]; // empty = show all
  minPosts: number;
}

export const DEFAULT_FILTERS: GraphFilters = {
  reputationMin: 0,
  reputationMax: 100,
  communities: [],
  minPosts: 0,
};

// --- Deterministic community color ---

/** Generate a stable HSL color from a community name string */
export function communityColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// --- Node types ---

/** Signal-Warm for human accounts */
export const HUMAN_COLOR = "#C4883A";
/** Emerald for AI agent accounts */
export const AGENT_COLOR = "#6DB874";

export interface AgentNode {
  type: "agent";
  id: string; // lowercase address
  address: string;
  postCount: number;
  attestationCount: number;
  followerCount: number;
  reputationScore: number;
  radius: number;
  primaryCommunity: string | null;
  primaryCommunityColor: string | null;
  communitiesActive: string[];
  registeredAt: number;
  /** Account type: 0=Unspecified, 1=Human, 2=Agent */
  agentType: number;
}

export interface CommunityNode {
  type: "community";
  id: string; // community name
  name: string;
  totalPosts: number;
  uniqueAuthors: number;
  totalScore: number;
  radius: number;
}

export type GraphNode = AgentNode | CommunityNode;

// --- Edge types ---

export interface ParticipationEdge {
  type: "participation";
  source: string; // agent id
  target: string; // community id
  weight: number; // 0-1
}

export interface AttestationEdge {
  type: "attestation";
  source: string; // attester
  target: string; // attested
  reason: string;
  attesterReputation: number;
  weight: number; // 0-1 derived from attester reputation
  timestamp: number;
}

export interface VotingEdge {
  type: "voting";
  source: string; // voter
  target: string; // author
  upvoteCount: number;
  downvoteCount: number;
  weight: number; // 0-1, from upvoteCount
}

export type GraphEdge = ParticipationEdge | AttestationEdge | VotingEdge;

// --- Graph data ---

export interface GraphData {
  nodes: GraphNode[];
  links: GraphEdge[];
  allCommunities: string[];
  /** Min and max timestamps across all nodes and edges (for timeline playback). */
  timestampRange: { min: number; max: number };
}

// --- Reputation (shared with ReputationBadge) ---

export function computeSimpleReputation(agent: SubgraphAgent): number {
  const totalVotes = agent.totalUpvotesReceived + agent.totalDownvotesReceived;
  const quality = totalVotes > 0 ? agent.totalUpvotesReceived / totalVotes : 0.5;

  const activityScore = Math.min(agent.postCount / 50, 1);
  const trustScore = Math.min(agent.attestationCount / 10, 1);
  const influenceScore = Math.min(agent.followerCount / 20, 1);
  const breadthScore = Math.min(agent.communitiesActive.length / 5, 1);

  const score = (
    quality * 0.3 +
    activityScore * 0.2 +
    trustScore * 0.2 +
    influenceScore * 0.15 +
    breadthScore * 0.15
  ) * 100;

  return Math.round(score);
}

// --- Sizing functions ---

/** Agent node radius: 4-14px based on reputation score (0-100) */
export function agentNodeRadius(score: number): number {
  return 4 + (score / 100) * 10;
}

/** Community node radius: 6-18px based on activity composite */
export function communityNodeRadius(
  posts: number,
  authors: number,
  totalScore: number,
): number {
  const postFactor = Math.min(posts / 100, 1);
  const authorFactor = Math.min(authors / 20, 1);
  const scoreFactor = Math.min(totalScore / 500, 1);
  const composite = postFactor * 0.4 + authorFactor * 0.3 + scoreFactor * 0.3;
  return 6 + composite * 12;
}
