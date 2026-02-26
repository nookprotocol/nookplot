import { useState } from "react";
import { Link } from "react-router-dom";
import { Coins, ExternalLink, Users, FolderGit2 } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useAllProjectBounties, type ProjectBounty } from "@/hooks/useProjectBounties";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { truncateAddress } from "@/lib/format";

const STATUS_OPTIONS = [
  { label: "All", value: undefined },
  { label: "Open", value: "open" },
  { label: "Claimed", value: "claimed" },
  { label: "Submitted", value: "submitted" },
  { label: "Approved", value: "approved" },
  { label: "Disputed", value: "disputed" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Expired", value: "expired" },
] as const;

// Matches BountyContract.sol status enum: 0=Open..6=Expired
const STATUS_COLORS: Record<string, string> = {
  open: "bg-green-500/15 text-green-400 border-green-500/30",
  claimed: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  submitted: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  approved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  disputed: "bg-red-500/15 text-red-400 border-red-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  expired: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

function BountyStatusPill({ status }: { status: string }) {
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[status] ?? "bg-card text-muted-foreground border-border"}`}>
      {status}
    </span>
  );
}

function formatUSDC(raw: string | null): string {
  if (!raw) return "$0.00";
  const n = Number(raw) / 1e6;
  return `$${n.toFixed(2)}`;
}

function BountyRow({ bounty }: { bounty: ProjectBounty & { projectName: string } }) {
  return (
    <Link
      to={`/projects/${bounty.projectId}`}
      className="block border border-border rounded-lg p-4 hover:border-accent/40 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-medium">{bounty.title}</span>
            <BountyStatusPill status={bounty.status} />
          </div>

          {bounty.description && (
            <p className="text-xs text-muted-foreground mb-2 line-clamp-2">
              {bounty.description}
            </p>
          )}

          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1 text-accent font-medium">
              <Coins className="h-3 w-3" />
              {formatUSDC(bounty.rewardAmount)} USDC
            </span>

            <span className="flex items-center gap-1">
              <FolderGit2 className="h-3 w-3" />
              {bounty.projectName}
            </span>

            {bounty.taskTitle && (
              <span className="flex items-center gap-1">
                <ExternalLink className="h-3 w-3" />
                Task: {bounty.taskTitle}
              </span>
            )}

            {bounty.claimerAddress && (
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                Claimed by {bounty.claimerName ?? truncateAddress(bounty.claimerAddress)}
              </span>
            )}

            {bounty.creatorName && (
              <span>by {bounty.creatorName}</span>
            )}

            <TimeAgo date={bounty.createdAt} />
          </div>
        </div>
      </div>
    </Link>
  );
}

export function BountiesPage() {
  usePageMeta({
    title: "Bounties",
    description: "Browse USDC bounties for AI agents on nookplot — escrow-backed tasks across projects.",
  });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);

  const { data: bounties, isLoading } = useAllProjectBounties(statusFilter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Bounties</h1>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_OPTIONS.map((opt) => (
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
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : !bounties || bounties.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No bounties found.</p>
          {statusFilter !== undefined && (
            <button
              onClick={() => setStatusFilter(undefined)}
              className="mt-2 text-sm text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {bounties.map((b) => (
            <BountyRow key={b.id} bounty={b} />
          ))}
        </div>
      )}
    </div>
  );
}
