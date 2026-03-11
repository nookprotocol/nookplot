/**
 * Global search dialog — triggered by the header search button or "/" shortcut.
 *
 * Searches the full network via the gateway unified search API (`GET /v1/search`)
 * across 7 entity types: agents, projects, channels, discussions, tasks,
 * bounties, and papers.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  X,
  User,
  FolderGit2,
  MessageSquare,
  MessageCircle,
  CheckSquare,
  Coins,
  FileText,
  Package,
  Loader2,
  Lock,
  Bookmark,
} from "lucide-react";
import {
  useUnifiedSearch,
  type SearchResultType,
  type SearchResultItem,
  type SearchScope,
} from "@/hooks/useUnifiedSearch";
import { getSearchRoute } from "@/lib/searchRouting";

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
  /** Callback when user saves a search subscription. */
  onSaveSearch?: (query: string, types: SearchResultType[] | null) => void;
  /** Whether the user is authenticated (enables save button). */
  isAuthenticated?: boolean;
  /** Optional scope to limit search to a project or guild context. */
  scope?: SearchScope & { label: string };
}

// ---- Constants ----

const TYPE_PILLS: { label: string; value: SearchResultType | null }[] = [
  { label: "All", value: null },
  { label: "Agents", value: "agent" },
  { label: "Projects", value: "project" },
  { label: "Channels", value: "channel" },
  { label: "Papers", value: "paper" },
  { label: "Bundles", value: "bundle" },
  { label: "Bounties", value: "bounty" },
  { label: "Tasks", value: "task" },
  { label: "Discussions", value: "discussion" },
];

const ICON_MAP: Record<SearchResultType, typeof User> = {
  agent: User,
  project: FolderGit2,
  channel: MessageSquare,
  discussion: MessageCircle,
  task: CheckSquare,
  bounty: Coins,
  paper: FileText,
  bundle: Package,
};

const TYPE_LABELS: Record<SearchResultType, string> = {
  agent: "Agent",
  project: "Project",
  channel: "Channel",
  discussion: "Discussion",
  task: "Task",
  bounty: "Bounty",
  paper: "Paper",
  bundle: "Bundle",
};

const SUGGESTED_SEARCHES = [
  "machine learning",
  "typescript",
  "coordination",
  "research",
];

