import { useGatewayQuery } from "./useGatewayQuery";

/** Shape returned by GET /v1/index/agents/:addr/revenue */
interface IndexRevenueResponse {
  revenueDistributions: Array<{
    id: string;
    event_id: string;
    agent: string;
    source: string;
    amount: string;
    is_eth: boolean;
    owner_amount: string;
    receipt_chain_amount: string;
    treasury_amount: string;
    timestamp: string;
  }>;
}

/** Shape returned by GET /v1/index/agents/:addr/credits */
interface IndexCreditsResponse {
  contributorCredits: Array<{
    id: string;
    distribution_id: string;
    distribution_event_id: string;
    contributor: string;
    amount: string;
    generation: number;
  }>;
}

/** Public camelCase types that consumers expect. */
interface RevenueDistribution {
  id: string;
  eventId: string;
  agent: string;
  source: string;
  amount: string;
  isEth: boolean;
  ownerAmount: string;
  receiptChainAmount: string;
  treasuryAmount: string;
  timestamp: string;
}

interface ContributorCredit {
  id: string;
  distribution: { id: string; eventId: string };
  contributor: string;
  amount: string;
  generation: number;
}

export function useRevenueDistributions(agent: string | undefined, page = 0, pageSize = 20) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));

  const result = useGatewayQuery<IndexRevenueResponse>(
    ["revenueDistributions", agent ?? "", String(page)],
    `/v1/index/agents/${agent?.toLowerCase()}/revenue?${params}`,
    { enabled: !!agent, staleTime: 300_000 },
  );

  const distributions: RevenueDistribution[] = (result.data?.revenueDistributions ?? []).map((r) => ({
    id: r.id,
    eventId: r.event_id,
    agent: r.agent,
    source: r.source,
    amount: r.amount,
    isEth: r.is_eth,
    ownerAmount: r.owner_amount,
    receiptChainAmount: r.receipt_chain_amount,
    treasuryAmount: r.treasury_amount,
    timestamp: r.timestamp,
  }));

  return {
    distributions,
    isLoading: result.isLoading,
  };
}

export function useContributorCredits(contributor: string | undefined, page = 0, pageSize = 50) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));

  const result = useGatewayQuery<IndexCreditsResponse>(
    ["contributorCredits", contributor ?? "", String(page)],
    `/v1/index/agents/${contributor?.toLowerCase()}/credits?${params}`,
    { enabled: !!contributor, staleTime: 300_000 },
  );

  const credits: ContributorCredit[] = (result.data?.contributorCredits ?? []).map((c) => ({
    id: c.id,
    distribution: { id: c.distribution_id, eventId: c.distribution_event_id },
    contributor: c.contributor,
    amount: c.amount,
    generation: c.generation,
  }));

  return {
    credits,
    isLoading: result.isLoading,
    error: result.error,
  };
}
