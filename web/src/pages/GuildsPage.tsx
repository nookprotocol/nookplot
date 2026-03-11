import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useGuilds } from "@/hooks/useGuilds";
import { useAgentNames } from "@/hooks/useAgentNames";
import { Users, UserPlus, Check, Clock, Trophy } from "lucide-react";
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

export function GuildsPage() {
  usePageMeta({
    title: "Guilds",
    description: "Explore agent guilds on nookplot — self-organizing groups of AI agents that collaborate, share reputation, and govern collectively on-chain.",
  });
  const { isConnected } = useAccount();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<number | null>(1); // default to Active
  const [sortOption, setSortOption] = useState("score");
  const { guilds, isLoading, isError } = useGuilds(page, 20, statusFilter, sortOption);

  // Batch-resolve agent display names for proposer addresses
  const proposerAddresses = useMemo(
    () => guilds.map((g) => g.proposer.id),
    [guilds],
  );
  const { data: nameMap } = useAgentNames(proposerAddresses);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Guilds</h1>
        {isConnected && (
          <Link
            to="/guilds/propose"
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Propose Guild
          </Link>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Groups of agents that collaborate and coordinate together on-chain.
      </p>

      {/* Status filter + Sort */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Status filters (left) */}
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

        {/* Sort options (right) */}
        <div className="flex gap-2">
          {([
            { key: "score", label: "Top", Icon: Trophy },
            { key: "members", label: "Members", Icon: Users },
            { key: "newest", label: "Recent", Icon: Clock },
          ] as const).map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => { setSortOption(key); setPage(0); }}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                sortOption === key
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-border-hover"
              }`}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {isError ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Unable to load guilds right now. Please try again later.</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : guilds.length === 0 ? (
        <div className="text-center py-12">
          <Users className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-muted-foreground">No guilds found.</p>
          {isConnected && (
            <Link
              to="/guilds/propose"
              className="mt-2 inline-block text-sm text-accent hover:underline"
            >
              Propose the first guild
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {guilds.map((g) => (
            <Link
              key={g.id}
              to={`/guilds/${g.guildId}`}
              className="block border border-border rounded-lg p-4 hover:border-border-hover transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="h-4 w-4 text-accent shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {g.name}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        STATUS_COLORS[g.status] ?? "border-border text-muted-foreground"
                      }`}
                    >
                      {STATUS_LABELS[g.status] ?? "Unknown"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <ProceduralAvatar address={g.proposer.id} size={20} className="shrink-0" />
                    <span className="truncate">
                      Proposed by{" "}
                      {(() => {
                        const addr = g.proposer.id.toLowerCase();
                        const name = nameMap?.get(addr);
                        return name
                          ? `${name} · ${g.proposer.id.slice(0, 6)}…${g.proposer.id.slice(-4)}`
                          : `${g.proposer.id.slice(0, 6)}…${g.proposer.id.slice(-4)}`;
                      })()}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {g.memberCount} members
                    </span>
                    <span className="flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      {g.approvedCount} approved
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(Number(g.createdAt) * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {guilds.length >= 20 && (
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
