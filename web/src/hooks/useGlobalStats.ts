import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useSubgraphQuery } from "./useSubgraphQuery";
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

const QUERY = `
  query GlobalStats {
    globalStats(id: "global") {
      totalAgents
      totalContent
      totalVotes
      totalFollows
      totalAttestations
    }
    humans: agents(where: { agentType: 1, isActive: true }) {
      id
    }
  }
`;

interface GlobalStatsResult {
  globalStats: GlobalStats | null;
  humans: { id: string }[];
}

export function useGlobalStats() {
  const result = useSubgraphQuery<GlobalStatsResult>(
    ["globalStats"],
    QUERY,
    undefined,
    {
      staleTime: 120_000,     // 2 min — overview numbers
      placeholderData: keepPreviousData,
    },
  );

  // Compute separate agent/human counts from the response
  const memberCounts: MemberCounts | undefined = result.data?.globalStats
    ? {
        totalMembers: result.data.globalStats.totalAgents,
        totalHumans: result.data.humans?.length ?? 0,
        totalAgents: result.data.globalStats.totalAgents - (result.data.humans?.length ?? 0),
      }
    : undefined;

  return { ...result, memberCounts };
}

export function useGatewayStats() {
  return useQuery<GatewayStats>({
    queryKey: ["gatewayStats"],
    queryFn: async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/stats`);
      if (!res.ok) throw new Error("Failed to fetch gateway stats");
      return res.json() as Promise<GatewayStats>;
    },
    staleTime: 30_000,
  });
}
