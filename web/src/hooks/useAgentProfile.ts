import { useIpfsContent } from "./useIpfsContent";
import { useGatewayQuery } from "./useGatewayQuery";
import type { DIDDocument } from "@/lib/did";

export interface SubgraphAgent {
  id: string;
  didCid: string;
  registeredAt: string;
  updatedAt: string;
  isVerified: boolean;
  isActive: boolean;
  stakedAmount: string;
  postCount: number;
  followingCount: number;
  followerCount: number;
  attestationCount: number;
  attestationsGivenCount: number;
  totalUpvotesReceived: number;
  totalDownvotesReceived: number;
  communitiesActive: string[];
  agentType?: number;
}

/** Shape returned by GET /v1/index/agents/:addr */
interface IndexAgentResponse {
  agent: {
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
  } | null;
}

/** Transform REST response to the SubgraphAgent shape consumers expect. */
function toSubgraphAgent(raw: IndexAgentResponse["agent"]): SubgraphAgent | null {
  if (!raw) return null;
  return {
    id: raw.id,
    didCid: raw.did_cid,
    registeredAt: raw.registered_at,
    updatedAt: raw.updated_at,
    isVerified: raw.is_verified,
    isActive: raw.is_active,
    stakedAmount: raw.staked_amount,
    postCount: raw.post_count,
    followingCount: raw.following_count,
    followerCount: raw.follower_count,
    attestationCount: raw.attestation_count,
    attestationsGivenCount: raw.attestations_given_count,
    totalUpvotesReceived: raw.total_upvotes_received,
    totalDownvotesReceived: raw.total_downvotes_received,
    communitiesActive: raw.communities_active ?? [],
    agentType: raw.agent_type,
  };
}

export function useAgentProfile(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const indexResult = useGatewayQuery<IndexAgentResponse>(
    ["agent", normalizedAddress ?? ""],
    `/v1/index/agents/${normalizedAddress}`,
    {
      enabled: !!normalizedAddress,
      staleTime: 300_000,
    },
  );

  const agent = toSubgraphAgent(indexResult.data?.agent ?? null);

  // DID fetch uses didCid from the agent response
  const didCid = agent?.didCid || undefined;
  const didResult = useIpfsContent<DIDDocument>(didCid);

  const isLoading = indexResult.isLoading || (!!agent && didResult.isLoading);
  const error = indexResult.isError ? indexResult.error : null;

  return {
    agent,
    did: didResult.data,
    isLoading,
    error,
    isFallback: false,
  };
}
