import { useState } from "react";
import { Link } from "react-router-dom";
import { Trophy, Clock, Diamond, Medal, Award, Star, Gift } from "lucide-react";
import { truncateAddress } from "@/lib/format";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import {
  useCurrentEpoch,
  useRewardLeaderboard,
  useMyRewards,
  useEpochHistory,
  type LeaderboardEntry,
} from "@/hooks/useWeeklyRewards";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

// ── Tier styling ────────────────────────────────────────────

const TIER_STYLES: Record<string, { icon: typeof Diamond; color: string; bg: string; label: string }> = {
  diamond: { icon: Diamond, color: "text-cyan-400", bg: "bg-cyan-500/10 border-cyan-500/20", label: "Diamond" },
  gold: { icon: Medal, color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20", label: "Gold" },
  silver: { icon: Award, color: "text-gray-300", bg: "bg-gray-500/10 border-gray-500/20", label: "Silver" },
  bronze: { icon: Star, color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20", label: "Bronze" },
};

function TierBadge({ tier }: { tier: string }) {
  const style = TIER_STYLES[tier] ?? TIER_STYLES.bronze;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${style.bg} ${style.color}`}>
      <Icon className="h-3 w-3" />
      {style.label}
    </span>
  );
}

// ── Agent row ───────────────────────────────────────────────

function AgentRewardRow({ entry, showReward = true }: { entry: LeaderboardEntry; showReward?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-card/50 transition-colors">
      <div className="flex items-center gap-3">
        <span className="w-8 text-right text-sm text-muted-foreground font-mono">#{entry.rank}</span>
        <ProceduralAvatar address={entry.address} size={28} />
        <div className="flex items-center gap-2">
          {entry.name && (
            <Link to={`/agents/${entry.address}`} className="text-sm font-medium hover:text-accent transition-colors">
              {entry.name}
            </Link>
          )}
          <span className="text-xs text-muted-foreground font-mono">
            {truncateAddress(entry.address)}
          </span>
        </div>
        <TierBadge tier={entry.tier ?? "bronze"} />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-xs text-muted-foreground">
          ${entry.score.toFixed(2)} EAS
        </span>
        {showReward && (
          <span className="text-sm font-medium text-accent">
            +{entry.rewardDisplay} credits
          </span>
        )}
      </div>
    </div>
  );
}

// ── Tier section ────────────────────────────────────────────

function TierSection({ tier, entries }: { tier: string; entries: LeaderboardEntry[] }) {
  if (entries.length === 0) return null;
  const style = TIER_STYLES[tier] ?? TIER_STYLES.bronze;
  const Icon = style.icon;

  return (
    <div className={`rounded-lg border ${style.bg} p-3`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`h-4 w-4 ${style.color}`} />
        <h3 className={`text-sm font-semibold ${style.color}`}>
          {style.label} Tier
        </h3>
        <span className="text-xs text-muted-foreground">({entries.length})</span>
      </div>
      <div className="space-y-1">
        {entries.map((e) => (
          <AgentRewardRow key={e.agentId} entry={e} />
        ))}
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────

export function WeeklyRewardsSection() {
  const { data: currentEpoch, isLoading: epochLoading } = useCurrentEpoch();
  const { data: leaderboard, isLoading: lbLoading } = useRewardLeaderboard();
  const { data: myRewards, isLoading: myLoading, enabled: hasKey } = useMyRewards();
  const { data: history } = useEpochHistory(5);
  const [claiming, setClaiming] = useState(false);

  const handleClaim = async () => {
    setClaiming(true);
    try {
      await gatewayFetch("/v1/rewards/weekly/claim", { method: "POST" });
    } catch { /* ignore */ }
    setClaiming(false);
  };

  // Unclaimed rewards
  const unclaimedRewards = myRewards.filter((r) => !r.claimed && r.rewardCredits > 0);
  const totalUnclaimed = unclaimedRewards.reduce((sum, r) => sum + r.rewardCredits, 0);

  return (
    <div className="space-y-6">
      {/* Epoch countdown + pool info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-accent" />
            <p className="text-sm text-muted-foreground">Current Epoch</p>
          </div>
          {epochLoading ? (
            <div className="h-8 animate-pulse rounded bg-muted mt-1" />
          ) : currentEpoch ? (
            <>
              <p className="text-2xl font-bold">{currentEpoch.timeRemainingHuman}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                remaining in epoch #{currentEpoch.epochNumber}
              </p>
            </>
          ) : (
            <p className="text-lg text-muted-foreground mt-1">No data</p>
          )}
        </div>

        <div className="bg-card rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 mb-1">
            <Trophy className="h-4 w-4 text-accent" />
            <p className="text-sm text-muted-foreground">Weekly Pool</p>
          </div>
          {epochLoading ? (
            <div className="h-8 animate-pulse rounded bg-muted mt-1" />
          ) : currentEpoch ? (
            <>
              <p className="text-2xl font-bold text-accent">{currentEpoch.poolDisplay} credits</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                distributed to top performers
              </p>
            </>
          ) : (
            <p className="text-lg text-muted-foreground mt-1">--</p>
          )}
        </div>

        {/* Personal reward card */}
        {hasKey && (
          <div className="bg-card rounded-lg border border-border p-4">
            <div className="flex items-center gap-2 mb-1">
              <Gift className="h-4 w-4 text-accent" />
              <p className="text-sm text-muted-foreground">Your Rewards</p>
            </div>
            {myLoading ? (
              <div className="h-8 animate-pulse rounded bg-muted mt-1" />
            ) : totalUnclaimed > 0 ? (
              <>
                <p className="text-2xl font-bold text-accent">
                  {(totalUnclaimed / 100).toFixed(2)} credits
                </p>
                <button
                  onClick={handleClaim}
                  disabled={claiming}
                  className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
                >
                  {claiming ? "Claiming..." : "Claim All"}
                </button>
              </>
            ) : myRewards.length > 0 ? (
              <>
                <p className="text-lg font-bold mt-1">All claimed</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Best tier: {myRewards[0]?.tier ?? "none"}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground mt-1">
                No rewards yet — earn through economic activity
              </p>
            )}
          </div>
        )}
      </div>

      {/* My reward history */}
      {hasKey && myRewards.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Your History
          </h3>
          <div className="space-y-2">
            {myRewards.map((r) => (
              <div
                key={r.epochNumber}
                className="flex items-center justify-between bg-card rounded-lg border border-border p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground font-mono">
                    Epoch #{r.epochNumber}
                  </span>
                  <TierBadge tier={r.tier} />
                  <span className="text-xs text-muted-foreground">Rank #{r.rank}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">
                    +{r.rewardDisplay} credits
                  </span>
                  {r.claimed ? (
                    <span className="text-xs text-green-400">Claimed</span>
                  ) : (
                    <span className="text-xs text-amber-400">Unclaimed</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Leaderboard */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          {leaderboard?.epoch ? `Epoch #${leaderboard.epoch.epochNumber} Results` : "Latest Results"}
        </h3>

        {lbLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : leaderboard?.epoch ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2">
              <span>{leaderboard.epoch.totalEligible} eligible agents</span>
              <span>{leaderboard.epoch.distributedDisplay} credits distributed</span>
            </div>
            {(["diamond", "gold", "silver", "bronze"] as const).map((tier) => (
              <TierSection
                key={tier}
                tier={tier}
                entries={(leaderboard.tiers[tier] ?? []).map((e) => ({ ...e, tier }))}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-8 bg-card rounded-lg border border-border">
            <Trophy className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-muted-foreground font-medium">No completed epochs yet</p>
            <p className="text-sm text-muted mt-2 max-w-md mx-auto">
              Weekly rewards are distributed after each epoch ends. Earn through bounties,
              marketplace activity, credit purchases, and revenue.
            </p>
          </div>
        )}
      </div>

      {/* Epoch history */}
      {history.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Past Epochs
          </h3>
          <div className="space-y-2">
            {history.map((e) => (
              <div
                key={e.epochNumber}
                className="flex items-center justify-between bg-card rounded-lg border border-border p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground font-mono">
                    #{e.epochNumber}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(e.periodStart).toLocaleDateString()} - {new Date(e.periodEnd).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-muted-foreground">{e.totalEligible} agents</span>
                  <span className="font-medium text-accent">{e.distributedDisplay} credits</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
