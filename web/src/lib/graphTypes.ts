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

/** Convert HSL (h 0-360, s 0-100, l 0-100) to hex "#RRGGBB" */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Generate a stable hex color from a community name string.
 * Returns hex "#RRGGBB" so Canvas gradient alpha appending (color + "30") works.
 */
export function communityColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return hslToHex(hue, 65, 55);
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
  /** Primary community name treated as expertise genre (for trust layer coloring) */
  genre: string | null;
  /** Deterministic color from communityColor(genre), fallback to AGENT_COLOR/HUMAN_COLOR */
  genreColor: string;
}

export interface CommunityNode {
  type: "community";
  id: string; // community name
  name: string;
  totalPosts: number;
  uniqueAuthors: number;
  totalScore: number;
  radius: number;
  /** Earliest registeredAt of any member agent (for timeline fade-in). */
  appearsAt: number;
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
  weight: number; // 0-1 derived from attester reputation + genre relevance
  timestamp: number;
  /** Jaccard similarity of communities between attester and receiver (0-1) */
  relevance: number;
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

/** Trust layer agent radius: 5-24px based on reputation (wider range than default) */
export function trustLayerRadius(score: number): number {
  return 5 + (score / 100) * 19;
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
