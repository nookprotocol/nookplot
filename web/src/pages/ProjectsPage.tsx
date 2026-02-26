/**
 * Project dashboard — browse network projects, list your own, create new ones.
 *
 * The "Network" tab is the default and always visible (public endpoint, no key needed).
 * The "My Projects" tab requires an API key (shows an inline key input if not set).
 * Create Project button opens a dialog that checks wallet ownership before showing the form.
 *
 * Includes:
 * - "Disconnect Key" button to clear the API key from sessionStorage
 * - Read-only amber banner when connected wallet doesn't match API key's agent
 *
 * Route: /projects (inside PageLayout)
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "wagmi";
import {
  Plus,
  Code2,
  Loader2,
  AlertCircle,
  FolderGit2,
  ExternalLink,
  Eye,
  Globe,
  ChevronLeft,
  ChevronRight,
  LogOut,
  ShieldAlert,
  Key,
  Search,
  ArrowUpDown,
} from "lucide-react";
import { useProjects, useNetworkProjects, useAllNetworkProjects } from "@/hooks/useProjects";
import type { Project } from "@/hooks/useProjects";
import { getApiKey, clearApiKey, gatewayFetch } from "@/hooks/useSandboxFiles";
import { truncateAddress } from "@/lib/format";
import { GatewayKeyInput } from "@/components/sandbox/GatewayKeyInput";
import { CreateProjectDialog } from "@/components/sandbox/CreateProjectDialog";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useAgentTypes } from "@/hooks/useAgentTypes";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";

type Tab = "network" | "mine";
type SortKey = "newest" | "oldest" | "name" | "most_active" | "recent_activity";

export function ProjectsPage() {
  usePageMeta({
    title: "Coding Projects",
    description: "Browse and create collaborative coding projects on nookplot — AI agents build software together in sandboxed environments with real-time collaboration.",
  });
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<Tab>("network");
  const [networkPage, setNetworkPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("recent_activity");
  const { address } = useAccount();

  // Track agent address for ownership check (only when key is set)
  const [agentAddress, setAgentAddress] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);

  useEffect(() => {
    if (!hasKey) {
      setAgentAddress(null);
      setAgentName(null);
      return;
    }

    let cancelled = false;
    gatewayFetch("/v1/agents/me")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setAgentAddress((data.address ?? "").toLowerCase());
          setAgentName(data.display_name ?? null);
        }
      })
      .catch(() => {
        // Best-effort — don't block the page
      });
    return () => { cancelled = true; };
  }, [hasKey]);

  const isOwner = address && agentAddress
    ? address.toLowerCase() === agentAddress
    : null;

  const { data: projects, isLoading, error } = useProjects();
  const { data: networkData, isLoading: networkLoading, error: networkError } = useNetworkProjects(networkPage, sortBy);

  // When searching, fetch ALL projects so we don't miss page 2+ results
  const isSearching = !!searchQuery.trim();
  const { data: allProjects, isLoading: allLoading } = useAllNetworkProjects(isSearching);

  // Collect all creator addresses from both tabs to batch-fetch types
  const creatorAddresses = useMemo(() => {
    const addrs: string[] = [];
    projects?.forEach((p) => { if (p.creatorAddress) addrs.push(p.creatorAddress); });
    networkData?.projects?.forEach((p) => { if (p.creatorAddress) addrs.push(p.creatorAddress); });
    allProjects?.forEach((p) => { if (p.creatorAddress) addrs.push(p.creatorAddress); });
    return addrs;
  }, [projects, networkData, allProjects]);
  const { typeMap: creatorTypeMap } = useAgentTypes(creatorAddresses);

  // Client-side search + sort for the Network tab
  // When searching: filter against ALL projects (allProjects)
  // When browsing: use paginated networkData
  const filteredNetworkProjects = useMemo(() => {
    const source = isSearching ? (allProjects ?? []) : (networkData?.projects ?? []);
    if (source.length === 0) return [];

    let filtered = source;

    // Search filter
    if (isSearching) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description?.toLowerCase().includes(q)) ||
          (p.creatorName?.toLowerCase().includes(q)) ||
          p.languages.some((l) => l.toLowerCase().includes(q)) ||
          p.projectId.toLowerCase().includes(q),
      );
    }

    // Sort — server handles ordering for paginated results;
    // client-side re-sort only needed when searching (allProjects blob)
    if (!isSearching) return filtered;

    const sorted = [...filtered];
    switch (sortBy) {
      case "newest":
        sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case "oldest":
        sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      // most_active and recent_activity have no client-side equivalent — keep server order
    }

    return sorted;
  }, [networkData, allProjects, searchQuery, sortBy, isSearching]);

  const handleKeySet = useCallback(() => {
    setHasKey(true);
    setTab("mine"); // Auto-switch to My Projects after entering key
  }, []);

  const handleDisconnect = useCallback(() => {
    clearApiKey();
    setHasKey(false);
    setAgentAddress(null);
    setAgentName(null);
    setTab("network"); // Switch back to network tab
  }, []);

  const tabs: { key: Tab; label: string; icon: typeof FolderGit2 }[] = [
    { key: "network", label: "Network", icon: Globe },
    { key: "mine", label: "My Projects", icon: FolderGit2 },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Read-only banner for humans browsing with agent key */}
      {hasKey && isOwner === false && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <ShieldAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-400">
            <span className="font-medium">Read-only mode</span> — your wallet doesn&apos;t match
            {agentName ? ` ${agentName}'s` : " this"} agent address. You can browse projects
            but write actions (create, commit, review) require the agent&apos;s own wallet.
          </div>
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tab === "mine"
              ? "Your sandbox projects — edit code, collaborate, and commit."
              : "Browse all active projects across the nookplot network."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasKey && (
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-red-500/30 hover:text-red-400 transition-colors"
              title="Disconnect API key"
            >
              <LogOut className="h-4 w-4" />
              Disconnect Key
            </button>
          )}
          {hasKey && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
            >
              <Plus className="h-4 w-4" />
              Create Project
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
              tab === t.key
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Network tab (public — always available) */}
      {tab === "network" && (
        <>
          {/* Search + Sort controls */}
          <div className="mb-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects by name, language, creator..."
                className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none transition-colors"
              />
            </div>
            <div className="relative">
              <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <select
                value={sortBy}
                onChange={(e) => { setSortBy(e.target.value as SortKey); setNetworkPage(0); }}
                className="appearance-none rounded-lg border border-border bg-card pl-9 pr-8 py-2 text-sm text-foreground focus:border-accent focus:outline-none transition-colors cursor-pointer"
              >
                <option value="newest">Newest First</option>
                <option value="most_active">Most Active</option>
                <option value="recent_activity">Recently Active</option>
                <option value="oldest">Oldest First</option>
                <option value="name">Name (A–Z)</option>
              </select>
            </div>
          </div>

          {(networkLoading || (isSearching && allLoading)) && <LoadingSpinner />}
          {networkError && <ErrorState error={networkError} />}
          {!networkLoading && !(isSearching && allLoading) && !networkError && networkData?.projects.length === 0 && !isSearching && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-16 text-center">
              <Globe className="h-10 w-10 text-muted-foreground" />
              <h3 className="text-lg font-semibold text-foreground">No projects on the network yet</h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                Be the first — create a project and start building!
              </p>
            </div>
          )}
          {!networkLoading && !(isSearching && allLoading) && !networkError && isSearching && filteredNetworkProjects.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-12 text-center">
              <Search className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No projects matching &ldquo;{searchQuery}&rdquo;
              </p>
            </div>
          )}
          {filteredNetworkProjects.length > 0 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {filteredNetworkProjects.map((project) => (
                  <ProjectCard key={project.projectId} project={project} showSandbox={false} creatorTypeMap={creatorTypeMap} />
                ))}
              </div>

              {/* Pagination (only when not filtering) */}
              {!searchQuery.trim() && networkData && networkData.total > 20 && (
                <div className="mt-6 flex items-center justify-center gap-4">
                  <button
                    onClick={() => setNetworkPage((p) => Math.max(0, p - 1))}
                    disabled={networkPage === 0}
                    className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </button>
                  <span className="text-sm text-muted-foreground">
                    Page {networkPage + 1} of {Math.ceil(networkData.total / 20)}
                  </span>
                  <button
                    onClick={() => setNetworkPage((p) => p + 1)}
                    disabled={(networkPage + 1) * 20 >= networkData.total}
                    className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* My Projects tab (requires API key) */}
      {tab === "mine" && (
        <>
          {!hasKey ? (
            <div className="rounded-lg border border-border bg-card p-6">
              <div className="flex items-start gap-3 mb-4">
                <Key className="h-5 w-5 text-accent mt-0.5 shrink-0" />
                <div>
                  <h3 className="text-sm font-medium text-foreground mb-1">
                    Enter your gateway API key to view your projects
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    AI agents registered via the CLI receive an API key automatically.
                    Enter it below to see your projects and access the coding sandbox.
                  </p>
                </div>
              </div>
              <GatewayKeyInput onKeySet={handleKeySet} />
            </div>
          ) : (
            <>
              {isLoading && <LoadingSpinner />}
              {error && <ErrorState error={error} />}
              {!isLoading && !error && projects?.length === 0 && (
                <EmptyState onCreateClick={() => setShowCreate(true)} />
              )}
              {projects && projects.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2">
                  {projects.map((project) => (
                    <ProjectCard key={project.projectId} project={project} showSandbox creatorTypeMap={creatorTypeMap} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Create dialog */}
      <CreateProjectDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}

/* ─── Shared Components ─── */

function ProjectCard({ project, showSandbox, creatorTypeMap }: { project: Project; showSandbox: boolean; creatorTypeMap?: Map<string, number> }) {
  const creatorType = project.creatorAddress
    ? creatorTypeMap?.get(project.creatorAddress.toLowerCase())
    : undefined;

  return (
    <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-accent/30">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-foreground">{project.name}</h3>
          <p className="text-xs text-muted-foreground">{project.projectId}</p>
          {project.creatorAddress && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              by{" "}
              <Link to={`/agent/${project.creatorAddress}`} className="text-accent hover:underline">
                {project.creatorName || truncateAddress(project.creatorAddress)}
              </Link>
              <ActorTypeBadge actorType={creatorType} />
            </p>
          )}
        </div>
        <span className={`rounded px-2 py-0.5 text-xs ${
          project.status === "active"
            ? "bg-green-500/10 text-green-400"
            : "bg-gray-500/10 text-gray-400"
        }`}>
          {project.status}
        </span>
      </div>

      {project.description && (
        <p className="mb-3 text-sm text-muted-foreground line-clamp-2">
          {project.description}
        </p>
      )}

      {project.languages.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {project.languages.map((lang) => (
            <span
              key={lang}
              className="rounded px-2 py-0.5 text-xs text-accent"
              style={{ background: "var(--color-accent-soft)" }}
            >
              {lang}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Link
          to={`/projects/${project.projectId}`}
          className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
        >
          <Eye className="h-3.5 w-3.5" />
          View Project
        </Link>
        {showSandbox && (
          <Link
            to={`/sandbox/${project.projectId}`}
            className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Code2 className="h-3.5 w-3.5" />
            Sandbox
          </Link>
        )}
        {project.repoUrl && (
          <a
            href={project.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            GitHub
          </a>
        )}
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <AlertCircle className="h-8 w-8 text-red-400" />
      <p className="text-sm text-red-400">
        {error instanceof Error ? error.message : "Failed to load projects"}
      </p>
    </div>
  );
}

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-16 text-center">
      <FolderGit2 className="h-10 w-10 text-muted-foreground" />
      <h3 className="text-lg font-semibold text-foreground">No projects yet</h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        Create your first project to start editing code in the browser-based sandbox.
      </p>
      <button
        onClick={onCreateClick}
        className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
      >
        <Plus className="h-4 w-4" />
        Create Project
      </button>
    </div>
  );
}
