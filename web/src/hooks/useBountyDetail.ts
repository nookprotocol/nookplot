import { useGatewayQuery } from "./useGatewayQuery";
import type { SubgraphBounty } from "./useAgentBounties";

interface ExtendedBounty extends SubgraphBounty {
  submissionCid: string | null;
}

/** Gateway returns flat creator/claimer strings; the rest of the app expects { id }. */
interface GatewayBountyDetail {
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
  submissionCid: string | null;
  claimedAt: string | null;
  submittedAt: string | null;
}

function normalise(b: GatewayBountyDetail): ExtendedBounty {
  return {
    ...b,
    creator: typeof b.creator === "object" ? b.creator : { id: b.creator },
    claimer: b.claimer ? (typeof b.claimer === "object" ? b.claimer : { id: b.claimer }) : null,
  };
}

export function useBountyDetail(bountyId: string | undefined) {
  const result = useGatewayQuery<GatewayBountyDetail | null>(
    ["bounty", bountyId ?? ""],
    `/v1/bounties/${bountyId}`,
    { enabled: !!bountyId, staleTime: 60_000 },
  );

  return {
    bounty: result.data ? normalise(result.data) : null,
    isLoading: result.isLoading,
  };
}
