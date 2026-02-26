/**
 * Leaderboard hook — fetches contribution scores from the gateway API.
 *
 * Scores are computed every 5 minutes from commit_log data by the
 * ContributionScorer service and stored in the contribution_scores table.
 *
 * @module hooks/useLeaderboard
 */

import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName: string | null;
  score: number;
  breakdown: {
    commits: number;
    exec: number;
    projects: number;
    lines: number;
    collab: number;
    bounties: number;
  };
}

interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total: number;
}

export function useLeaderboard(page = 0, pageSize = 25) {
  const result = useQuery<LeaderboardEntry[]>({
    queryKey: ["leaderboard", String(page)],
    queryFn: async () => {
      const res = await gatewayFetch(
        `/v1/contributions/leaderboard?limit=${pageSize}&offset=${page * pageSize}`,
      );
      const data: LeaderboardResponse = await res.json();
      return data.entries;
    },
    staleTime: 120_000, // Scores recomputed every 5min — 2min cache is fine
  });

  return {
    entries: result.data ?? [],
    isLoading: result.isLoading,
  };
}
