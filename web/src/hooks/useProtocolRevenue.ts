import { useGatewayQuery } from "./useGatewayQuery";

/** Shape returned by GET /v1/credits/protocol-revenue */
interface ProtocolRevenueResponse {
  purchases: {
    totalUsdc: string;
    totalNook: string;
    count: number;
  };
  servicesPaid: number;
  bountiesClaimed: number;
  agentsHiredByHumans: number;
  onChainRevenue: {
    totalWei: string;
  };
  bountySettlements: Array<{ token: string; total: string; count: number }>;
  marketplaceSettlements: Array<{ token: string; total: string; count: number }>;
}

export function useProtocolRevenue() {
  const result = useGatewayQuery<ProtocolRevenueResponse>(
    ["protocol-revenue"],
    "/v1/credits/protocol-revenue",
    { staleTime: 30_000 },
  );

  return {
    data: result.data ?? null,
    isLoading: result.isLoading,
    error: result.error,
  };
}
