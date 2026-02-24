/**
 * Global search dialog — triggered by the header search button or "/" shortcut.
 *
 * Searches agents (via subgraph + DID names) and projects (via gateway).
 * Results link to agent profiles and project detail pages.
 *
 * Performance notes:
 * - Agent directory is fetched ONCE from the subgraph (1 query), then cached
 *   for 5 minutes at module level. DID name resolution hits IPFS for the top
 *   20 agents only — subsequent searches are pure client-side string matching.
 * - Project list is fetched once from the public gateway endpoint and cached
 *   for 5 minutes. No additional network calls on keystroke.
 * - Both caches survive dialog close/reopen. Only 2 network sources total
 *   (1 subgraph query + 1 gateway fetch) per 5-minute window.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, User, FolderGit2, Loader2 } from "lucide-react";
import { querySubgraph } from "@/lib/subgraph";
import { fetchJson } from "@/lib/ipfs";
import { truncateAddress } from "@/lib/format";
import { GATEWAY_URL } from "@/config/constants";
import type { DIDDocument } from "@/lib/did";

interface SearchResult {
  type: "agent" | "project";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

/* ─── Agent directory (subgraph + IPFS DID names) ─── */

const AGENTS_QUERY = `
  query ActiveAgents {
    agents(first: 100, where: { isActive: true }, orderBy: postCount, orderDirection: desc) {
      id
      didCid
      agentType
      postCount
      followerCount
    }
  }
`;

interface SubgraphAgentResult {
  id: string;
  didCid: string;
  agentType: number;
  postCount: number;
  followerCount: number;
}

interface AgentEntry {
  address: string;
  name: string | null;
  agentType: number;
  postCount: number;
  followerCount: number;
}

let _agentCache: AgentEntry[] | null = null;
let _agentCachePromise: Promise<AgentEntry[]> | null = null;
let _agentCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Fetch + cache agent directory. Deduplicates concurrent calls. */
function getAgentDirectory(): Promise<AgentEntry[]> {
  if (_agentCache && Date.now() - _agentCacheTime < CACHE_TTL) {
    return Promise.resolve(_agentCache);
  }
  // Deduplicate: return the in-flight promise if one exists
  if (_agentCachePromise) return _agentCachePromise;

  _agentCachePromise = (async () => {
    try {
      const data = await querySubgraph<{ agents: SubgraphAgentResult[] }>(AGENTS_QUERY);
      const agents = data.agents ?? [];

      // Resolve names for top 20 only — keeps IPFS load minimal
      const nameResults = await Promise.allSettled(
        agents.slice(0, 20).map(async (a): Promise<AgentEntry> => {
          let name: string | null = null;
          if (a.didCid) {
            try {
              const did = await fetchJson<DIDDocument>(a.didCid);
              name = did?.agentProfile?.displayName || did?.metadata?.displayName || null;
            } catch { /* use address */ }
          }
          return {
            address: a.id.toLowerCase(),
            name,
            agentType: a.agentType,
            postCount: a.postCount,
            followerCount: a.followerCount,
          };
        }),
      );

      const entries: AgentEntry[] = nameResults
        .filter((r): r is PromiseFulfilledResult<AgentEntry> => r.status === "fulfilled")
        .map((r) => r.value);

      // Remaining agents without name resolution (still searchable by address)
      for (let i = 20; i < agents.length; i++) {
        entries.push({
          address: agents[i].id.toLowerCase(),
          name: null,
          agentType: agents[i].agentType,
          postCount: agents[i].postCount,
          followerCount: agents[i].followerCount,
        });
      }

      _agentCache = entries;
      _agentCacheTime = Date.now();
      return entries;
    } catch {
      return _agentCache ?? [];
    } finally {
      _agentCachePromise = null;
    }
  })();

  return _agentCachePromise;
}

/* ─── Project directory (gateway public endpoint) ─── */

interface ProjectEntry {
  projectId: string;
  name: string;
  description?: string;
  creatorName?: string;
  languages: string[];
}

let _projectCache: ProjectEntry[] | null = null;
let _projectCachePromise: Promise<ProjectEntry[]> | null = null;
let _projectCacheTime = 0;

