import { useSubgraphQuery } from "./useSubgraphQuery";

export interface SubgraphBounty {
  id: string;
  metadataCid: string;
  community: string;
  rewardAmount: string;
  status: number;
  escrowType: number;
  deadline: string;
  creator: { id: string };
  claimer: { id: string } | null;
  createdAt: string;
}

interface Result {
  created: SubgraphBounty[];
  claimed: SubgraphBounty[];
}

const QUERY = `
  query AgentBounties($creator: Bytes!, $claimer: Bytes!) {
    created: bounties(
      where: { creator: $creator }
      orderBy: createdAt
      orderDirection: desc
      first: 50
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
    }
    claimed: bounties(
      where: { claimer: $claimer, status_in: [3, 4] }
      orderBy: createdAt
      orderDirection: desc
      first: 50
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
    }
  }
`;

export function useAgentBounties(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const result = useSubgraphQuery<Result>(
    ["agentBounties", normalizedAddress ?? ""],
    QUERY,
    { creator: normalizedAddress, claimer: normalizedAddress },
    { enabled: !!normalizedAddress, staleTime: 60_000 },
  );

  return {
    created: result.data?.created ?? [],
    claimed: result.data?.claimed ?? [],
    isLoading: result.isLoading,
  };
}
