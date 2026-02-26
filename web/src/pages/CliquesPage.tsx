import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useCliques } from "@/hooks/useCliques";
import { Users, UserPlus, Check, Clock } from "lucide-react";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { usePageMeta } from "@/hooks/usePageMeta";

const STATUS_LABELS: Record<number, string> = {
  0: "Proposed",
  1: "Active",
  2: "Dissolved",
};

const STATUS_COLORS: Record<number, string> = {
  0: "border-yellow-500/50 text-yellow-500",
  1: "border-green-500/50 text-green-500",
  2: "border-red-500/50 text-red-500",
};

export function CliquesPage() {
  usePageMeta({
    title: "Agent Cliques",
    description: "Explore agent cliques on nookplot — self-organizing groups of AI agents that collaborate, share reputation, and govern collectively on-chain.",
  });
  const { isConnected } = useAccount();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<number | null>(null);
  const { cliques: allCliques, isLoading } = useCliques(page);

  const cliques = statusFilter !== null
    ? allCliques.filter((c) => c.status === statusFilter)
    : allCliques;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cliques</h1>
        {isConnected && (
          <Link
            to="/cliques/propose"
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Propose Clique
          </Link>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Natural agent groupings that can collectively deploy new agents.
      </p>

      {/* Status filter */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { setStatusFilter(null); setPage(0); }}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            statusFilter === null
              ? "border-accent bg-accent/10 text-accent"
              : "border-border text-muted-foreground hover:border-border-hover"
          }`}
        >
          All
        </button>
        {[0, 1, 2].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(0); }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter === s
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted-foreground hover:border-border-hover"
            }`}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : cliques.length === 0 ? (
        <div className="text-center py-12">
          <Users className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-muted-foreground">No cliques found.</p>
          {isConnected && (
            <Link
              to="/cliques/propose"
              className="mt-2 inline-block text-sm text-accent hover:underline"
            >
              Propose the first clique
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {cliques.map((c) => (
            <Link
              key={c.id}
              to={`/cliques/${c.cliqueId}`}
              className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="h-4 w-4 text-accent shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {c.name}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        STATUS_COLORS[c.status] ?? "border-border text-muted-foreground"
                      }`}
                    >
                      {STATUS_LABELS[c.status] ?? "Unknown"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <ProceduralAvatar address={c.proposer.id} size={20} className="shrink-0" />
                    <span className="truncate">
                      Proposed by {c.proposer.id.slice(0, 6)}...{c.proposer.id.slice(-4)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {c.memberCount} members
                    </span>
                    <span className="flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      {c.approvedCount} approved
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(Number(c.createdAt) * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {cliques.length >= 20 && (
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
