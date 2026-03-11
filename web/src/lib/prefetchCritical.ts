/**
 * Prefetch critical page data into the TanStack Query cache on app mount.
 *
 * All calls are fire-and-forget — failures are silently caught by prefetchQuery.
 * Data populates the cache so navigating to these pages shows instant results,
 * especially valuable when combined with localStorage cache persistence.
 *
 * Query keys MUST exactly match the keys produced by the corresponding hooks
 * with their default arguments, or the prefetched data won't be found.
 */

import type { QueryClient } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

async function gw<T>(path: string): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Prefetch ${res.status}`);
  return res.json() as Promise<T>;
}

export function prefetchCriticalData(qc: QueryClient): void {
  // Home page: global stats — key from useGlobalStats()
  qc.prefetchQuery({
    queryKey: ["globalStats"],
    queryFn: () => gw("/v1/index/stats"),
    staleTime: 120_000,
  });

  // Home page: gateway stats — key from useGatewayStats()
  qc.prefetchQuery({
    queryKey: ["gatewayStats"],
    queryFn: () => gw("/v1/stats"),
    staleTime: 120_000,
  });

  // Home page: feed (hot, all communities, page 0) — key from useCommunityFeed("hot")
  qc.prefetchQuery({
    queryKey: ["feed", "hot", "all", "0", "all"],
    queryFn: () => gw("/v1/index/feed?sort=hot&first=25&skip=0"),
    staleTime: 120_000,
  });

  // Bounties (default: all statuses, page 0) — key from useBounties(null)
  // Note: String(null) === "null"
  qc.prefetchQuery({
    queryKey: ["bounties", "null", "", "0"],
    queryFn: () => gw("/v1/bounties?first=20&skip=0"),
    staleTime: 300_000,
  });

  // Papers (page 1, limit 20, no filters) — key from usePapers(1, 20)
  qc.prefetchQuery({
    queryKey: ["papers", "1", "20", "", "0", ""],
    queryFn: () => gw("/v1/ingestion/papers?page=1&limit=20"),
    staleTime: 300_000,
  });

  // Ingestion status — key from useIngestionStatus()
  qc.prefetchQuery({
    queryKey: ["ingestion-status"],
    queryFn: () => gw("/v1/ingestion/status"),
    staleTime: 300_000,
  });

  // Bundles (page 0, sort newest) — key from useBundles(0, 20)
  // Note: sort ?? "newest" in the hook
  qc.prefetchQuery({
    queryKey: ["bundles", "0", "newest"],
    queryFn: () => gw("/v1/bundles?first=20&skip=0&sort=newest"),
    staleTime: 300_000,
  });

  // Guilds (active, sort by score) — key from useGuilds(0, 20, 1, "score")
  qc.prefetchQuery({
    queryKey: ["guilds", "0", "1", "score"],
    queryFn: () => gw("/v1/index/guilds?first=20&skip=0&status=1&sort=score"),
    staleTime: 300_000,
  });

  // Marketplace (active only, page 0) — key from useServiceListings("", true, 0)
  qc.prefetchQuery({
    queryKey: ["serviceListings", "", "true", "0"],
    queryFn: () => gw("/v1/index/services?active=true&first=20&skip=0"),
    staleTime: 300_000,
  });

  // Leaderboard (page 0) — key from useLeaderboard(0, 25)
  // IMPORTANT: useLeaderboard stores data.entries (the array), not the full response
  qc.prefetchQuery({
    queryKey: ["leaderboard", "0"],
    queryFn: async () => {
      const data = await gw<{ entries: unknown[] }>("/v1/contributions/leaderboard?limit=25&offset=0");
      return data.entries;
    },
    staleTime: 120_000,
  });
}
