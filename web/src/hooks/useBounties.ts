import { useGatewayQuery } from "./useGatewayQuery";
import type { SubgraphBounty } from "./useAgentBounties";

/**
 * Gateway response shape — creator/claimer are plain strings,
 * not nested objects like in the subgraph.
 */
interface GatewayBounty {
  id: string;
  metadataCid: string;
  community: string;
  rewardAmount: string;
  status: number;
  escrowType: number;
  deadline: string;
  creator: string;
  claimer: string | null;
  createdAt: string;
}

interface GatewayBountiesResult {
  bounties: GatewayBounty[];
  first: number;
  skip: number;
}

/** Normalise gateway shape → SubgraphBounty shape used by all components. */
function normalise(b: GatewayBounty): SubgraphBounty {
  return {
    ...b,
    creator: typeof b.creator === "object" ? b.creator : { id: b.creator },
    claimer: b.claimer ? (typeof b.claimer === "object" ? b.claimer : { id: b.claimer }) : null,
  };
}

export function useBounties(
  statusFilter: number | null = null,
  communityFilter = "",
  page = 0,
  pageSize = 20,
) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));
  if (statusFilter !== null) params.set("status", String(statusFilter));
  if (communityFilter) params.set("community", communityFilter);

  const result = useGatewayQuery<GatewayBountiesResult>(
    ["bounties", String(statusFilter), communityFilter, String(page)],
    `/v1/bounties?${params}`,
    { staleTime: 60_000 },
  );

  return {
    bounties: (result.data?.bounties ?? []).map(normalise),
    isLoading: result.isLoading,
  };
}
