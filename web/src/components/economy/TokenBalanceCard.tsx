/**
 * Token balance overview card — shows NOOK, USDC, and ETH wallet balances
 * with USD conversion for NOOK via DexScreener price.
 */

import { Coins, Plus, Check } from "lucide-react";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useNookPrice } from "@/hooks/useNookPrice";
import { useAddNookToWallet } from "@/hooks/useAddNookToWallet";
import { nookToUsd } from "@/lib/format";

export function TokenBalanceCard() {
  const { nook, usdc, eth, isLoading, enabled } = useTokenBalances();
  const { priceUsd: nookPriceUsd } = useNookPrice();
  const { addToWallet, isPending, isSuccess, enabled: walletReady } = useAddNookToWallet();

  // USD value of NOOK balance
  const nookUsdDisplay = nook ? nookToUsd(nook.balance, nookPriceUsd) : null;

  return (
    <div className="bg-card rounded-lg border border-border p-4">
      <div className="flex items-center gap-2 mb-1">
        <Coins className="h-4 w-4 text-accent" />
        <p className="text-sm text-muted-foreground">Token Balances</p>
      </div>

      {!enabled ? (
        <p className="text-sm text-muted-foreground mt-2">Connect API key to view</p>
      ) : isLoading ? (
        <div className="h-8 animate-pulse rounded bg-muted mt-1" />
      ) : (
        <div className="mt-1 space-y-1">
          {/* NOOK — primary */}
          <div className="flex items-baseline justify-between">
            <span className="text-lg font-bold text-accent">
              {nook ? parseFloat(nook.balanceFormatted).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">NOOK</span>
              {walletReady && (
                <button
                  onClick={addToWallet}
                  disabled={isPending || isSuccess}
                  title={isSuccess ? "NOOK added to wallet" : "Add NOOK to wallet"}
                  className="text-muted-foreground hover:text-accent transition-colors disabled:opacity-50"
                >
                  {isSuccess ? <Check className="h-3 w-3 text-emerald-400" /> : <Plus className="h-3 w-3" />}
                </button>
              )}
            </div>
          </div>
          {nookUsdDisplay && (
            <p className="text-xs text-muted-foreground -mt-0.5">{nookUsdDisplay}</p>
          )}

          {/* USDC */}
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">
              {usdc ? parseFloat(usdc.balanceFormatted).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"}
            </span>
            <span className="text-xs text-muted-foreground">USDC</span>
          </div>

          {/* ETH */}
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">
              {eth ? parseFloat(eth.balanceFormatted).toFixed(6) : "0"}
            </span>
            <span className="text-xs text-muted-foreground">ETH</span>
          </div>
        </div>
      )}
    </div>
  );
}
