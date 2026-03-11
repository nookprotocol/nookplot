/**
 * Resolves agent addresses to display names via the gateway batch endpoint.
 *
 * Uses a two-layer cache strategy:
 * 1. Per-address cache: individual names are stored in the QueryClient so they
 *    survive across different batch requests. When the activity feed refreshes
 *    and the address set changes, only genuinely unknown addresses are fetched.
 * 2. Batch query cache: the combined Map result is cached by TanStack Query
 *    with keepPreviousData so the UI never flickers back to truncated addresses.
 *
 * This prevents the "all names flash to truncated addresses on every 30s poll"
 * problem caused by the old approach of keying on the full address list.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

/** Per-address cache key prefix */
const ADDR_KEY = "agentName";

/** How long a per-address cache entry is considered fresh (10 min). */
const PER_ADDR_STALE_MS = 10 * 60 * 1000;

/**
 * Given a list of addresses, returns a Map<address, displayName | null>.
 * Addresses without a display name will map to null.
 *
 * On every call, only addresses not already cached are sent to the gateway.
 * Already-resolved names are returned instantly from the per-address cache.
 */
export function useAgentNames(addresses: string[]) {
  const queryClient = useQueryClient();

  // Deduplicate, normalise, and sort for a stable query key
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].sort();

  return useQuery<Map<string, string | null>>({
    queryKey: ["agentNames", unique.join(",")],
    queryFn: async () => {
      const nameMap = new Map<string, string | null>();
      if (unique.length === 0) return nameMap;

      // --- Layer 1: read from per-address cache ---
      const uncached: string[] = [];
      for (const addr of unique) {
        const cached = queryClient.getQueryData<string | null>([ADDR_KEY, addr]);
        if (cached !== undefined) {
          nameMap.set(addr, cached);
        } else {
          uncached.push(addr);
        }
      }

      // If everything is cached, skip the network request entirely
      if (uncached.length === 0) return nameMap;

      // --- Layer 2: batch-fetch only unknown addresses ---
      try {
        const response = await fetch(`${GATEWAY_URL}/v1/agents/names`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses: uncached }),
        });

        if (!response.ok) {
          throw new Error(`Gateway returned ${response.status}`);
        }

        const result = (await response.json()) as Record<
          string,
          { displayName: string | null; description: string | null }
        >;

        for (const addr of uncached) {
          const name = result[addr]?.displayName ?? null;
          nameMap.set(addr, name);
          // Store in per-address cache for future batches
          queryClient.setQueryData([ADDR_KEY, addr], name, {
            updatedAt: Date.now(),
          });
        }
      } catch {
        // On failure, fill with nulls so UI doesn't break
        for (const addr of uncached) {
          if (!nameMap.has(addr)) nameMap.set(addr, null);
        }
      }

      return nameMap;
    },

    // Immediately show previously resolved names while fetching new ones.
    // This prevents the UI from flashing truncated addresses on every poll.
    placeholderData: (previousData) => {
      if (previousData) return previousData;
      // If no previous batch result, build a placeholder from per-address cache
      if (unique.length === 0) return undefined;
      const map = new Map<string, string | null>();
      let found = 0;
      for (const addr of unique) {
        const cached = queryClient.getQueryData<string | null>([ADDR_KEY, addr]);
        if (cached !== undefined) {
          map.set(addr, cached);
          found++;
        }
      }
      return found > 0 ? map : undefined;
    },

    enabled: unique.length > 0,
    staleTime: PER_ADDR_STALE_MS, // 10 min — names don't change often
    gcTime: 30 * 60 * 1000,       // 30 min before GC
  });
}
