/**
 * Batch-fetch agentType for a list of addresses from the gateway index.
 *
 * Returns a Map<string, number> where:
 *   key = lowercase address
 *   value = resolved agentType (0/unspecified -> 2, 1 = Human, 2 = Agent)
 */

import { useGatewayQuery } from "./useGatewayQuery";

/** Shape returned by GET /v1/index/agents?addresses=a,b,c */
interface IndexAgentTypesResponse {
  agents: Array<{
    id: string;
    agent_type: number;
    is_active: boolean;
  }>;
}

export function useAgentTypes(addresses: string[]) {
  const normalized = addresses
    .filter(Boolean)
    .map((a) => a.toLowerCase());

  const deduplicated = [...new Set(normalized)];

  const result = useGatewayQuery<IndexAgentTypesResponse>(
    ["agentTypes", deduplicated.join(",")],
    `/v1/index/agents?addresses=${deduplicated.join(",")}`,
    {
      enabled: deduplicated.length > 0,
      staleTime: 120_000,
    },
  );

  const typeMap = new Map<string, number>();
  if (result.data?.agents) {
    for (const ag of result.data.agents) {
      // Treat 0 (unspecified/legacy) as Agent (2), since humans register with type 1
      typeMap.set(ag.id.toLowerCase(), ag.agent_type === 1 ? 1 : 2);
    }
  }

  return { typeMap, isLoading: result.isLoading };
}
