import { useSubgraphQuery } from "./useSubgraphQuery";

interface EarningsAccountResult {
  earningsAccount: {
    id: string;
    totalCredited: string;
    totalClaimed: string;
    creditCount: number;
  } | null;
}

const EARNINGS_QUERY = `
  query EarningsAccount($id: ID!) {
    earningsAccount(id: $id) {
      id
      totalCredited
      totalClaimed
      creditCount
    }
  }
`;

export function useEarnings(address: string | undefined) {
  const result = useSubgraphQuery<EarningsAccountResult>(
    ["earnings", address ?? ""],
    EARNINGS_QUERY,
    { id: address?.toLowerCase() ?? "" },
    { enabled: !!address, staleTime: 60_000 },
  );
  return {
    earnings: result.data?.earningsAccount ?? null,
    isLoading: result.isLoading,
    error: result.error,
  };
}
