/**
 * Modal dialog for creating a new sandbox project.
 *
 * Before showing the form, checks whether the connected wallet matches
 * the API key's agent address (via GET /v1/agents/me). If the wallet
 * doesn't match (i.e. a human browsing with an agent's key), the dialog
 * shows a friendly "Agent-only feature" explainer instead of a form that
 * would inevitably fail at the relay step.
 *
 * Supports 3 collaboration modes:
 *  - Solo: standard project creation, manage collaborators manually
 *  - Auto Team: AI finds best matches by skill after creation
 *  - Guild: all guild members auto-join as editors
 *
 * Styled using brand kit CSS variables (--color-card, --color-border, --color-accent, etc.)
 */

import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { X, Loader2, Plus, AlertCircle, Bot, ShieldAlert, Search, User, Sparkles, Users, Check } from "lucide-react";
import { useAccount } from "wagmi";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { useCreateProject } from "@/hooks/useProjects";
import type { SimilarProject, DiscoverResult } from "@/hooks/useProjects";
import { useAgentGuilds, useGuild } from "@/hooks/useGuilds";
import { useAgentNames } from "@/hooks/useAgentNames";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { isAuthenticated } from "@/lib/authSession";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { truncateAddress } from "@/lib/format";

type CollabMode = "solo" | "auto_team" | "guild";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const hasApiKey = isAuthenticated();
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [languages, setLanguages] = useState("");

  // Discovery state
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);
  const [similarProjects, setSimilarProjects] = useState<SimilarProject[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Collaboration mode
  const [collabMode, setCollabMode] = useState<CollabMode>("solo");
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [postCreateStatus, setPostCreateStatus] = useState<string | null>(null);

  // Ownership check: does the connected wallet match the API key's agent address?
  const [walletOwnsKey, setWalletOwnsKey] = useState<boolean | null>(null);
  const [agentAddress, setAgentAddress] = useState<string | null>(null);

  // Fetch user's guilds for guild mode selector
  const { memberships } = useAgentGuilds(address);
  const approvedGuilds = memberships.filter((m) => m.status === 2);

  // Fetch selected guild's members for the preview
  const { guild: selectedGuild } = useGuild(selectedGuildId ?? undefined);
  const acceptedMembers = (selectedGuild?.members ?? []).filter((m) => m.status === 2);
  // Exclude self from the member preview
  const otherMembers = acceptedMembers.filter(
    (m) => m.member.id.toLowerCase() !== (address?.toLowerCase() ?? ""),
  );

  // Batch-resolve member names
  const memberAddresses = otherMembers.map((m) => m.member.id);
  const { data: memberNames } = useAgentNames(memberAddresses);

  useEffect(() => {
    if (!open || !hasApiKey) {
      setWalletOwnsKey(null);
      setAgentAddress(null);
      return;
    }

    let cancelled = false;

    async function fetchAgentAddress() {
      try {
        const res = await gatewayFetch("/v1/agents/me");
        const data = await res.json();
        if (cancelled) return;
        const agAddr = (data.address ?? "").toLowerCase();
        setAgentAddress(agAddr);
        if (address) {
          setWalletOwnsKey(address.toLowerCase() === agAddr);
        } else {
          // No wallet connected — can't sign
          setWalletOwnsKey(false);
        }
      } catch {
        if (!cancelled) setWalletOwnsKey(null);
      }
    }

    fetchAgentAddress();
    return () => { cancelled = true; };
  }, [open, hasApiKey, address]);

  if (!open) return null;

  // Agent wallet — block project creation
  if (isAgent) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Create Project</h2>
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-bg-surface hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="rounded-full bg-amber-500/10 p-3">
              <Bot className="h-8 w-8 text-amber-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-1">Agent wallet detected</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Agent wallets cannot create projects through the web UI. Use the runtime SDK or CLI to perform agent actions.
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Still loading ownership check
  if (walletOwnsKey === null && hasApiKey) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Checking permissions...</p>
        </div>
      </div>
    );
  }

  // Wallet doesn't match API key's agent — show agent-only screen
  if (walletOwnsKey === false && hasApiKey) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Create Project</h2>
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-bg-surface hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="rounded-full bg-amber-500/10 p-3">
              <Bot className="h-8 w-8 text-amber-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-1">Agent-only feature</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Project creation requires the agent&apos;s own wallet to sign the on-chain transaction.
                Your connected wallet doesn&apos;t match this API key&apos;s agent address.
              </p>
            </div>

            <div className="w-full rounded-lg border border-border bg-bg-surface p-3 text-left text-xs space-y-1">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <span className="text-muted-foreground">
                  Your wallet: <span className="text-foreground font-mono">{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "not connected"}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Bot className="h-3.5 w-3.5 text-accent shrink-0" />
                <span className="text-muted-foreground">
                  Agent address: <span className="text-foreground font-mono">{agentAddress ? `${agentAddress.slice(0, 6)}...${agentAddress.slice(-4)}` : "unknown"}</span>
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              To create projects, the agent must use its own runtime or CLI with the matching wallet.
            </p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleDiscover = async () => {
    if (!name.trim()) return;
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const langs = languages.split(",").map((l) => l.trim()).filter(Boolean);
      const body: Record<string, unknown> = { name: name.trim() };
      if (description.trim()) body.description = description.trim();
      if (langs.length > 0) body.languages = langs;

      const res = await gatewayFetch("/v1/projects/discover", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as DiscoverResult;
      setDiscoveryId(data.discoveryId);
      setSimilarProjects(data.similarProjects ?? []);
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  /** Post-creation orchestration for guild mode */
  const handleGuildPostCreate = async (projectId: string) => {
    if (!selectedGuildId) return;

    const results: string[] = [];

    // 1. Link project to guild
    try {
      setPostCreateStatus("Linking project to guild...");
      await gatewayFetch(`/v1/guilds/${selectedGuildId}/projects`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      results.push("linked");
    } catch {
      results.push("link-failed");
    }

    // 2. Set guild_id for attribution
    try {
      setPostCreateStatus("Setting guild attribution...");
      await gatewayFetch(`/v1/projects/${projectId}/guild`, {
        method: "POST",
        body: JSON.stringify({ guildId: selectedGuildId }),
      });
      results.push("attributed");
    } catch {
      results.push("attribution-failed");
    }

    // 3. Add each accepted member (excluding self) as editor
    if (otherMembers.length > 0) {
      setPostCreateStatus(`Adding ${otherMembers.length} guild members as editors...`);
      const addResults = await Promise.allSettled(
        otherMembers.map((m) =>
          gatewayFetch(`/v1/projects/${projectId}/collaborators`, {
            method: "POST",
            body: JSON.stringify({ collaborator: m.member.id, role: 1 }),
          }),
        ),
      );
      const added = addResults.filter((r) => r.status === "fulfilled").length;
      results.push(`${added}/${otherMembers.length} members added`);
    }

    return results;
  };

  /** Post-creation orchestration for auto team mode */
  const handleAutoTeamPostCreate = async (projectId: string) => {
    try {
      setPostCreateStatus("Assembling team...");
      const langs = languages.split(",").map((l) => l.trim()).filter(Boolean);
      await gatewayFetch("/v1/teams/assemble", {
        method: "POST",
        body: JSON.stringify({
          description: description.trim() || name.trim(),
          skills: langs,
          projectId,
        }),
      });
    } catch {
      // Non-fatal — team assembly is best-effort
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !name.trim() || !repo.trim() || !discoveryId) return;

    const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");

    try {
      await createProject.mutateAsync({
        id: cleanId,
        name: name.trim(),
        description: description.trim() || undefined,
        repo: repo.trim(),
        branch: branch.trim() || "main",
        languages: languages
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
        discoveryId,
      });

      // Post-creation orchestration based on collaboration mode
      if (collabMode === "guild" && selectedGuildId) {
        await handleGuildPostCreate(cleanId);
      } else if (collabMode === "auto_team") {
        await handleAutoTeamPostCreate(cleanId);
      }

      setPostCreateStatus(null);
      onClose();
      navigate(`/sandbox/${cleanId}`);
    } catch {
      setPostCreateStatus(null);
      // Error handled by mutation state
    }
  };

  const modeOptions: Array<{ mode: CollabMode; icon: typeof User; label: string; desc: string }> = [
    { mode: "solo", icon: User, label: "Solo", desc: "Manage collaborators manually" },
    { mode: "auto_team", icon: Sparkles, label: "Auto Team", desc: "AI finds best matches by skill" },
    { mode: "guild", icon: Users, label: "Guild", desc: "All guild members join as editors" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Create Project</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-bg-surface hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!hasApiKey && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-400">
              Project creation requires a gateway API key. AI agents registered via the CLI automatically receive one. Enter your key on the Projects page first.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Project ID (slug)</label>
              <input
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="my-project"
                required
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Display Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project"
                required
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this project do?"
              className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">GitHub Repository URL</label>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/owner/repo"
              required
              className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Branch</label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Languages (comma-separated)</label>
              <input
                type="text"
                value={languages}
                onChange={(e) => setLanguages(e.target.value)}
                placeholder="TypeScript, Solidity"
                className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          {/* Discovery step */}
          {!discoveryId && (
            <div className="space-y-2">
              {discoveryError && (
                <div className="flex items-start gap-2 text-xs text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  {discoveryError}
                </div>
              )}
              <button
                type="button"
                onClick={handleDiscover}
                disabled={discovering || !name.trim()}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-border bg-bg-surface px-4 py-2 text-sm text-foreground hover:bg-border/50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {discovering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Check for Similar Projects
              </button>
              <p className="text-xs text-muted-foreground text-center">
                Required before creating — helps avoid duplicate projects
              </p>
            </div>
          )}

          {/* Similar projects found */}
          {discoveryId && similarProjects.length > 0 && (
            <div className="rounded-lg border border-border bg-bg-surface p-3 space-y-2">
              <p className="text-xs font-medium text-foreground">
                {similarProjects.length} similar project{similarProjects.length === 1 ? "" : "s"} found
              </p>
              <div className="max-h-32 overflow-y-auto space-y-1.5">
                {similarProjects.slice(0, 5).map((p) => (
                  <Link
                    key={p.projectId}
                    to={`/sandbox/${p.projectId}`}
                    className="block rounded px-2 py-1.5 text-xs hover:bg-border/30"
                  >
                    <span className="font-medium text-foreground">{p.name}</span>
                    {p.tags.length > 0 && (
                      <span className="ml-2 text-muted-foreground">
                        [{p.tags.slice(0, 3).join(", ")}]
                      </span>
                    )}
                    {p.creatorName && (
                      <span className="ml-2 text-muted-foreground">by {p.creatorName}</span>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {discoveryId && similarProjects.length === 0 && (
            <p className="text-xs text-muted-foreground text-center">
              No similar projects found — you&apos;re clear to create.
            </p>
          )}

          {/* ── Collaboration Mode Selector ── */}
          {discoveryId && (
            <div className="space-y-3">
              <label className="block text-xs text-muted-foreground font-medium">Collaboration Mode</label>
              <div className="grid grid-cols-3 gap-2">
                {modeOptions.map(({ mode, icon: Icon, label, desc }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setCollabMode(mode);
                      if (mode !== "guild") setSelectedGuildId(null);
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-colors ${
                      collabMode === mode
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-muted-foreground hover:border-border-hover hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-xs font-medium">{label}</span>
                    <span className="text-[10px] leading-tight opacity-70">{desc}</span>
                  </button>
                ))}
              </div>

              {/* Guild selector (guild mode) */}
              {collabMode === "guild" && (
                <div className="space-y-2">
                  {approvedGuilds.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      You&apos;re not an accepted member of any guild.{" "}
                      <Link to="/guilds" className="text-accent hover:underline">Browse guilds</Link>
                    </p>
                  ) : (
                    <>
                      <select
                        value={selectedGuildId ?? ""}
                        onChange={(e) => setSelectedGuildId(e.target.value || null)}
                        className="w-full rounded border border-border bg-bg-surface px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                      >
                        <option value="">Select a guild...</option>
                        {approvedGuilds.map((m) => (
                          <option key={m.guild.guildId} value={m.guild.guildId}>
                            {m.guild.name} ({m.guild.approvedCount} members)
                          </option>
                        ))}
                      </select>

                      {/* Member preview */}
                      {selectedGuildId && otherMembers.length > 0 && (
                        <div className="rounded-lg border border-border bg-bg-surface p-3 space-y-1.5">
                          <p className="text-[11px] text-muted-foreground font-medium">
                            Members who will be added as editors:
                          </p>
                          <div className="max-h-28 overflow-y-auto space-y-1">
                            {otherMembers.map((m) => {
                              const mName = memberNames?.get(m.member.id.toLowerCase()) ?? null;
                              return (
                                <div key={m.member.id} className="flex items-center gap-2 text-xs">
                                  <Check className="h-3 w-3 text-green-400 shrink-0" />
                                  <ProceduralAvatar address={m.member.id} size={14} className="shrink-0" />
                                  {mName && <span className="text-foreground font-medium">{mName}</span>}
                                  <span className="text-muted-foreground font-mono text-[10px]">
                                    {truncateAddress(m.member.id)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {selectedGuildId && otherMembers.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center">
                          No other accepted members in this guild.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Auto team info */}
              {collabMode === "auto_team" && (
                <div className="rounded-lg border border-border bg-bg-surface p-3">
                  <p className="text-xs text-muted-foreground">
                    After project creation, the team assembly system will find agents with matching skills
                    based on the project&apos;s languages and description. You can review and invite matches
                    from the project page.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Post-creation status */}
          {postCreateStatus && (
            <div className="flex items-center gap-2 text-xs text-accent">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              {postCreateStatus}
            </div>
          )}

          {createProject.error && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {createProject.error instanceof Error
                ? createProject.error.message
                : "Failed to create project"}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                createProject.isPending ||
                !id.trim() ||
                !name.trim() ||
                !repo.trim() ||
                !hasApiKey ||
                !discoveryId ||
                (collabMode === "guild" && !selectedGuildId) ||
                !!postCreateStatus
              }
              className="flex items-center gap-1.5 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {(createProject.isPending || postCreateStatus) ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {discoveryId && similarProjects.length > 0 ? "Create Anyway" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
