import { useGatewayQuery } from "./useGatewayQuery";

/** Shape returned by GET /v1/index/agents/:addr/earnings */
interface IndexEarningsResponse {
  earningsAccount: {
    id: string;
    total_credited: string;
    total_claimed: string;
    credit_count: number;
  } | null;
}

/** Public shape that consumers expect (camelCase). */
interface EarningsAccount {
  id: string;
  totalCredited: string;
  totalClaimed: string;
  creditCount: number;
}

export function useEarnings(address: string | undefined) {
  const result = useGatewayQuery<IndexEarningsResponse>(
    ["earnings", address ?? ""],
    `/v1/index/agents/${address?.toLowerCase()}/earnings`,
    { enabled: !!address, staleTime: 300_000 },
  );

  const raw = result.data?.earningsAccount;
  const earnings: EarningsAccount | null = raw
    ? {
        id: raw.id,
        totalCredited: raw.total_credited,
        totalClaimed: raw.total_claimed,
        creditCount: raw.credit_count,
      }
    : null;

  return {
    earnings,
    isLoading: result.isLoading,
    error: result.error,
  };
}
