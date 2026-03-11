/**
 * Merkle NOOK reward display — claimable amounts and per-epoch history.
 *
 * Shows on-chain NOOK/WETH token rewards distributed via Merkle proofs,
 * separate from the off-chain credit rewards in WeeklyRewardsSection.
 */

import { useState } from "react";
import { Trophy, Coins, Calendar, TrendingUp, Plus, Check } from "lucide-react";
import { useMerkleClaimable, useMerkleHistory, type MerkleHistoryEntry } from "@/hooks/useMerkleRewards";
import { useNookPrice } from "@/hooks/useNookPrice";
import { useAddNookToWallet } from "@/hooks/useAddNookToWallet";
import { formatNook, nookToUsd } from "@/lib/format";
import { formatUnits } from "viem";

// ── Pool type badge ───────────────────────────────────────

function PoolBadge({ poolType }: { poolType: string }) {
  const isNook = poolType.toLowerCase() === "nook";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        isNook
          ? "bg-accent/10 border-accent/20 text-accent"
          : "bg-amber-500/10 border-amber-500/20 text-amber-400"
      }`}
    >
      {isNook ? "NOOK" : "WETH"}
    </span>
  );
}

// ── History row ───────────────────────────────────────────

function RewardRow({ entry, nookPriceUsd }: { entry: MerkleHistoryEntry; nookPriceUsd: number | null }) {
  const isNook = entry.poolType.toLowerCase() === "nook";
  const decimals = isNook ? 18 : 18; // Both NOOK and WETH are 18 decimals
  const formatted = Number(formatUnits(BigInt(entry.epochAmount), decimals));
  const usdDisplay = isNook ? nookToUsd(entry.epochAmount, nookPriceUsd) : null;

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-card/50 transition-colors">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground font-mono w-16">
          Epoch #{entry.epochNumber}
        </span>
        <PoolBadge poolType={entry.poolType} />
        <span className="text-xs text-muted-foreground">
          {new Date(entry.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          +{formatted.toLocaleString(undefined, { maximumFractionDigits: 2 })} {isNook ? "NOOK" : "WETH"}
        </span>
        {usdDisplay && (
          <span className="text-xs text-muted-foreground">{usdDisplay}</span>
        )}
      </div>
    </div>
  );
}

// ── Filter ────────────────────────────────────────────────

type PoolFilter = "all" | "nook" | "weth";

// ── Main component ────────────────────────────────────────

export function MerkleRewardsSection({ address }: { address: string | undefined }) {
  const { claimable, isLoading: claimLoading } = useMerkleClaimable(address);
  const { rewards, isLoading: historyLoading } = useMerkleHistory(address);
  const { priceUsd: nookPriceUsd } = useNookPrice();
  const { addToWallet, isPending: addPending, isSuccess: addSuccess, enabled: walletReady } = useAddNookToWallet();
  const [filter, setFilter] = useState<PoolFilter>("all");

  const filteredRewards = rewards.filter((r) => {
    if (filter === "all") return true;
    return r.poolType.toLowerCase() === filter;
  });

  const nookClaimable = claimable.nook;
  const latestNookReward = rewards.find((r) => r.poolType.toLowerCase() === "nook");
  const totalEpochs = new Set(rewards.map((r) => r.epochNumber)).size;

  const isLoading = claimLoading || historyLoading;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* NOOK Claimable */}
        <div className="bg-card rounded-lg border border-border p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-accent" />
              <p className="text-sm text-muted-foreground">NOOK Claimable</p>
            </div>
            {walletReady && (
              <button
                onClick={addToWallet}
                disabled={addPending || addSuccess}
                title={addSuccess ? "NOOK added to wallet" : "Add NOOK to wallet"}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-accent transition-colors disabled:opacity-50"
              >
                {addSuccess ? <Check className="h-3 w-3 text-emerald-400" /> : <Plus className="h-3 w-3" />}
                {addSuccess ? "Added" : "Add to wallet"}
              </button>
            )}
          </div>
          {isLoading ? (
            <div className="h-8 animate-pulse rounded bg-muted mt-1" />
          ) : nookClaimable ? (
            <>
              <p className="text-2xl font-bold text-accent">
                {formatNook(nookClaimable.cumulativeAmount)}
              </p>
              {nookPriceUsd && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {nookToUsd(nookClaimable.cumulativeAmount, nookPriceUsd)}
                </p>
              )}
            </>
          ) : (
            <p className="text-lg text-muted-foreground mt-1">0 NOOK</p>
          )}
        </div>

        {/* Latest epoch reward */}
        <div className="bg-card rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-4 w-4 text-accent" />
            <p className="text-sm text-muted-foreground">Latest Epoch</p>
          </div>
          {isLoading ? (
            <div className="h-8 animate-pulse rounded bg-muted mt-1" />
          ) : latestNookReward ? (
            <>
              <p className="text-2xl font-bold">
                {formatNook(latestNookReward.epochAmount)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Epoch #{latestNookReward.epochNumber}
                {nookPriceUsd && ` \u00B7 ${nookToUsd(latestNookReward.epochAmount, nookPriceUsd)}`}
              </p>
            </>
          ) : (
            <p className="text-lg text-muted-foreground mt-1">No rewards yet</p>
          )}
        </div>

        {/* Total epochs */}
        <div className="bg-card rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 mb-1">
            <Calendar className="h-4 w-4 text-accent" />
            <p className="text-sm text-muted-foreground">Total Epochs</p>
          </div>
          {isLoading ? (
            <div className="h-8 animate-pulse rounded bg-muted mt-1" />
          ) : (
            <>
              <p className="text-2xl font-bold">{totalEpochs}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {rewards.length} total distributions
              </p>
            </>
          )}
        </div>
      </div>

      {/* Reward history */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Token Reward History
          </h3>
          <div className="flex gap-1">
            {(["all", "nook", "weth"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  filter === f
                    ? "bg-accent/15 text-accent border border-accent/25"
                    : "text-muted-foreground hover:text-foreground border border-transparent"
                }`}
              >
                {f === "all" ? "All" : f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : filteredRewards.length === 0 ? (
          <div className="text-center py-8 bg-card rounded-lg border border-border">
            <Trophy className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-muted-foreground font-medium">No token rewards yet</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              NOOK token rewards are distributed weekly to top-performing agents
              via on-chain Merkle proofs.
            </p>
          </div>
        ) : (
          <div className="space-y-1 bg-card rounded-lg border border-border p-2">
            {filteredRewards.map((entry) => (
              <RewardRow
                key={`${entry.poolType}-${entry.epochNumber}`}
                entry={entry}
                nookPriceUsd={nookPriceUsd}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
