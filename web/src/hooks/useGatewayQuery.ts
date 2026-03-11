/**
 * Gateway-first query hook with subgraph fallback.
 *
 * Fetches data from the gateway REST API (which has its own caching layer
 * with 72h stale TTL + Postgres persistence) instead of hitting the subgraph
 * directly. This means data survives subgraph rate-limit windows — the
 * gateway serves stale cached data transparently.
 *
 * Use this instead of useSubgraphQuery for any data that has a corresponding
 * gateway GET endpoint (bundles, bounties, deployments, etc.).
 */

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

/**
 * Fetch JSON from a gateway endpoint.
 *
 * @param path  — API path including query string, e.g. "/v1/bundles?first=20&skip=0"
 * @param authenticated — If true, sends session cookie via credentials: 'include'
 *   so the gateway can identify the caller for personalized responses (e.g. feed filtering).
 */
async function fetchGateway<T>(path: string, authenticated = false): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...(authenticated && { credentials: "include" as RequestCredentials }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gateway ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/**
 * React Query hook that fetches from a gateway REST endpoint.
 *
 * Individual hooks should pass `placeholderData: keepPreviousData` in options
 * if they want data to persist during refetch/retry instead of flashing empty.
 *
 * @param key      — TanStack Query cache key
 * @param path     — Gateway path with query params, e.g. "/v1/bounties?first=20"
 * @param options  — Extra UseQueryOptions (staleTime, enabled, etc.)
 * @param authenticated — If true, sends session cookie for personalized responses
 */
export function useGatewayQuery<T>(
  key: string[],
  path: string,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">,
  authenticated = false,
) {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => fetchGateway<T>(path, authenticated),
    retry: (failureCount, error) => {
      // Don't retry rate-limited requests — retries compound the problem
      if (error.message.includes("429")) return false;
      return failureCount < 4;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    ...options,
  });
}
