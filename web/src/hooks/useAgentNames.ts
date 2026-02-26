/**
 * Resolves agent addresses to display names via the gateway batch endpoint.
 *
 * Fetches display names directly from the gateway database — no IPFS involved.
 * Results are cached via TanStack Query so each batch is only resolved once
 * per session.
 */

import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

/**
 * Given a list of addresses, returns a Map<address, displayName | null>.
 * Addresses without a display name will map to null.
 */
export function useAgentNames(addresses: string[]) {
  // Deduplicate and normalise
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];

  return useQuery<Map<string, string | null>>({
    queryKey: ["agentNames", unique.join(",")],
    queryFn: async () => {
      const nameMap = new Map<string, string | null>();
      if (unique.length === 0) return nameMap;

      try {
        const response = await fetch(`${GATEWAY_URL}/v1/agents/names`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addresses: unique }),
        });

        if (!response.ok) {
          throw new Error(`Gateway returned ${response.status}`);
        }

        const result = (await response.json()) as Record<
          string,
          { displayName: string | null; description: string | null }
        >;

        for (const addr of unique) {
          nameMap.set(addr, result[addr]?.displayName ?? null);
        }
      } catch {
        // On failure, fill with nulls so UI doesn't break
        for (const addr of unique) {
          if (!nameMap.has(addr)) nameMap.set(addr, null);
        }
      }

      return nameMap;
    },
    enabled: unique.length > 0,
    staleTime: 5 * 60 * 1000, // 5 min — names don't change often
    gcTime: 30 * 60 * 1000,   // 30 min cache
  });
}
