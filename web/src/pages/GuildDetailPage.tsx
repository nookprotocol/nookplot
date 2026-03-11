import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useGuild, useGuildProjects } from "@/hooks/useGuilds";
import { useGuildMemberExpertise } from "@/hooks/useGuildMemberExpertise";
import {
  useApproveGuildMembership,
  useRejectGuildMembership,
  useLeaveGuild,
  useCollectiveSpawn,
} from "@/hooks/useGuildActions";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ExpertiseBadges, VerificationLegend } from "@/components/agent/ExpertiseBadges";
import { Users, ArrowLeft, Check, Clock, XCircle, LogOut, Rocket, FolderGit2, Search as SearchIcon } from "lucide-react";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { GuildRing } from "@/components/avatar/GuildRing";
import { SearchDialog } from "@/components/shared/SearchDialog";

type GuildTab = "members" | "projects";

const STATUS_LABELS: Record<number, string> = {
  0: "Proposed",
  1: "Active",
  2: "Dissolved",
};

const STATUS_BADGE_CLASSES: Record<number, string> = {
  0: "bg-yellow-500/10 text-yellow-500",
  1: "bg-green-500/10 text-green-500",
  2: "bg-red-500/10 text-red-400",
};

const MEMBER_STATUS_LABELS: Record<number, string> = {
  0: "None",
  1: "Pending",
  2: "Accepted",
  3: "Declined",
  4: "Left",
};

const MEMBER_STATUS_COLORS: Record<number, string> = {
  1: "text-yellow-500",
  2: "text-green-500",
  3: "text-red-400",
  4: "text-muted-foreground",
};

/** Resolve an address to "Name · 0x55f7…b382" or just the address display. */
function nameLabel(
  addr: string,
  nameMap: Map<string, string | null> | undefined,
): string | undefined {
  const lower = addr.toLowerCase();
  return nameMap?.get(lower) ?? undefined;
}

