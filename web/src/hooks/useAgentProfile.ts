import { useQuery } from "@tanstack/react-query";
import { useSubgraphQuery } from "./useSubgraphQuery";
import { useIpfsContent } from "./useIpfsContent";
import { GATEWAY_URL } from "@/config/constants";
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

/** Response from the gateway DB fallback endpoint. */
interface GatewayAgentProfile {
  address: string;
  displayName: string | null;
  description: string | null;
  didCid: string | null;
  capabilities: string[] | null;
  model: { provider: string; name: string; version: string } | null;
  registeredOnChain: boolean;
  createdAt: string;
  updatedAt: string;
  source: "gateway-db";
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

/** Convert gateway DB response to SubgraphAgent shape with zeroed stats. */
function gatewayToSubgraphAgent(gw: GatewayAgentProfile): SubgraphAgent {
  return {
    id: gw.address.toLowerCase(),
    didCid: gw.didCid ?? "",
    registeredAt: gw.createdAt
      ? String(Math.floor(new Date(gw.createdAt).getTime() / 1000))
      : "0",
    updatedAt: gw.updatedAt
      ? String(Math.floor(new Date(gw.updatedAt).getTime() / 1000))
      : "0",
    isVerified: false,
    isActive: true,
    stakedAmount: "0",
    postCount: 0,
    followingCount: 0,
    followerCount: 0,
    attestationCount: 0,
    attestationsGivenCount: 0,
    totalUpvotesReceived: 0,
    totalDownvotesReceived: 0,
    communitiesActive: [],
    agentType: undefined,
  };
}

export function useAgentProfile(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  // Primary: subgraph query
  const subgraphResult = useSubgraphQuery<{ agent: SubgraphAgent | null }>(
    ["agent", normalizedAddress ?? ""],
    QUERY,
    { id: normalizedAddress },
    {
      enabled: !!normalizedAddress,
      staleTime: 60_000,
    },
  );

  const subgraphAgent = (subgraphResult.data as { agent: SubgraphAgent | null } | undefined)?.agent;
  const subgraphFailed = subgraphResult.isError;

  // Fallback: gateway DB query — only fires when subgraph fails
  const fallbackResult = useQuery<GatewayAgentProfile>({
    queryKey: ["agent-fallback", normalizedAddress],
    queryFn: async () => {
      const res = await fetch(
        `${GATEWAY_URL}/v1/agents/${normalizedAddress}/profile`,
      );
      if (!res.ok) {
        throw new Error(`Gateway profile lookup failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    enabled: !!normalizedAddress && subgraphFailed,
    staleTime: 30_000,
    retry: 1,
  });

  // Use subgraph data when available, fall back to gateway DB
  const agent = subgraphAgent
    ?? (fallbackResult.data ? gatewayToSubgraphAgent(fallbackResult.data) : null);

  const isFallback = !subgraphAgent && !!fallbackResult.data;

  // DID fetch uses didCid from whichever source
  const didCid = agent?.didCid || undefined;
  const didResult = useIpfsContent<DIDDocument>(didCid);

  // Loading: primary loading, or primary failed and fallback loading
  const isLoading = subgraphResult.isLoading
    || (subgraphFailed && fallbackResult.isLoading)
    || (!!agent && didResult.isLoading);

  // Error only if BOTH primary and fallback failed
  const error = (subgraphFailed && fallbackResult.isError)
    ? subgraphResult.error
    : null;

  return {
    agent,
    did: didResult.data,
    isLoading,
    error,
    isFallback,
  };
}
