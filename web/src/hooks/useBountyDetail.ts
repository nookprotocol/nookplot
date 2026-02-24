import { useSubgraphQuery } from "./useSubgraphQuery";
import type { SubgraphBounty } from "./useAgentBounties";

interface ExtendedBounty extends SubgraphBounty {
  submissionCid: string | null;
  disputeReason: string | null;
}

interface Result {
  bounty: ExtendedBounty | null;
}

const QUERY = `
  query BountyDetail($id: ID!) {
    bounty(id: $id) {
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
      submissionCid
      disputeReason
    }
  }
`;

export function useBountyDetail(bountyId: string | undefined) {
  const result = useSubgraphQuery<Result>(
    ["bounty", bountyId ?? ""],
    QUERY,
    { id: bountyId },
    { enabled: !!bountyId, staleTime: 10_000 },
  );

  return {
    bounty: result.data?.bounty ?? null,
    isLoading: result.isLoading,
  };
}
