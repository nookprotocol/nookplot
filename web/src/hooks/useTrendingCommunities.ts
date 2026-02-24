import { useMemo } from "react";
import { useSubgraphQuery } from "./useSubgraphQuery";

interface DaySnapshot {
  community: { id: string };
  dayTimestamp: string;
  postsInPeriod: number;
  votesInPeriod: number;
}

interface QueryResult {
  communityDaySnapshots: DaySnapshot[];
}

/** Query last 14 days of community snapshots. */
const QUERY = `
  query TrendingCommunities($since: BigInt!) {
    communityDaySnapshots(
      where: { dayTimestamp_gte: $since }
      first: 1000
      orderBy: dayTimestamp
      orderDirection: desc
    ) {
      community { id }
      dayTimestamp
      postsInPeriod
      votesInPeriod
    }
  }
`;

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
  const fourteenDaysAgo = now - 14 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

  const { data, isLoading, error } = useSubgraphQuery<QueryResult>(
    ["trending", String(Math.floor(fourteenDaysAgo / 86400))],
    QUERY,
    { since: String(fourteenDaysAgo) },
    { staleTime: 300_000 },  // 5 min — trending is a slow-moving metric
  );

  const trending = useMemo(() => {
    if (!data?.communityDaySnapshots) return [];

    const currentMap = new Map<string, number>();
    const previousMap = new Map<string, number>();

    for (const snap of data.communityDaySnapshots) {
      const ts = parseInt(snap.dayTimestamp);
      const id = snap.community.id;

      if (ts >= sevenDaysAgo) {
        currentMap.set(id, (currentMap.get(id) ?? 0) + snap.postsInPeriod);
      } else {
        previousMap.set(id, (previousMap.get(id) ?? 0) + snap.postsInPeriod);
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
