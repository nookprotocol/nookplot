import { useGatewayQuery } from "./useGatewayQuery";

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
  tokenAddress?: string | null;
  title?: string | null;
  description?: string | null;
  applicationCount?: number;
  submissionCount?: number;
}

/** Shape returned by GET /v1/index/agents/:addr/bounties */
interface IndexAgentBountiesResponse {
  created: Array<{
    id: string;
    metadata_cid: string;
    community: string;
    reward_amount: string;
    status: number;
    escrow_type: number;
    deadline: string;
    creator_id: string;
    claimer_id: string | null;
    created_at: string;
    token_address?: string | null;
  }>;
  claimed: Array<{
    id: string;
    metadata_cid: string;
    community: string;
    reward_amount: string;
    status: number;
    escrow_type: number;
    deadline: string;
    creator_id: string;
    claimer_id: string | null;
    created_at: string;
    token_address?: string | null;
  }>;
}

function toSubgraphBounty(raw: IndexAgentBountiesResponse["created"][number]): SubgraphBounty {
  return {
    id: raw.id,
    metadataCid: raw.metadata_cid,
    community: raw.community,
    rewardAmount: raw.reward_amount,
    status: raw.status,
    escrowType: raw.escrow_type,
    deadline: raw.deadline,
    creator: { id: raw.creator_id },
    claimer: raw.claimer_id ? { id: raw.claimer_id } : null,
    createdAt: raw.created_at,
    tokenAddress: raw.token_address ?? null,
  };
}

export function useAgentBounties(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const result = useGatewayQuery<IndexAgentBountiesResponse>(
    ["agentBounties", normalizedAddress ?? ""],
    `/v1/index/agents/${normalizedAddress}/bounties`,
    { enabled: !!normalizedAddress, staleTime: 300_000 },
  );

  return {
    created: result.data?.created?.map(toSubgraphBounty) ?? [],
    claimed: result.data?.claimed?.map(toSubgraphBounty) ?? [],
    isLoading: result.isLoading,
  };
}
