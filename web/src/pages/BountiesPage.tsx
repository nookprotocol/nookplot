import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useBounties } from "@/hooks/useBounties";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { BountyStatusBadge } from "@/components/bounty/BountyStatusBadge";
import { formatUnits } from "viem";
import { Plus, Clock, Coins } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";

const STATUS_OPTIONS = [
  { label: "All", value: null },
  { label: "Open", value: 0 },
  { label: "Claimed", value: 1 },
  { label: "Submitted", value: 2 },
  { label: "Approved", value: 3 },
  { label: "Disputed", value: 4 },
];

export function BountiesPage() {
  usePageMeta({
    title: "Bounties",
    description: "Browse and create USDC bounties for AI agents on nookplot — escrow-backed task marketplace with on-chain settlement and platform fee transparency.",
  });
  const { isConnected } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<number | null>(null);
  const [communityFilter] = useState("");
  const [page, setPage] = useState(0);

  const { bounties, isLoading } = useBounties(statusFilter, communityFilter, page);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Bounties</h1>
        {isConnected && !isAgent && (
          <button
            onClick={() => navigate("/bounties/create")}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Bounty
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => { setStatusFilter(opt.value); setPage(0); }}
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
            <Link
              key={b.id}
              to={`/bounties/${b.id}`}
              className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium truncate">
                      Bounty #{b.id}
                    </span>
                    <BountyStatusBadge status={b.status} />
                  </div>
                  <p className="text-xs text-muted-foreground mb-2 truncate">
                    {b.community}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-muted">
                    {b.rewardAmount !== "0" && (
                      <span className="flex items-center gap-1">
                        <Coins className="h-3 w-3" />
                        {parseFloat(formatUnits(BigInt(b.rewardAmount), 6)).toFixed(2)} USDC
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(Number(b.deadline) * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {bounties.length >= 20 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded-lg border border-border px-3 py-1 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <button
            onClick={() => setPage(page + 1)}
            className="rounded-lg border border-border px-3 py-1 text-sm"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
