/**
 * On-chain token balance hook — fetches NOOK, USDC, and ETH balances.
 *
 * Requires authentication (API key). Uses gatewayFetch for auth headers.
 */

import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { isAuthenticated } from "@/lib/authSession";

interface TokenBalance {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  balanceFormatted: string;
}

interface TokenBalanceResponse {
  address: string;
  eth: { balance: string; balanceFormatted: string };
  tokens: TokenBalance[];
  spenders: Record<string, string>;
}

export function useTokenBalances() {
  const hasKey = isAuthenticated();

  const result = useQuery<TokenBalanceResponse>({
    queryKey: ["token-balances"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/token/balance");
      if (!res.ok) throw new Error(`Gateway ${res.status}`);
      return res.json();
    },
    enabled: hasKey,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const nook = result.data?.tokens.find((t) => t.symbol === "NOOK") ?? null;
  const usdc = result.data?.tokens.find((t) => t.symbol === "USDC") ?? null;

  return {
    eth: result.data?.eth ?? null,
    nook,
    usdc,
    isLoading: result.isLoading,
    enabled: hasKey,
  };
}

export type { TokenBalance, TokenBalanceResponse };