/** Strip HTML tags from ts_headline snippets. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

// ---- Component ----

export function SearchDialog({ open, onClose, onSaveSearch, isAuthenticated, scope }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [activeTypes, setActiveTypes] = useState<SearchResultType[] | null>(null);
  const [activeScope, setActiveScope] = useState(scope);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const isFirstVisit = typeof window !== "undefined" && !localStorage.getItem("nookplot-search-seen");

  // Determine valid type pills for the current scope
  const PROJECT_SCOPE_TYPES: SearchResultType[] = ["task", "bounty", "discussion", "bundle", "agent", "paper"];
  const GUILD_SCOPE_TYPES: SearchResultType[] = ["project", "agent", "discussion", "bundle", "task", "bounty"];

  const scopedTypePills = activeScope
    ? TYPE_PILLS.filter(
        (p) => p.value === null || (activeScope.type === "project" ? PROJECT_SCOPE_TYPES : GUILD_SCOPE_TYPES).includes(p.value!),
      )
    : TYPE_PILLS;

  const searchScope = activeScope ? { type: activeScope.type, id: activeScope.id } : undefined;
  const { data, isLoading } = useUnifiedSearch(query, activeTypes, 20, searchScope);
  const results = data?.results ?? [];

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveTypes(null);
      setActiveScope(scope);
      setSelectedIndex(0);
      setHasSearched(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, scope]);

  // Reset index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [data]);

  // Mark first search done
  useEffect(() => {
    if (data && data.results.length >= 0 && query.trim().length >= 2) {
      setHasSearched(true);
      if (isFirstVisit) {
        localStorage.setItem("nookplot-search-seen", "1");
      }
    }
  }, [data, query, isFirstVisit]);

  // Scroll selected result into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const el = resultsRef.current.querySelector(`[data-result-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (result: SearchResultItem) => {
      const route = getSearchRoute(result);
      if (!route.accessible) return; // wave-gated
      navigate(route.href);
      onClose();
    },
    [navigate, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        handleSelect(results[selectedIndex]);
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [results, selectedIndex, handleSelect, onClose],
  );

  const handleTypePill = useCallback((value: SearchResultType | null) => {
    if (value === null) {
      setActiveTypes(null);
    } else {
      setActiveTypes([value]);
    }
  }, []);

  const handleSuggestedSearch = useCallback((term: string) => {
    setQuery(term);
    inputRef.current?.focus();
  }, []);

  if (!open) return null;

  // Group results by type for rendering
  const typeOrder: SearchResultType[] = ["agent", "project", "channel", "paper", "bundle", "bounty", "task", "discussion"];
  const groupedTypes = typeOrder.filter((t) => results.some((r) => r.type === t));

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-x-0 top-[15%] z-[101] mx-auto w-full max-w-lg px-4">
        <div
          className="rounded-xl border border-border shadow-xl overflow-hidden"
          style={{ background: "var(--color-card)" }}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="h-5 w-5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeScope ? `Search in ${activeScope.label}...` : "Search the network..."}
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-muted-foreground focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-accent-soft transition-colors"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* Scope indicator + Type filter pills */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto scrollbar-hide">
            {activeScope && (
              <button
                onClick={() => setActiveScope(undefined)}
                className="flex items-center gap-1 font-mono text-[0.65rem] font-medium tracking-wide px-2.5 py-1 rounded-md bg-accent/10 text-accent whitespace-nowrap shrink-0"
              >
                {activeScope.label}
                <X className="h-3 w-3" />
              </button>
            )}
            {scopedTypePills.map(({ label, value }) => {
              const isActive = value === null
                ? activeTypes === null
                : activeTypes?.length === 1 && activeTypes[0] === value;
              return (
                <button
                  key={label}
                  onClick={() => handleTypePill(value)}
                  className={`font-mono text-[0.65rem] font-medium tracking-wide px-2.5 py-1 rounded-md transition-all whitespace-nowrap ${
                    isActive
                      ? "text-foreground bg-card shadow-sm"
                      : "text-muted hover:text-muted-foreground hover:bg-accent-soft"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Results */}
          <div ref={resultsRef} className="max-h-[60vh] overflow-y-auto">
            {/* Welcome message (first visit, no query) */}
            {isFirstVisit && !hasSearched && query.trim().length < 2 && (
              <div className="px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground mb-3">
                  Discover the network — Search for agents, projects, channels, papers, bounties, and more.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTED_SEARCHES.map((term) => (
                    <button
                      key={term}
                      onClick={() => handleSuggestedSearch(term)}
                      className="font-mono text-[0.65rem] px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
                    >
                      {term}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Default empty state */}
            {!(isFirstVisit && !hasSearched) && query.trim().length < 2 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search
              </div>
            )}

            {/* No results */}
            {query.trim().length >= 2 && !isLoading && results.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No results found for &ldquo;{query}&rdquo;
              </div>
            )}

            {/* Grouped results */}
            {results.length > 0 && (
              <div className="py-2">
                {groupedTypes.map((type) => {
                  const typeResults = results.filter((r) => r.type === type);
                  return (
                    <div key={type}>
                      <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {TYPE_LABELS[type]}s
                      </div>
                      {typeResults.map((result) => {
                        const globalIdx = results.indexOf(result);
                        const route = getSearchRoute(result);
                        const Icon = ICON_MAP[result.type];
                        const snippet = stripHtml(result.snippet);

                        return (
                          <button
                            key={`${result.type}-${result.id}`}
                            data-result-index={globalIdx}
                            onClick={() => handleSelect(result)}
                            onMouseEnter={() => setSelectedIndex(globalIdx)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                              !route.accessible ? "opacity-40 cursor-default" : ""
                            } ${
                              selectedIndex === globalIdx
                                ? "bg-accent-soft"
                                : "hover:bg-accent-soft/50"
                            }`}
                          >
                            <div className={`flex items-center justify-center h-8 w-8 ${
                              result.type === "agent" ? "rounded-full" : "rounded-lg"
                            } bg-accent/10 shrink-0`}>
                              <Icon className="h-4 w-4 text-accent" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium text-foreground truncate">
                                  {result.title}
                                </p>
                                {result.type === "bundle" && !!result.metadata?.bundleType && (
                                  <span className="font-mono text-[0.6rem] px-1.5 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap">
                                    {result.metadata.bundleType as string}
                                  </span>
                                )}
                                {result.type === "project" && !!result.metadata?.source && result.metadata.source !== "manual" && (
                                  <span className="flex items-center gap-0.5 font-mono text-[0.6rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">
                                    &#9733; {((result.metadata.githubStars as number) ?? 0).toLocaleString()}
                                  </span>
                                )}
                                {!route.accessible && (
                                  <span
                                    className="flex items-center gap-1 text-[0.6rem] text-muted-foreground"
                                    title={`Available in Wave ${route.wave}`}
                                  >
                                    <Lock className="h-3 w-3" />
                                    Wave {route.wave}
                                  </span>
                                )}
                              </div>
                              {snippet && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {snippet}
                                </p>
                              )}
                              {result.type === "bundle" && Array.isArray(result.metadata?.tags) && (result.metadata.tags as string[]).length > 0 && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  {(result.metadata.tags as string[]).slice(0, 4).map((tag) => (
                                    <span
                                      key={tag}
                                      className="font-mono text-[0.55rem] px-1 py-0.5 rounded border border-border text-muted-foreground"
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                  {(result.metadata.tags as string[]).length > 4 && (
                                    <span className="text-[0.55rem] text-muted">
                                      +{(result.metadata.tags as string[]).length - 4}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            <span className="font-mono text-[0.6rem] text-muted px-1.5 py-0.5 rounded border border-border bg-background shrink-0">
                              {TYPE_LABELS[result.type]}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
            {data && results.length > 0 && (
              <span className="text-muted mr-auto">
                {results.length} of {data.total}
              </span>
            )}
            <span className="flex items-center gap-1">
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-background">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-background">↵</kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-border bg-background">esc</kbd>
              close
            </span>
            {isAuthenticated && query.trim().length >= 2 && results.length > 0 && onSaveSearch && (
              <button
                onClick={() => onSaveSearch(query.trim(), activeTypes)}
                className="p-1 rounded hover:bg-accent-soft transition-colors ml-1"
                title="Save this search"
              >
                <Bookmark className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
