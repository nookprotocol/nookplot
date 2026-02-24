/**
 * Resolves agent addresses to display names via DID documents.
 *
 * Batch-fetches didCid from the subgraph, then fetches DID docs from IPFS
 * to extract displayName. Results are cached via TanStack Query so each
 * agent's name is only resolved once per session.
 */

import { useQuery } from "@tanstack/react-query";
import { querySubgraph } from "@/lib/subgraph";
import { fetchJson } from "@/lib/ipfs";
import type { DIDDocument } from "@/lib/did";

interface AgentDidCid {
  id: string;
  didCid: string | null;
}

const DID_CID_QUERY = `
  query AgentDidCids($ids: [Bytes!]!) {
    agents(where: { id_in: $ids }) {
      id
      didCid
    }
  }
`;

function extractName(did: DIDDocument): string | null {
  return did.agentProfile?.displayName
    || did.metadata?.displayName
    || null;
}

/**
 * Given a list of addresses, returns a Map<address, displayName | null>.
 * Addresses without a DID doc or displayName will map to null.
 */
export function useAgentNames(addresses: string[]) {
  // Deduplicate and normalise
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];

  return useQuery<Map<string, string | null>>({
    queryKey: ["agentNames", unique.join(",")],
    queryFn: async () => {
      const nameMap = new Map<string, string | null>();
      if (unique.length === 0) return nameMap;

      // 1. Batch-fetch didCids from subgraph
      const data = await querySubgraph<{ agents: AgentDidCid[] }>(
        DID_CID_QUERY,
        { ids: unique },
      );

      // 2. Fetch DID docs in parallel for agents that have a didCid
      const cidMap = new Map<string, string>();
      for (const agent of data.agents) {
        if (agent.didCid) cidMap.set(agent.id.toLowerCase(), agent.didCid);
      }

      const entries = [...cidMap.entries()];
      const results = await Promise.allSettled(
        entries.map(async ([addr, cid]) => {
          const did = await fetchJson<DIDDocument>(cid);
          return { addr, name: extractName(did) };
        }),
      );

      // 3. Build the result map
      for (const r of results) {
        if (r.status === "fulfilled") {
          nameMap.set(r.value.addr, r.value.name);
        }
      }

      // Fill in nulls for addresses we couldn't resolve
      for (const addr of unique) {
        if (!nameMap.has(addr)) nameMap.set(addr, null);
      }

      return nameMap;
    },
    enabled: unique.length > 0,
    staleTime: 5 * 60 * 1000, // 5 min — names don't change often
    gcTime: 30 * 60 * 1000,   // 30 min cache
  });
}
