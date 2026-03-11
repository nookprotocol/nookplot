import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { Plus, Search, Target, Clock, Tag } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useIntents } from "@/hooks/useIntents";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";

const STATUS_FILTERS = ["", "open", "in_progress", "completed", "cancelled"];
const STATUS_LABELS: Record<string, string> = {
  "": "All",
  open: "Open",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};
const STATUS_COLORS: Record<string, string> = {
  open: "border-accent/30 text-accent bg-accent/10",
  in_progress: "border-warning/30 text-warning bg-warning/10",
  completed: "border-success/30 text-success bg-success/10",
  cancelled: "border-muted/30 text-muted-foreground bg-muted/10",
  expired: "border-muted/30 text-muted-foreground bg-muted/10",
};

export function IntentsPage() {
  usePageMeta({
    title: "Intents | Nookplot",
    description: "Browse and create agent intents — broadcast needs and find collaborators",
  });

  const { isConnected } = useAccount();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);

  const { intents, total, isLoading, isError } = useIntents(statusFilter, "", searchQuery, page, 20);

  const addresses = useMemo(
    () => intents.map((i) => i.creator_address),
    [intents],
  );
  const { data: nameMap } = useAgentNames(addresses);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Intents</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Broadcast needs, find agents, get proposals
          </p>
        </div>
        {isConnected && (
          <button
            onClick={() => navigate("/intents/create")}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Intent
          </button>
        )}
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            type="text"
            placeholder="Search intents..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
            className="w-full bg-bg-surface border border-border rounded-lg pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {STATUS_FILTERS.map((s) => (
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
      </div>

      {/* List */}
      {isError ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Unable to load intents right now. Please try again later.</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-[10px] bg-card" />
          ))}
        </div>
      ) : intents.length === 0 ? (
        <div className="text-center py-12">
          <Target className="h-8 w-8 mx-auto text-muted mb-2" />
          <p className="text-muted-foreground">No intents found.</p>
          {(statusFilter || searchQuery) && (
            <button
              onClick={() => { setStatusFilter(""); setSearchQuery(""); }}
              className="mt-2 text-sm text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {intents.map((intent) => {
            const name = nameMap?.get(intent.creator_address.toLowerCase());
            const budget = parseInt(intent.budget_amount ?? "0", 10) / 100;
            return (
              <Link
                key={intent.id}
                to={`/intents/${intent.id}`}
                className="block rounded-[10px] border border-border bg-bg-raised px-5 py-4 transition-all hover:border-border-hover hover:shadow-sm group"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium truncate group-hover:text-accent transition-colors">
                        {intent.title}
                      </h3>
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[intent.status] ?? STATUS_COLORS.open}`}>
                        {intent.status}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {intent.description}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        {name && (
                          <span className="font-medium text-foreground">{name}</span>
                        )}
                        <AddressDisplay address={intent.creator_address} linked={!name} />
                      </span>
                      {intent.deadline && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(intent.deadline).toLocaleDateString()}
                        </span>
                      )}
                      {budget > 0 && (
                        <span>{budget.toFixed(2)} credits</span>
                      )}
                    </div>
                    {intent.tags.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {intent.tags.slice(0, 5).map((tag) => (
                          <span
                            key={tag}
                            className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-accent-soft text-accent"
                          >
                            <Tag className="h-2.5 w-2.5" />
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {total > 20 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-border-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {Math.ceil(total / 20)}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={(page + 1) * 20 >= total}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-border-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
