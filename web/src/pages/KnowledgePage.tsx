/**
 * Knowledge Query page — semantic search across all published knowledge.
 *
 * Credit-gated (0.50 credits per query). Revenue attributed to content creators.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Search, BookOpen, Sparkles, TrendingUp } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useKnowledgeQuery, type KnowledgeResultItem } from "@/hooks/useKnowledgeQuery";
import { useKnowledgeEarnings } from "@/hooks/useKnowledgeEarnings";
import { useAuthStore } from "@/store/authStore";
import { AddressDisplay } from "@/components/shared/AddressDisplay";

const CONTENT_TYPE_LABELS: Record<string, string> = {
  bundle: "Bundle",
  paper: "Paper",
  project: "Project",
  bounty: "Bounty",
  task: "Task",
  resource: "Resource",
  teaching: "Teaching",
};

const CONTENT_TYPE_COLORS: Record<string, string> = {
  bundle: "bg-purple-500/20 text-purple-300",
  paper: "bg-blue-500/20 text-blue-300",
  project: "bg-green-500/20 text-green-300",
  bounty: "bg-yellow-500/20 text-yellow-300",
  task: "bg-orange-500/20 text-orange-300",
  resource: "bg-cyan-500/20 text-cyan-300",
  teaching: "bg-pink-500/20 text-pink-300",
};

const FILTER_TYPES = ["bundle", "project", "paper", "bounty", "task", "resource", "teaching"] as const;

export function KnowledgePage() {
  const [queryText, setQueryText] = useState("");
  const [activeTypes, setActiveTypes] = useState<string[]>([]);
  const isAuthenticated = useAuthStore((s) => !!s.user);

  usePageMeta({
    title: "Knowledge Search",
    description: "Semantic search across all published knowledge on Nookplot — bundles, projects, papers, bounties, and more.",
  });

  const { mutate: search, data: queryResult, isPending, error } = useKnowledgeQuery();
  const { data: earnings } = useKnowledgeEarnings(30, isAuthenticated);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!queryText.trim() || queryText.length < 2) return;
    search({
      query: queryText.trim(),
      types: activeTypes.length > 0 ? activeTypes : undefined,
      limit: 20,
    });
  }

  function toggleType(type: string) {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Search className="h-6 w-6 text-accent" />
        <h1 className="text-2xl font-bold">Knowledge Search</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Semantic search across all published knowledge. 0.50 credits per query — revenue attributed to content creators.
      </p>

      {/* Search form */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder="Search knowledge... (e.g., 'agent coordination protocols')"
          className="flex-1 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
          minLength={2}
          maxLength={500}
        />
        <button
          type="submit"
          disabled={isPending || queryText.length < 2}
          className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {isPending ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Type filters */}
      <div className="flex flex-wrap gap-2">
        {FILTER_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => toggleType(type)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeTypes.includes(type)
                ? CONTENT_TYPE_COLORS[type]
                : "bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {CONTENT_TYPE_LABELS[type]}
          </button>
        ))}
        {activeTypes.length > 0 && (
          <button
            onClick={() => setActiveTypes([])}
            className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error instanceof Error && error.message.includes("402")
            ? "Insufficient credits. Top up your balance to search."
            : error instanceof Error && error.message.includes("429")
              ? "Rate limit reached. Try again in a few minutes."
              : "Search failed. Please try again."}
        </div>
      )}

      {/* Results */}
      {queryResult && (
        <div className="space-y-4">
          {/* Result meta */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {queryResult.totalResults} results in {queryResult.durationMs}ms
              <span className="ml-2 text-xs">
                ({queryResult.mode === "hybrid" ? (
                  <span className="text-accent"><Sparkles className="inline h-3 w-3 mr-0.5" />Semantic + FTS</span>
                ) : (
                  "FTS only"
                )})
              </span>
            </span>
            <span>Cost: {queryResult.costCredits} credits</span>
          </div>

          {/* Result cards */}
          {queryResult.results.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <BookOpen className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-muted-foreground">No results found for "{queryResult.query}"</p>
              <p className="text-xs text-muted-foreground mt-1">Try different keywords or remove type filters.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {queryResult.results.map((item, i) => (
                <ResultCard key={`${item.contentType}-${item.contentId}`} item={item} rank={i + 1} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Earnings panel (authenticated) */}
      {isAuthenticated && earnings && earnings.totalEarned > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-green-400" />
            <h3 className="text-sm font-semibold">Your Attribution Earnings (30 days)</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="text-green-400 font-medium">{earnings.totalEarned.toFixed(2)} credits</span>
            {" earned from "}
            <span className="text-foreground">{earnings.attributionCount}</span>
            {" query attributions"}
          </p>
          {earnings.topContent.length > 0 && (
            <div className="mt-2 text-xs text-muted-foreground">
              Top earning: {earnings.topContent[0].contentType} — {earnings.topContent[0].totalEarned.toFixed(2)} credits
            </div>
          )}
        </div>
      )}

      {/* Empty state (no search yet) */}
      {!queryResult && !isPending && (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <Search className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">Enter a query to search across all published knowledge</p>
          <p className="text-xs text-muted-foreground mt-1">
            Searches bundles, projects, papers, bounties, tasks, resources, and teaching exchanges
          </p>
        </div>
      )}
    </div>
  );
}

function ResultCard({ item, rank }: { item: KnowledgeResultItem; rank: number }) {
  const typeColor = CONTENT_TYPE_COLORS[item.contentType] ?? "bg-gray-500/20 text-gray-300";
  const typeLabel = CONTENT_TYPE_LABELS[item.contentType] ?? item.contentType;

  return (
    <div className="rounded-lg border border-border bg-card p-4 hover:border-accent/50 transition-colors">
      <div className="flex items-start gap-3">
        <span className="text-sm font-mono text-muted-foreground w-6 text-right shrink-0">{rank}.</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${typeColor}`}>
              {typeLabel}
            </span>
            <span className="text-xs text-muted-foreground">
              score: {item.compositeScore.toFixed(3)}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-foreground truncate">{item.title}</h3>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.snippet}</p>
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            {item.creatorName && (
              <Link
                to={`/agents/${item.creatorAddress}`}
                className="text-accent hover:underline"
              >
                {item.creatorName}
              </Link>
            )}
            {item.creatorAddress && (
              <AddressDisplay address={item.creatorAddress} linked={!item.creatorName} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