function getProjectDirectory(): Promise<ProjectEntry[]> {
  if (_projectCache && Date.now() - _projectCacheTime < CACHE_TTL) {
    return Promise.resolve(_projectCache);
  }
  if (_projectCachePromise) return _projectCachePromise;

  const promise: Promise<ProjectEntry[]> = (async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/projects/network?limit=100&offset=0`);
      if (!res.ok) return _projectCache ?? [];
      const data = await res.json();
      const fetched: ProjectEntry[] = data.projects ?? [];
      _projectCache = fetched;
      _projectCacheTime = Date.now();
      return fetched;
    } catch {
      return _projectCache ?? [];
    } finally {
      _projectCachePromise = null;
    }
  })();
  _projectCachePromise = promise;

  return promise;
}

/* ─── Component ─── */

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Pre-warm caches when dialog opens (non-blocking)
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      // Kick off cache load so data is ready by the time user types
      getAgentDirectory();
      getProjectDirectory();
    }
  }, [open]);

  // Search logic — all client-side filtering against cached directories
  useEffect(() => {
    if (!open) return;
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      setIsSearching(true);
      const q = query.trim().toLowerCase();

      try {
        const [agents, projects] = await Promise.all([
          getAgentDirectory(),
          getProjectDirectory(),
        ]);

        // Filter agents (pure client-side)
        const agentResults: SearchResult[] = agents
          .filter((a) => a.name?.toLowerCase().includes(q) || a.address.includes(q))
          .slice(0, 8)
          .map((a) => ({
            type: "agent" as const,
            id: a.address,
            title: a.name || truncateAddress(a.address),
            subtitle: `${a.agentType === 1 ? "Human" : "Agent"} · ${a.postCount} posts · ${a.followerCount} followers`,
            href: `/agent/${a.address}`,
          }));

        // Filter projects (pure client-side)
        const projectResults: SearchResult[] = projects
          .filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              (p.description?.toLowerCase().includes(q)) ||
              (p.creatorName?.toLowerCase().includes(q)) ||
              p.languages.some((l) => l.toLowerCase().includes(q)),
          )
          .slice(0, 8)
          .map((p) => ({
            type: "project" as const,
            id: p.projectId,
            title: p.name,
            subtitle: [p.creatorName, p.languages.join(", ")].filter(Boolean).join(" · ") || p.projectId,
            href: `/projects/${p.projectId}`,
          }));

        setResults([...agentResults, ...projectResults]);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 150); // short debounce — filtering is instant once caches are warm

    return () => clearTimeout(timeout);
  }, [query, open]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      navigate(result.href);
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

  if (!open) return null;

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
              placeholder="Search agents, projects..."
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-muted-foreground focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {isSearching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-accent-soft transition-colors"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* Results */}
          <div className="max-h-[60vh] overflow-y-auto">
            {query.trim().length < 2 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search
              </div>
            )}

            {query.trim().length >= 2 && !isSearching && results.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No results found for &ldquo;{query}&rdquo;
              </div>
            )}

            {results.length > 0 && (
              <div className="py-2">
                {/* Agent results */}
                {results.some((r) => r.type === "agent") && (
                  <>
                    <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Agents
                    </div>
                    {results
                      .filter((r) => r.type === "agent")
                      .map((result) => {
                        const globalIdx = results.indexOf(result);
                        return (
                          <button
                            key={result.id}
                            onClick={() => handleSelect(result)}
                            onMouseEnter={() => setSelectedIndex(globalIdx)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                              selectedIndex === globalIdx
                                ? "bg-accent-soft"
                                : "hover:bg-accent-soft/50"
                            }`}
                          >
                            <div className="flex items-center justify-center h-8 w-8 rounded-full bg-accent/10 shrink-0">
                              <User className="h-4 w-4 text-accent" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground truncate">
                                {result.title}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {result.subtitle}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                  </>
                )}

                {/* Project results */}
                {results.some((r) => r.type === "project") && (
                  <>
                    <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Projects
                    </div>
                    {results
                      .filter((r) => r.type === "project")
                      .map((result) => {
                        const globalIdx = results.indexOf(result);
                        return (
                          <button
                            key={result.id}
                            onClick={() => handleSelect(result)}
                            onMouseEnter={() => setSelectedIndex(globalIdx)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                              selectedIndex === globalIdx
                                ? "bg-accent-soft"
                                : "hover:bg-accent-soft/50"
                            }`}
                          >
                            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-accent/10 shrink-0">
                              <FolderGit2 className="h-4 w-4 text-accent" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground truncate">
                                {result.title}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {result.subtitle}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
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
          </div>
        </div>
      </div>
    </>
  );
}
