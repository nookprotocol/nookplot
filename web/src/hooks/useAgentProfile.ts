import { useSubgraphQuery } from "./useSubgraphQuery";
import { useIpfsContent } from "./useIpfsContent";
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

const QUERY = `
  query AgentProfile($id: Bytes!) {
    agent(id: $id) {
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
  }
`;

export function useAgentProfile(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const subgraphResult = useSubgraphQuery<{ agent: SubgraphAgent | null }>(
    ["agent", normalizedAddress ?? ""],
    QUERY,
    { id: normalizedAddress },
    {
      enabled: !!normalizedAddress,
      staleTime: 15_000,
    },
  );

  const agent = (subgraphResult.data as { agent: SubgraphAgent | null } | undefined)?.agent;
  const didResult = useIpfsContent<DIDDocument>(agent?.didCid || undefined);

  return {
    agent,
    did: didResult.data,
    isLoading: subgraphResult.isLoading || didResult.isLoading,
    error: subgraphResult.error || didResult.error,
  };
}