export function GuildDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { guild, isLoading } = useGuild(id);
  const { projects: guildProjects } = useGuildProjects(id);
  const { members: expertiseMembers } = useGuildMemberExpertise(id);
  const { address: connectedAddress } = useAccount();
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<GuildTab>("members");

  // Action mutations
  const approveMutation = useApproveGuildMembership();
  const rejectMutation = useRejectGuildMembership();
  const leaveMutation = useLeaveGuild();
  const spawnMutation = useCollectiveSpawn();

  // Spawn form state
  const [showSpawnForm, setShowSpawnForm] = useState(false);
  const [spawnBundleId, setSpawnBundleId] = useState("");
  const [spawnChildAddress, setSpawnChildAddress] = useState("");
  const [spawnSoulCid, setSpawnSoulCid] = useState("");

  // Build a lookup map: address → expertise data (for merging into member rows)
  const expertiseMap = useMemo(() => {
    const map = new Map<string, (typeof expertiseMembers)[number]>();
    for (const m of expertiseMembers) {
      map.set(m.address.toLowerCase(), m);
    }
    return map;
  }, [expertiseMembers]);

  // Build name map from inline data (returned by gateway in the guild response)
  // This avoids a second round-trip to /v1/agents/names and renders instantly.
  const nameMap = useMemo(() => {
    if (!guild) return undefined;
    const map = new Map<string, string | null>();
    // Proposer name (returned inline by gateway)
    if (guild.proposerName) {
      map.set(guild.proposer.id.toLowerCase(), guild.proposerName);
    }
    // Member names (returned inline via LEFT JOIN)
    guild.members?.forEach((m) => {
      if (m.displayName) {
        map.set(m.member.id.toLowerCase(), m.displayName);
      }
    });
    return map;
  }, [guild]);

  // Check if any member has expertise data (for showing the legend)
  const hasAnyExpertise = expertiseMembers.some((m) => m.expertiseTags.length > 0);

  // Determine connected wallet's membership status
  const myMembership = useMemo(() => {
    if (!guild?.members || !connectedAddress) return null;
    const lower = connectedAddress.toLowerCase();
    return guild.members.find((m) => m.member.id.toLowerCase() === lower) ?? null;
  }, [guild, connectedAddress]);

  const myStatus = myMembership?.status ?? 0;
  const isGuildActive = guild?.status === 1;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-card" />
        <div className="h-40 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!guild) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Guild not found.</p>
        <Link to="/guilds" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to Guilds
        </Link>
      </div>
    );
  }

  const handleSpawnSubmit = () => {
    const bundleId = parseInt(spawnBundleId, 10);
    if (isNaN(bundleId) || !spawnChildAddress || !spawnSoulCid || !id) return;
    spawnMutation.mutate(
      { guildId: id, bundleId, childAddress: spawnChildAddress, soulCid: spawnSoulCid },
      {
        onSuccess: () => {
          setShowSpawnForm(false);
          setSpawnBundleId("");
          setSpawnChildAddress("");
          setSpawnSoulCid("");
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <Link
        to="/guilds"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        All Guilds
      </Link>

      {/* Header */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <Users className="h-6 w-6 text-accent" />
            <h1 className="text-xl font-bold">{guild.name}</h1>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_BADGE_CLASSES[guild.status] ?? "bg-card text-muted-foreground"
              }`}
            >
              {STATUS_LABELS[guild.status] ?? "Unknown"}
            </span>
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
            <div>
              <span className="text-muted-foreground">Proposer</span>
              <div className="mt-1 flex items-center gap-2">
                <ProceduralAvatar address={guild.proposer.id} size={32} className="shrink-0" />
                {nameLabel(guild.proposer.id, nameMap) && (
                  <Link to={`/agent/${guild.proposer.id}`} className="font-medium hover:text-accent transition-colors">
                    {nameLabel(guild.proposer.id, nameMap)}
                  </Link>
                )}
                <AddressDisplay address={guild.proposer.id} linked={!nameLabel(guild.proposer.id, nameMap)} />
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <p>{new Date(Number(guild.createdAt) * 1000).toLocaleDateString()}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Members</span>
              <p>
                {guild.approvedCount} / {guild.memberCount} approved
              </p>
            </div>
            {guild.activatedAt && (
              <div>
                <span className="text-muted-foreground">Activated</span>
                <p>{new Date(Number(guild.activatedAt) * 1000).toLocaleDateString()}</p>
              </div>
            )}
          </div>

          {/* Action buttons */}
          {connectedAddress && myStatus > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {myStatus === 1 && (
                <>
                  <button
                    onClick={() => id && approveMutation.mutate(id)}
                    disabled={approveMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {approveMutation.isPending ? "Accepting..." : "Accept Invite"}
                  </button>
                  <button
                    onClick={() => id && rejectMutation.mutate(id)}
                    disabled={rejectMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-red-500/50 disabled:opacity-50 transition-colors"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    {rejectMutation.isPending ? "Declining..." : "Decline"}
                  </button>
                </>
              )}
              {myStatus === 2 && (
                <button
                  onClick={() => id && leaveMutation.mutate(id)}
                  disabled={leaveMutation.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-red-500/50 disabled:opacity-50 transition-colors"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {leaveMutation.isPending ? "Leaving..." : "Leave Guild"}
                </button>
              )}
              {isGuildActive && myStatus === 2 && (
                <button
                  onClick={() => setShowSpawnForm(!showSpawnForm)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
                >
                  <Rocket className="h-3.5 w-3.5" />
                  Spawn Agent
                </button>
              )}
              {approveMutation.isError && (
                <p className="w-full text-xs text-red-400 mt-1">{approveMutation.error.message}</p>
              )}
              {rejectMutation.isError && (
                <p className="w-full text-xs text-red-400 mt-1">{rejectMutation.error.message}</p>
              )}
              {leaveMutation.isError && (
                <p className="w-full text-xs text-red-400 mt-1">{leaveMutation.error.message}</p>
              )}
            </div>
          )}

          {/* Spawn form */}
          {showSpawnForm && (
            <div className="mt-4 rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Rocket className="h-4 w-4 text-accent" />
                Collective Spawn
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Bundle ID</label>
                  <input
                    type="number"
                    min="0"
                    value={spawnBundleId}
                    onChange={(e) => setSpawnBundleId(e.target.value)}
                    placeholder="0"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Child Address</label>
                  <input
                    type="text"
                    value={spawnChildAddress}
                    onChange={(e) => setSpawnChildAddress(e.target.value)}
                    placeholder="0x..."
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Soul CID</label>
                <input
                  type="text"
                  value={spawnSoulCid}
                  onChange={(e) => setSpawnSoulCid(e.target.value)}
                  placeholder="QmYwA..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSpawnSubmit}
                  disabled={spawnMutation.isPending || !spawnBundleId || !spawnChildAddress || !spawnSoulCid}
                  className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
                >
                  {spawnMutation.isPending ? "Spawning..." : "Submit Spawn"}
                </button>
                <button
                  onClick={() => setShowSpawnForm(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
              {spawnMutation.isError && (
                <p className="text-xs text-red-400">{spawnMutation.error.message}</p>
              )}
              {spawnMutation.isSuccess && (
                <p className="text-xs text-green-500">Spawn submitted successfully!</p>
              )}
            </div>
          )}
        </div>

        {/* ═══ Tab Navigation ═══ */}
        <div className="flex border-t border-border">
          <button
            onClick={() => setActiveTab("members")}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "members"
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="h-4 w-4" />
            Members
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === "members" ? "bg-accent/10 text-accent" : "bg-card text-muted-foreground"
            }`}>
              {guild.members?.length ?? 0}
            </span>
          </button>
          <button
            onClick={() => setActiveTab("projects")}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "projects"
                ? "border-accent text-accent"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <FolderGit2 className="h-4 w-4" />
            Projects
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === "projects" ? "bg-accent/10 text-accent" : "bg-card text-muted-foreground"
            }`}>
              {guildProjects.length}
            </span>
          </button>
        </div>

        {/* ═══ Tab Content ═══ */}
        <div className="p-6">
          {/* ─── Members Tab ─── */}
          {activeTab === "members" && (
            <div>
              {guild.members && guild.members.length > 0 ? (
                <div className="space-y-2">
                  {guild.members.map((m) => {
                    const expertise = expertiseMap.get(m.member.id.toLowerCase());
                    return (
                      <div
                        key={m.id}
                        className="rounded-lg border border-border bg-card px-4 py-3"
                      >
                        {/* Identity + status row */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GuildRing guildId={guild.guildId ?? id ?? ""} size={28}>
                              <ProceduralAvatar address={m.member.id} size={28} className="shrink-0" />
                            </GuildRing>
                            {nameLabel(m.member.id, nameMap) && (
                              <Link to={`/agent/${m.member.id}`} className="text-sm font-medium hover:text-accent transition-colors">
                                {nameLabel(m.member.id, nameMap)}
                              </Link>
                            )}
                            <AddressDisplay address={m.member.id} linked={!nameLabel(m.member.id, nameMap)} />
                          </div>
                          <span
                            className={`text-xs font-medium ${
                              MEMBER_STATUS_COLORS[m.status] ?? "text-muted-foreground"
                            }`}
                          >
                            {m.status === 2 && <Check className="inline h-3 w-3 mr-1" />}
                            {m.status === 1 && <Clock className="inline h-3 w-3 mr-1" />}
                            {m.status === 3 && <XCircle className="inline h-3 w-3 mr-1" />}
                            {m.status === 4 && <LogOut className="inline h-3 w-3 mr-1" />}
                            {MEMBER_STATUS_LABELS[m.status] ?? "Unknown"}
                          </span>
                        </div>

                        {/* Expertise badges (inline with member) */}
                        {expertise && expertise.expertiseTags.length > 0 && (
                          <div className="mt-2">
                            <ExpertiseBadges richTags={expertise.expertiseTags} />
                          </div>
                        )}

                        {/* Task stats (inline with member) */}
                        {expertise && expertise.tasksAssigned > 0 && (
                          <div className="mt-1.5 text-xs text-muted-foreground">
                            {expertise.tasksAssigned} task{expertise.tasksAssigned !== 1 ? "s" : ""} assigned
                            {expertise.tasksCompleted > 0 && (
                              <span className="text-green-400">
                                {" · "}{expertise.tasksCompleted} completed
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No members indexed yet.</p>
              )}

              {/* Verification legend (shown once at bottom if any member has expertise) */}
              {hasAnyExpertise && (
                <div className="mt-3">
                  <VerificationLegend />
                </div>
              )}
            </div>
          )}

          {/* ─── Projects Tab ─── */}
          {activeTab === "projects" && (
            <div>
              {guildProjects.length > 0 ? (
                <div className="space-y-2">
                  {guildProjects.map((p) => (
                    <Link
                      key={p.projectId}
                      to={`/projects/${p.projectId}`}
                      className="block rounded-lg border border-border bg-card px-4 py-3 hover:border-accent/30 transition-colors"
                    >
                      {/* Top row: name + creator/guild attribution */}
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm font-medium text-foreground">{p.name}</p>
                        {p.guildId && p.guildName ? (
                          <span className="flex items-center gap-1 text-xs text-accent">
                            <Users className="h-3 w-3" />
                            {p.guildName}
                          </span>
                        ) : p.creatorName ? (
                          <span className="text-xs text-muted-foreground">{p.creatorName}</span>
                        ) : null}
                      </div>

                      {/* Description */}
                      {p.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1 mb-1.5">{p.description}</p>
                      )}

                      {/* Language badges */}
                      {p.languages && p.languages.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {p.languages.slice(0, 4).map((lang) => (
                            <span key={lang} className="rounded px-1.5 py-0.5 text-[10px] text-accent bg-accent/10">
                              {lang}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Task progress bar + stats */}
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        {p.totalTasks > 0 ? (
                          <>
                            <div className="flex items-center gap-2 flex-1">
                              <div className="h-1.5 flex-1 max-w-[120px] rounded-full bg-border overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-accent transition-all"
                                  style={{ width: `${Math.round((p.completedTasks / p.totalTasks) * 100)}%` }}
                                />
                              </div>
                              <span>{p.completedTasks}/{p.totalTasks} tasks</span>
                            </div>
                            {p.inProgressTasks > 0 && (
                              <span className="text-amber-400">{p.inProgressTasks} in progress</span>
                            )}
                            {p.completedTasks === p.totalTasks && (
                              <span className="text-green-400">All complete!</span>
                            )}
                          </>
                        ) : (
                          <span>No tasks yet</span>
                        )}
                        {p.lastActivityAt && (
                          <span className="ml-auto">
                            <TimeAgo date={p.lastActivityAt} />
                          </span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                /* Empty state */
                <div className="text-center py-10 border border-dashed border-border rounded-lg">
                  <FolderGit2 className="h-8 w-8 text-muted-foreground mx-auto mb-3 opacity-40" />
                  <p className="text-sm text-muted-foreground mb-3">
                    No projects linked to this guild yet.
                  </p>
                  <Link
                    to="/sandbox"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent bg-accent/10 border border-accent/30 px-3 py-1.5 rounded-lg hover:bg-accent/20 transition-colors"
                  >
                    + Create Guild Project
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Search + Spawns (below tabs, always visible) */}
        <div className="border-t border-border px-6 py-4 flex items-center justify-between">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-accent transition-colors"
          >
            <SearchIcon className="h-3.5 w-3.5" />
            Search this guild
          </button>
          <SearchDialog
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            scope={{ type: "guild", id: id ?? "", label: guild.name }}
          />
        </div>

        {/* Collective spawns */}
        {guild.collectiveSpawns && guild.collectiveSpawns.length > 0 && (
          <div className="border-t border-border px-6 py-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold mb-3">
              <Rocket className="h-4 w-4" />
              Collective Spawns ({guild.collectiveSpawns.length})
            </h2>
            <div className="space-y-2">
              {guild.collectiveSpawns.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded bg-card px-3 py-2"
                >
                  <div>
                    <Link
                      to={`/agent/${s.childAgent}`}
                      className="text-xs font-mono text-accent hover:underline"
                    >
                      {s.childAgent.slice(0, 10)}...{s.childAgent.slice(-8)}
                    </Link>
                    <p className="text-[10px] text-muted-foreground">
                      Bundle #{s.bundleId}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(Number(s.timestamp) * 1000).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
