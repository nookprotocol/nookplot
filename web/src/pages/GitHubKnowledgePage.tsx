/**
 * GitHub Knowledge page.
 *
 * Four sections:
 * 1. Connect GitHub — OAuth button, shows connected username
 * 2. My Repos — List repos with checkboxes + "Import Selected"
 * 3. My Imported Projects — Cards with sync status
 * 4. Trending Repos — Paginated grid of auto-curated repos
 *
 * Route: /github
 *
 * @module pages/GitHubKnowledgePage
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Github,
  Star,
  GitFork,
  RefreshCw,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  useGitHubOAuthStatus,
  useGitHubRepos,
  useImportRepos,
  useTrendingRepos,
  useConnectGitHub,
  type GitHubRepo,
} from "@/hooks/useGitHubKnowledge";
import { isAuthenticated } from "@/lib/authSession";
import { usePageMeta } from "@/hooks/usePageMeta";

const CATEGORIES = [
  { label: "All", value: "" },
  { label: "AI", value: "ai" },
  { label: "ML", value: "ml" },
  { label: "LLM", value: "llm" },
  { label: "Agents", value: "agents" },
  { label: "Ethereum", value: "ethereum" },
  { label: "Web3", value: "web3" },
];

export function GitHubKnowledgePage() {
  usePageMeta({ title: "GitHub Knowledge | Nookplot" });

  const hasKey = isAuthenticated();
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(0);

  const oauthStatus = useGitHubOAuthStatus();
  const reposQuery = useGitHubRepos();
  const importMutation = useImportRepos();
  const connectMutation = useConnectGitHub();
  const trendingQuery = useTrendingRepos(category || undefined, page);

  const isConnected = oauthStatus.data?.connected ?? false;
  const username = oauthStatus.data?.username;

  function toggleRepo(fullName: string) {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }

  async function handleConnect() {
    try {
      const redirectUrl = await connectMutation.mutateAsync();
      // Validate redirect target before navigation (open redirect protection)
      const url = new URL(redirectUrl, window.location.origin);
      if (!["github.com", "www.github.com"].includes(url.hostname) && url.origin !== window.location.origin) {
        throw new Error("Unexpected redirect target");
      }
      window.location.href = redirectUrl;
    } catch {
      // Error handled by mutation state
    }
  }

  async function handleImport() {
    const repos = [...selectedRepos].map((fullName) => {
      const [owner, repo] = fullName.split("/");
      return { owner, repo };
    });
    try {
      await importMutation.mutateAsync(repos);
      setSelectedRepos(new Set());
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Github className="w-6 h-6" />
          GitHub Knowledge
        </h1>
        <p className="text-muted-foreground mt-1">
          Import your repos, discover trending AI projects, and track updates across the network.
        </p>
      </div>

      {/* Section 1: Connect GitHub */}
      {hasKey && (
        <section className="border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Connect GitHub</h2>
          {isConnected ? (
            <div className="flex items-center gap-2 text-green-600">
              <Check className="w-4 h-4" />
              <span>Connected as <strong>{username}</strong></span>
            </div>
          ) : (
            <div>
              <p className="text-muted-foreground text-sm mb-3">
                Connect your GitHub account to import repos and claim auto-curated projects.
              </p>
              <button
                onClick={handleConnect}
                disabled={connectMutation.isPending}
                className="px-4 py-2 bg-foreground text-background rounded-md hover:opacity-90 transition-opacity flex items-center gap-2"
              >
                {connectMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Github className="w-4 h-4" />
                )}
                Connect GitHub
              </button>
              {connectMutation.isError && (
                <p className="text-red-500 text-sm mt-2">Failed to start OAuth flow.</p>
              )}
            </div>
          )}
        </section>
      )}

      {/* Section 2: My Repos */}
      {hasKey && isConnected && (
        <section className="border rounded-lg p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">My Repos</h2>
            {selectedRepos.size > 0 && (
              <button
                onClick={handleImport}
                disabled={importMutation.isPending}
                className="px-4 py-2 bg-foreground text-background rounded-md hover:opacity-90 transition-opacity flex items-center gap-2 text-sm"
              >
                {importMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                Import Selected ({selectedRepos.size})
              </button>
            )}
          </div>

          {importMutation.isSuccess && (
            <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded p-3 mb-3 text-sm">
              Imported {importMutation.data?.filter((r) => r.isNew).length ?? 0} new projects.
            </div>
          )}

          {reposQuery.isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading repos...
            </div>
          )}

          {reposQuery.data?.repos && (
            <div className="grid gap-2 max-h-96 overflow-y-auto">
              {reposQuery.data.repos.map((repo: GitHubRepo) => (
                <label
                  key={repo.fullName}
                  className="flex items-center gap-3 p-3 rounded border cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedRepos.has(repo.fullName)}
                    onChange={() => toggleRepo(repo.fullName)}
                    className="rounded"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{repo.fullName}</div>
                    {repo.description && (
                      <div className="text-xs text-muted-foreground truncate">{repo.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                    {repo.language && <span>{repo.language}</span>}
                    <span className="flex items-center gap-1">
                      <Star className="w-3 h-3" />
                      {repo.stars}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Section 3: Trending Repos */}
      <section className="border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-3">Trending Repos</h2>

        {/* Category pills */}
        <div className="flex flex-wrap gap-2 mb-4">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              onClick={() => { setCategory(cat.value); setPage(0); }}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                category === cat.value
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {trendingQuery.isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading trending repos...
          </div>
        )}

        {trendingQuery.data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {trendingQuery.data.projects.map((project) => (
                <Link
                  key={project.project_id}
                  to={`/projects/${encodeURIComponent(project.project_id)}`}
                  className="block border rounded-lg p-4 hover:border-foreground/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{project.name}</div>
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {project.description || "No description"}
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 shrink-0 text-muted-foreground" />
                  </div>

                  <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Star className="w-3 h-3" />
                      {project.github_stars?.toLocaleString() ?? 0}
                    </span>
                    <span className="flex items-center gap-1">
                      <GitFork className="w-3 h-3" />
                      {project.github_forks?.toLocaleString() ?? 0}
                    </span>
                    {project.languages?.[0] && <span>{project.languages[0]}</span>}
                    {project.search_category && (
                      <span className="px-2 py-0.5 rounded-full bg-muted text-[10px] uppercase">
                        {project.search_category}
                      </span>
                    )}
                  </div>

                  {project.github_topics?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {project.github_topics.slice(0, 5).map((topic) => (
                        <span
                          key={topic}
                          className="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground"
                        >
                          {topic}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              ))}
            </div>

            {/* Pagination */}
            {trendingQuery.data.total > 20 && (
              <div className="flex items-center justify-center gap-4 mt-6">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-2 rounded hover:bg-muted disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-muted-foreground">
                  Page {page + 1} of {Math.ceil(trendingQuery.data.total / 20)}
                </span>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={(page + 1) * 20 >= trendingQuery.data.total}
                  className="p-2 rounded hover:bg-muted disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}

            {trendingQuery.data.projects.length === 0 && (
              <p className="text-muted-foreground text-center py-8">
                No trending repos found{category ? ` in ${category}` : ""}.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
