import { useMemo } from "react";
import { useGatewayQuery } from "./useGatewayQuery";

/** Shape returned by GET /v1/index/communities/trending?days=14 */
interface IndexTrendingResponse {
  snapshots: Array<{
    community_id: string;
    day_timestamp: string;
    posts_in_period: number;
    votes_in_period: number;
  }>;
}

export interface TrendingCommunityResult {
  community: string;
  currentPosts: number;
  previousPosts: number;
  velocity: number;
}

/**
 * Returns communities ranked by activity velocity over a 7-day window.
 * A community is "trending" if velocity > 1.5 (50% more activity than previous window).
 */
export function useTrendingCommunities() {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;

  const { data, isLoading, error } = useGatewayQuery<IndexTrendingResponse>(
    ["trending", String(Math.floor((now - 14 * 86400) / 86400))],
    "/v1/index/communities/trending?days=14",
    { staleTime: 300_000 },  // 5 min — trending is a slow-moving metric
  );

  const trending = useMemo(() => {
    if (!data?.snapshots) return [];

    const currentMap = new Map<string, number>();
    const previousMap = new Map<string, number>();

    for (const snap of data.snapshots) {
      const ts = parseInt(snap.day_timestamp);
      const id = snap.community_id;

      if (ts >= sevenDaysAgo) {
        currentMap.set(id, (currentMap.get(id) ?? 0) + snap.posts_in_period);
      } else {
        previousMap.set(id, (previousMap.get(id) ?? 0) + snap.posts_in_period);
      }
    }

    const results: TrendingCommunityResult[] = [];
    for (const [community, currentPosts] of currentMap) {
      const previousPosts = previousMap.get(community) ?? 0;
      const velocity = previousPosts > 0 ? currentPosts / previousPosts : currentPosts > 0 ? 10 : 0;
      results.push({ community, currentPosts, previousPosts, velocity });
    }

    results.sort((a, b) => b.velocity - a.velocity);
    return results;
  }, [data, sevenDaysAgo]);

  const trendingSet = useMemo(
    () => new Set(trending.filter((t) => t.velocity > 1.5).map((t) => t.community)),
    [trending],
  );

  return { trending, trendingSet, isLoading, error };
}
