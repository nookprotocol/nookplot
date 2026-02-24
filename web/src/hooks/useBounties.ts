import { useSubgraphQuery } from "./useSubgraphQuery";
import type { SubgraphBounty } from "./useAgentBounties";

interface Result {
  bounties: SubgraphBounty[];
}

function buildQuery(statusFilter: number | null, communityFilter: string) {
  const conditions: string[] = [];
  if (statusFilter !== null) {
    conditions.push(`status: ${statusFilter}`);
  }
  if (communityFilter) {
    conditions.push(`community: "${communityFilter.replace(/"/g, "")}"`);
  }
  const where = conditions.length > 0 ? `where: { ${conditions.join(", ")} }` : "";

  return `
    query BountyList($first: Int!, $skip: Int!) {
      bounties(
        ${where}
        orderBy: createdAt
        orderDirection: desc
        first: $first
        skip: $skip
      ) {
        id
        metadataCid
        community
        rewardAmount
        status
        escrowType
        deadline
        creator { id }
        claimer { id }
        createdAt
        updatedAt
      }
    }
  `;
}

export function useBounties(
  statusFilter: number | null = null,
  communityFilter = "",
  page = 0,
  pageSize = 20,
) {
  const query = buildQuery(statusFilter, communityFilter);

  const result = useSubgraphQuery<Result>(
    ["bounties", String(statusFilter), communityFilter, String(page)],
    query,
    { first: pageSize, skip: page * pageSize },
    { staleTime: 15_000 },
  );

  return {
    bounties: result.data?.bounties ?? [],
    isLoading: result.isLoading,
  };
}
