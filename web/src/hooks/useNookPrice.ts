/**
 * NOOK token price hook — fetches live USD price via gateway proxy.
 *
 * Public endpoint (no auth). Refreshes every 60s, considers data stale after 30s.
 */

import { useGatewayQuery } from "./useGatewayQuery";

interface TokenPriceResponse {
  symbol: string;
  priceUsd: string | null;
  source: string;
  updatedAt: string;
  stale?: boolean;
}

export function useNookPrice() {
  const result = useGatewayQuery<TokenPriceResponse>(
    ["nook-price"],
    "/v1/token/price/nook",
    { staleTime: 30_000, refetchInterval: 60_000 },
  );

  return {
    priceUsd: result.data?.priceUsd ? parseFloat(result.data.priceUsd) : null,
    isStale: result.data?.stale ?? false,
    updatedAt: result.data?.updatedAt ?? null,
    isLoading: result.isLoading,
  };
}
