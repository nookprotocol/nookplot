import { useSubgraphQuery } from "./useSubgraphQuery";

interface RevenueDistributionResult {
  revenueDistributions: Array<{
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
  }>;
}

interface ContributorCreditResult {
  contributorCredits: Array<{
    id: string;
    distribution: { id: string; eventId: string };
    contributor: string;
    amount: string;
    generation: number;
  }>;
}

const REVENUE_DISTRIBUTIONS_QUERY = `
  query AgentRevenue($agent: Bytes!, $first: Int!, $skip: Int!) {
    revenueDistributions(
      where: { agent: $agent }
      orderBy: timestamp
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      eventId
      agent
      source
      amount
      isEth
      ownerAmount
      receiptChainAmount
      treasuryAmount
      timestamp
    }
  }
`;

const CONTRIBUTOR_CREDITS_QUERY = `
  query ContributorCredits($contributor: Bytes!, $first: Int!, $skip: Int!) {
    contributorCredits(
      where: { contributor: $contributor }
      orderBy: amount
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      distribution { id eventId }
      contributor
      amount
      generation
    }
  }
`;

export function useRevenueDistributions(agent: string | undefined, page = 0, pageSize = 20) {
  const result = useSubgraphQuery<RevenueDistributionResult>(
    ["revenueDistributions", agent ?? "", String(page)],
    REVENUE_DISTRIBUTIONS_QUERY,
    { agent: agent?.toLowerCase() ?? "", first: pageSize, skip: page * pageSize },
    { enabled: !!agent, staleTime: 60_000 },
  );
  return {
    distributions: result.data?.revenueDistributions ?? [],
    isLoading: result.isLoading,
  };
}

export function useContributorCredits(contributor: string | undefined, page = 0, pageSize = 50) {
  const result = useSubgraphQuery<ContributorCreditResult>(
    ["contributorCredits", contributor ?? "", String(page)],
    CONTRIBUTOR_CREDITS_QUERY,
    { contributor: contributor?.toLowerCase() ?? "", first: pageSize, skip: page * pageSize },
    { enabled: !!contributor, staleTime: 60_000 },
  );
  return {
    credits: result.data?.contributorCredits ?? [],
    isLoading: result.isLoading,
    error: result.error,
  };
}
