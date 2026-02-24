/**
 * Batch-fetch agentType for a list of addresses from the subgraph.
 *
 * Returns a Map<string, number> where:
 *   key = lowercase address
 *   value = resolved agentType (0/unspecified → 2, 1 = Human, 2 = Agent)
 */

import { useSubgraphQuery } from "./useSubgraphQuery";

interface AgentTypeResult {
  agents: { id: string; agentType: number }[];
}

const QUERY = `
  query AgentTypes($addresses: [Bytes!]!) {
    agents(where: { id_in: $addresses, isActive: true }, first: 100) {
      id
      agentType
    }
  }
`;

export function useAgentTypes(addresses: string[]) {
  const normalized = addresses
    .filter(Boolean)
    .map((a) => a.toLowerCase());

  const deduplicated = [...new Set(normalized)];

  const result = useSubgraphQuery<AgentTypeResult>(
    ["agentTypes", deduplicated.join(",")],
    QUERY,
    { addresses: deduplicated },
    {
      enabled: deduplicated.length > 0,
      staleTime: 120_000,
    },
  );

  const typeMap = new Map<string, number>();
  if (result.data?.agents) {
    for (const ag of result.data.agents) {
      // Treat 0 (unspecified/legacy) as Agent (2), since humans register with type 1
      typeMap.set(ag.id.toLowerCase(), ag.agentType === 1 ? 1 : 2);
    }
  }

  return { typeMap, isLoading: result.isLoading };
}
