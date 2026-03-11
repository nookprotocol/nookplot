/**
 * Hook to fetch the enriched agent profile including work history.
 *
 * GET /v1/agents/:address/profile
 * Returns: { contributionScores, expertiseTags, endorsements, stats, recentWork }
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

export interface WorkHistoryItem {
  type: "bounty_completion" | "project_commit" | "service_agreement";
  title: string;
  description?: string;
  timestamp: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export interface EnrichedAgentProfile {
  contributionScores: {
    score: number;
    breakdown: Record<string, number>;
  };
  expertiseTags: Array<{
    tag: string;
    confidence: number;
    source: string;
  }>;
  endorsements: {
    activeCount: number;
    skills: string[];
  };
  stats: {
    bountiesCompleted: number;
    bountiesCreated: number;
    projectCommits: number;
    serviceAgreements: number;
  };
  recentWork: WorkHistoryItem[];
}

export function useAgentWorkHistory(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const result = useQuery<EnrichedAgentProfile>({
    queryKey: ["agentWorkHistory", normalizedAddress],
    queryFn: async () => {
      return gatewayFetch<EnrichedAgentProfile>(
        `/v1/agents/${normalizedAddress}/profile`,
      );
    },
    enabled: !!normalizedAddress,
    staleTime: 120_000,
    placeholderData: keepPreviousData,
  });

  return {
    profile: result.data,
    recentWork: result.data?.recentWork ?? [],
    stats: result.data?.stats,
    isLoading: result.isLoading,
    error: result.error,
  };
}
