import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";
import { GATEWAY_URL } from "@/config/constants";

export interface GlobalStats {
  totalAgents: number;
  totalContent: number;
  totalVotes: number;
  totalFollows: number;
  totalAttestations: number;
}

/** Breakdown of registered entities by type */
export interface MemberCounts {
  totalAgents: number;   // agentType != 1 (agents + legacy/unspecified)
  totalHumans: number;   // agentType == 1
  totalMembers: number;  // all registrations
}

export interface GatewayStats {
  totalProjects: number;
  totalAgents: number;
}

/** Shape returned by GET /v1/index/stats */
interface IndexStatsResponse {
  globalStats: {
    total_agents: number;
    total_content: number;
    total_votes: number;
    total_follows: number;
    total_attestations: number;
  } | null;
  humanCount: number;
}

export function useGlobalStats() {
  const result = useGatewayQuery<IndexStatsResponse>(
    ["globalStats"],
    "/v1/index/stats",
    {
      staleTime: 120_000,     // 2 min — overview numbers
      placeholderData: keepPreviousData,
    },
  );

  // Transform snake_case REST response to expected camelCase shape
  const globalStats: GlobalStats | undefined = result.data?.globalStats
    ? {
        totalAgents: result.data.globalStats.total_agents,
        totalContent: result.data.globalStats.total_content,
        totalVotes: result.data.globalStats.total_votes,
        totalFollows: result.data.globalStats.total_follows,
        totalAttestations: result.data.globalStats.total_attestations,
      }
    : undefined;

  // Compute separate agent/human counts from the response
  const memberCounts: MemberCounts | undefined = globalStats
    ? {
        totalMembers: globalStats.totalAgents,
        totalHumans: result.data?.humanCount ?? 0,
        totalAgents: globalStats.totalAgents - (result.data?.humanCount ?? 0),
      }
    : undefined;

  return {
    data: globalStats ? { globalStats } : undefined,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
    memberCounts,
  };
}

export function useGatewayStats() {
  return useQuery<GatewayStats>({
    queryKey: ["gatewayStats"],
    queryFn: async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/stats`);
      if (!res.ok) throw new Error("Failed to fetch gateway stats");
      return res.json() as Promise<GatewayStats>;
    },
    staleTime: 120_000,
    placeholderData: keepPreviousData,
  });
}
