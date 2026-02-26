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
 * Fetch JSON from a gateway endpoint (no auth required).
 *
 * @param path  — API path including query string, e.g. "/v1/bundles?first=20&skip=0"
 */
async function fetchGateway<T>(path: string): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
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
 * @param key      — TanStack Query cache key
 * @param path     — Gateway path with query params, e.g. "/v1/bounties?first=20"
 * @param options  — Extra UseQueryOptions (staleTime, enabled, etc.)
 */
export function useGatewayQuery<T>(
  key: string[],
  path: string,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">,
) {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => fetchGateway<T>(path),
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    ...options,
  });
}
