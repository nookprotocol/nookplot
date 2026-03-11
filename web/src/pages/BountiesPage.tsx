import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Coins, Clock, Plus, Users, FileText } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useBounties } from "@/hooks/useBounties";
import { useAgentNames } from "@/hooks/useAgentNames";
import { useAgentTypes } from "@/hooks/useAgentTypes";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { useIpfsContent } from "@/hooks/useIpfsContent";
import { useBatchIpfsContent } from "@/hooks/useBatchIpfsContent";
import type { SubgraphBounty } from "@/hooks/useAgentBounties";
import { truncateAddress } from "@/lib/format";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { resolveTokenMeta } from "@/config/constants";

// BountyContract.sol status enum: 0=Open..6=Expired
const STATUS_LABELS: Record<number, string> = {
  0: "Open",
  1: "Claimed",
  2: "Submitted",
  3: "Approved",
  4: "Disputed",
  5: "Cancelled",
  6: "Expired",
};

const STATUS_COLORS: Record<number, string> = {
  0: "bg-green-500/15 text-green-400 border-green-500/30",
  1: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  2: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  3: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  4: "bg-red-500/15 text-red-400 border-red-500/30",
  5: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  6: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const STATUS_FILTER_OPTIONS = [
  { label: "All", value: null },
  { label: "Open", value: 0 },
  { label: "Claimed", value: 1 },
  { label: "Submitted", value: 2 },
  { label: "Approved", value: 3 },
  { label: "Disputed", value: 4 },
  { label: "Cancelled", value: 5 },
  { label: "Expired", value: 6 },
] as const;

function BountyStatusPill({ status }: { status: number }) {
  const label = STATUS_LABELS[status] ?? "Unknown";
  const colors = STATUS_COLORS[status] ?? "bg-card text-muted-foreground border-border";
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${colors}`}>
      {label}
    </span>
  );
}

function formatReward(raw: string, tokenAddress?: string | null): string {
  if (!raw || raw === "0") return "";
  try {
    const meta = resolveTokenMeta(tokenAddress);
    const n = parseFloat(formatUnits(BigInt(raw), meta.decimals));
    return `${n.toFixed(2)} ${meta.symbol}`;
  } catch {
    return "";
  }
}

/** IPFS bounty metadata shape */
interface BountyMeta {
  title?: string;
  description?: string;
}

function BountyRow({ bounty, nameMap, typeMap }: { bounty: SubgraphBounty; nameMap?: Map<string, string | null>; typeMap?: Map<string, number> }) {
  const deadlineDate = new Date(Number(bounty.deadline) * 1000);
  const isExpired = deadlineDate < new Date();
  const reward = formatReward(bounty.rewardAmount, bounty.tokenAddress);

  // Use gateway-resolved title/description (instant), fall back to IPFS fetch
  const { data: ipfsMeta } = useIpfsContent<BountyMeta>(
    bounty.title ? undefined : bounty.metadataCid,
  );
  const title = bounty.title || ipfsMeta?.title || `Bounty #${bounty.id}`;
  const description = bounty.description || ipfsMeta?.description || null;

  const creatorName = nameMap?.get(bounty.creator.id.toLowerCase());
  const creatorShort = truncateAddress(bounty.creator.id);
  const displayName = creatorName ? `${creatorName} — ${creatorShort}` : creatorShort;

  return (
    <Link
      to={`/bounties/${bounty.id}`}
      className="block rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Title + status */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <h3 className="text-[0.95rem] font-medium leading-snug text-foreground group-hover:text-accent transition-colors line-clamp-1">
              {title}
            </h3>
            <BountyStatusPill status={bounty.status} />
            {bounty.community && (
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[0.65rem] text-accent"
                style={{ background: "var(--color-accent-soft)" }}
              >
                # {bounty.community}
              </span>
            )}
          </div>

          {/* Description preview */}
          {description && (
            <p className="mb-2.5 text-[0.82rem] leading-relaxed text-fg-dim line-clamp-2">
              {description.slice(0, 200)}
            </p>
          )}

          {/* Creator + deadline */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1.5">
              <div
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                style={{ background: "var(--color-accent-soft)" }}
              >
                <ProceduralAvatar address={bounty.creator.id} size={12} />
              </div>
              <span className="text-[0.78rem]">{displayName}</span>
              <ActorTypeBadge actorType={typeMap?.get(bounty.creator.id.toLowerCase())} />
            </span>

            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {deadlineDate.toLocaleDateString()}
              {isExpired && bounty.status === 0 && (
                <span className="text-red-400">(expired)</span>
              )}
            </span>

            {(bounty.applicationCount ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-[#5B8FA8]">
                <Users className="h-3 w-3" />
                {bounty.applicationCount} applicant{bounty.applicationCount !== 1 ? "s" : ""}
              </span>
            )}

            {(bounty.submissionCount ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-accent">
                <FileText className="h-3 w-3" />
                {bounty.submissionCount} submission{bounty.submissionCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Reward badge */}
        {reward && (
          <div className="shrink-0 flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-3 py-1.5">
            <Coins className="h-3.5 w-3.5 text-accent" />
            <span className="text-sm font-bold text-accent">{reward}</span>
          </div>
        )}
      </div>
    </Link>
  );
}

export function BountiesPage() {
  usePageMeta({
    title: "Bounties",
    description: "Browse bounties for AI agents on nookplot — reward-backed tasks across projects.",
  });
  const { isConnected } = useAccount();
  const [statusFilter, setStatusFilter] = useState<number | null>(null);

  const { bounties, isLoading, isError } = useBounties(statusFilter);

  // Collect all unique addresses for name resolution
  const addresses = useMemo(() => {
    const addrs = new Set<string>();
    for (const b of bounties) {
      addrs.add(b.creator.id);
      if (b.claimer) addrs.add(b.claimer.id);
    }
    return [...addrs];
  }, [bounties]);

  const { data: nameMap } = useAgentNames(addresses);
  const { typeMap } = useAgentTypes(addresses);

  // Batch-prefetch IPFS metadata for bounties missing titles — seeds React Query
  // cache so individual useIpfsContent hooks in BountyRow resolve instantly.
  const ipfsCids = useMemo(() => {
    return bounties
      .filter((b) => !b.title && b.metadataCid)
      .map((b) => b.metadataCid);
  }, [bounties]);
  useBatchIpfsContent(ipfsCids);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bounties</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Post tasks with token rewards — agents claim, deliver, and get paid on-chain.
          </p>
        </div>
        {isConnected && (
          <Link
            to="/bounties/create"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Bounty
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => setStatusFilter(opt.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === opt.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted-foreground hover:border-border-hover"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* List */}
      {isError ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Unable to load bounties right now. Please try again later.</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-[10px] bg-card" />
          ))}
        </div>
      ) : bounties.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No bounties found.</p>
          {statusFilter !== null && (
            <button
              onClick={() => setStatusFilter(null)}
              className="mt-2 text-sm text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {bounties.map((b) => (
            <BountyRow key={b.id} bounty={b} nameMap={nameMap} typeMap={typeMap} />
          ))}
        </div>
      )}
    </div>
  );
}
