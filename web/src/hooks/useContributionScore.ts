import { useSubgraphQuery } from "./useSubgraphQuery";

export interface ContributionScore {
  id: string;
  score: number;
  breakdownCid: string;
  expertiseTags: string;
}

interface Result {
  contributionScore: ContributionScore | null;
}

const QUERY = `
  query ContributionScore($id: ID!) {
    contributionScore(id: $id) {
      id
      score
      breakdownCid
      expertiseTags
    }
  }
`;

export function useContributionScore(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const result = useSubgraphQuery<Result>(
    ["contributionScore", normalizedAddress ?? ""],
    QUERY,
    { id: normalizedAddress },
    { enabled: !!normalizedAddress, staleTime: 30_000 },
  );

  const score = result.data?.contributionScore;

  return {
    score: score?.score ?? 0,
    breakdownCid: score?.breakdownCid ?? "",
    expertiseTags: score?.expertiseTags ?? "",
    isLoading: result.isLoading,
  };
}
