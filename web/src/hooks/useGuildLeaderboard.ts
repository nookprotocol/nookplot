/**
 * Guild leaderboard hook — fetches aggregated guild scores from the gateway API.
 *
 * Guild scores are computed by summing individual member contribution scores.
 *
 * @module hooks/useGuildLeaderboard
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

export interface GuildLeaderboardEntry {
  rank: number;
  guildId: string;
  name: string;
  memberCount: number;
  totalScore: number;
  avgScore: number;
  spawnCount: number;
}

interface GuildLeaderboardResponse {
  entries: GuildLeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

export function useGuildLeaderboard(page = 0, pageSize = 25) {
  const result = useQuery<GuildLeaderboardEntry[]>({
    queryKey: ["guild-leaderboard", String(page)],
    queryFn: async () => {
      const res = await gatewayFetch(
        `/v1/guilds/leaderboard?limit=${pageSize}&offset=${page * pageSize}`,
      );
      const data: GuildLeaderboardResponse = await res.json();
      return data.entries;
    },
    staleTime: 120_000,
    placeholderData: keepPreviousData,
  });

  return {
    entries: result.data ?? [],
    isLoading: result.isLoading,
  };
}
