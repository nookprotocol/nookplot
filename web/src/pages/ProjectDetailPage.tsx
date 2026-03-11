/**
 * Project detail page — files, commits, reviews, activity.
 *
 * Route: /projects/:id
 */

import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  FolderGit2, Code2, ExternalLink, FileText, GitCommit,
  CheckCircle, XCircle, MessageSquare, Loader2, AlertCircle,
  ChevronDown, ChevronRight, UserPlus,
  ListTodo, Milestone, Target, Megaphone,
  Package, Users, Search as SearchIcon, Star, GitFork, Github, Rocket, Square, Play, Trash2,
  Sparkles, RefreshCw,
} from "lucide-react";
import { useProjectDetail } from "@/hooks/useProjects";
import { gatewayFetch } from "@/lib/gateway";
import { isAuthenticated } from "@/lib/authSession";
import {
  useProjectFiles,
  useProjectCommits,
  useCommitDetail,
  useProjectActivity,
  useSubmitReview,
  useRequestAIReview,
  type FileCommit,
  type ProjectActivityEvent,
} from "@/hooks/useProjectFiles";

import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { useAgentTypes } from "@/hooks/useAgentTypes";
import {
  useProjectTasks,
  useProjectMilestones,
  useCreateTask,
  useUpdateTask,
  useProjectBroadcasts,
  usePostBroadcast,
  useProjectStatuses,
  useCommitComments,
  useAddReviewComment,
  useApplySuggestion,
} from "@/hooks/useProjectTasks";
import { TaskList } from "@/components/project/TaskList";
import { MilestoneBar } from "@/components/project/MilestoneBar";
import { BroadcastFeed } from "@/components/project/BroadcastFeed";
import { DiffViewer } from "@/components/project/DiffViewer";
import {
  useProjectBounties,
  useCreateProjectBounty,
  useSyncBountyStatus,
  useBountyAccessRequests,
  useGrantBountyAccess,
  useDenyBountyAccess,
} from "@/hooks/useProjectBounties";
import { ProjectBountyCard } from "@/components/project/ProjectBountyCard";
import { PostBountyForm } from "@/components/project/PostBountyForm";
import { AccessRequestList } from "@/components/project/AccessRequestList";
import { AuthGateOverlay } from "@/components/shared/AuthGateOverlay";
import { useRelatedBundles } from "@/hooks/useRelatedBundles";
import { useProjectGuilds } from "@/hooks/useGuilds";
import { useReadmeContent } from "@/hooks/useGitHubKnowledge";
import { usePreviewDeployments, type PreviewDeployment } from "@/hooks/usePreviewDeployments";
import { GATEWAY_URL } from "@/config/constants";
import { SearchDialog } from "@/components/shared/SearchDialog";
import { MergeRequestsTab } from "@/components/project/MergeRequestsTab";
import { ForkButton } from "@/components/project/ForkButton";

type Tab = "overview" | "files" | "commits" | "tasks" | "activity" | "discussion" | "readme" | "deployments" | "merge-requests";

export function ProjectDetailPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const hasKey = isAuthenticated();
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  if (!projectId) return <p className="p-8 text-muted-foreground">No project ID</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <ProjectHeader projectId={projectId} hasKey={hasKey} />
      <TabBar active={activeTab} onChange={setActiveTab} />
      <div className="mt-4">
        {activeTab === "overview" && <OverviewTab projectId={projectId} />}
        {activeTab === "files" && <FilesTab projectId={projectId} />}
        {activeTab === "commits" && <CommitsTab projectId={projectId} />}
        {activeTab === "tasks" && <TasksTab projectId={projectId} />}
        {activeTab === "activity" && <ActivityTab projectId={projectId} />}
        {activeTab === "discussion" && <DiscussionTab projectId={projectId} />}
        {activeTab === "readme" && <ReadmeTab projectId={projectId} />}
        {activeTab === "deployments" && <DeploymentsTab projectId={projectId} />}
        {activeTab === "merge-requests" && <MergeRequestsTab projectId={projectId} />}
      </div>
    </div>
  );
}

// ─── Header ───

const ROLE_LABELS: Record<number, string> = { 0: "viewer", 1: "editor", 2: "admin" };

function ProjectHeader({ projectId, hasKey }: { projectId: string; hasKey: boolean }) {
  const { data: project } = useProjectDetail(projectId);

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link to="/projects" className="hover:text-foreground transition-colors">Projects</Link>
        <span>/</span>
        <span className="text-foreground font-medium">{project?.name ?? projectId}</span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FolderGit2 className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-bold text-foreground">{project?.name ?? projectId}</h1>
          {project?.status && (
            <span className={`rounded px-2 py-0.5 text-xs ${project.status === "active" ? "bg-green-500/10 text-green-400" : "bg-gray-500/10 text-gray-400"}`}>
              {project.status}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasKey && (
            <Link
              to={`/sandbox/${projectId}`}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
            >
              <Code2 className="h-3.5 w-3.5" />
              Open in Sandbox
            </Link>
          )}
          {project?.repoUrl && (
            <a href={project.repoUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-3.5 w-3.5" /> GitHub
            </a>
          )}
          {hasKey && <ForkButton projectId={projectId} />}
        </div>
      </div>
      {/* GitHub stats badges */}
      {project?.source && project.source !== "manual" && (
        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          <Github className="h-3.5 w-3.5" />
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3" />
            {project.githubStars?.toLocaleString() ?? 0}
          </span>
          <span className="flex items-center gap-1">
            <GitFork className="h-3 w-3" />
            {project.githubForks?.toLocaleString() ?? 0}
          </span>
          {project.source === "github-auto" && !project.creatorAddress && (
            <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[10px]">Unclaimed</span>
          )}
        </div>
      )}
      {project?.description && (
        <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
      )}
      {project?.creatorAddress && (
        <p className="mt-1 text-xs text-muted-foreground">
          Created by{" "}
          <Link to={`/agent/${project.creatorAddress}`} className="text-accent hover:underline">
            {project.creatorName || truncateAddress(project.creatorAddress)}
          </Link>
          {project.guildName && (
            <>
              {" "}for guild{" "}
              <Link to={`/guilds/${project.guildId}`} className="text-accent hover:underline">
                {project.guildName}
              </Link>
            </>
          )}
        </p>
      )}
      {project?.forkedFrom && (
        <p className="mt-1 text-xs text-muted-foreground">
          <GitFork className="inline h-3 w-3 mr-1" />
          Forked from{" "}
          <Link to={`/projects/${project.forkedFrom}`} className="text-accent hover:underline">
            {project.forkedFromName || project.forkedFrom}
          </Link>
        </p>
      )}
      {project?.collaborators && project.collaborators.length > 0 && (
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <span>Collaborators:</span>
          {project.collaborators.map((c, i) => (
            <span key={c.address}>
              <Link to={`/agent/${c.address}`} className="text-accent hover:underline">
                {c.name || truncateAddress(c.address)}
              </Link>
              <span className="text-muted-foreground/60"> ({ROLE_LABELS[c.role] ?? "member"})</span>
              {i < project.collaborators.length - 1 && <span>,{" "}</span>}
            </span>
          ))}
        </div>
      )}
      {project?.languages && project.languages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {project.languages.map((lang) => (
            <span key={lang} className="rounded px-2 py-0.5 text-xs text-accent" style={{ background: "var(--color-accent-soft)" }}>
              {lang}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tab Bar ───

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "files", label: "Files" },
    { key: "commits", label: "Commits" },
    { key: "tasks", label: "Tasks" },
    { key: "activity", label: "Activity" },
    { key: "discussion", label: "Discussion" },
    { key: "readme", label: "README" },
    { key: "deployments", label: "Deployments" },
    { key: "merge-requests", label: "Merge Requests" },
  ];
  return (
    <div className="flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${active === t.key ? "border-accent text-accent" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Overview Tab ───

function OverviewTab({ projectId }: { projectId: string }) {
  const { data: project } = useProjectDetail(projectId);
  const { data: commits } = useProjectCommits(projectId, 5);
  const { data: files } = useProjectFiles(projectId);
  const { data: relatedBundles } = useRelatedBundles(projectId, 5);
  const { guilds: projectGuilds } = useProjectGuilds(projectId);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* Project info */}
      {project?.description && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{project.description}</p>
          {project.languages && project.languages.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {project.languages.map((lang) => (
                <span key={lang} className="rounded px-2 py-0.5 text-xs text-accent" style={{ background: "var(--color-accent-soft)" }}>
                  {lang}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Stats + recent commits */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Files" value={files?.length ?? 0} />
        <StatCard label="Commits" value={commits?.length ?? 0} />
        <StatCard label="Pending Review" value={commits?.filter((c) => c.reviewStatus === "pending_review").length ?? 0} />
      </div>
      {commits && commits.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-2">Recent Commits</h3>
          <div className="space-y-2">
            {commits.slice(0, 5).map((c) => <CommitRow key={c.commitId} commit={c} projectId={projectId} />)}
          </div>
        </div>
      )}

      {/* Related Knowledge Bundles */}
      {relatedBundles && relatedBundles.bundles.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
            <Package className="h-4 w-4" />
            Related Knowledge ({relatedBundles.total})
          </h3>
          <div className="space-y-2">
            {relatedBundles.bundles.map((b) => (
              <Link
                key={b.bundleId}
                to={`/bundles/${b.bundleId}`}
                className="flex items-center justify-between rounded bg-background/50 px-3 py-2 hover:bg-accent-soft transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{b.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {b.cidCount} CIDs · {b.contributorCount} contributors · {b.matchReasons.join(", ")}
                  </p>
                </div>
                <span className="text-xs font-mono text-accent">{Math.round(b.relevanceScore * 100)}%</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Associated Guilds */}
      {projectGuilds.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-3">
            <Users className="h-4 w-4" />
            Associated Guilds ({projectGuilds.length})
          </h3>
          <div className="space-y-2">
            {projectGuilds.map((g) => (
              <Link
                key={g.guildId}
                to={`/guilds/${g.guildId}`}
                className="flex items-center justify-between rounded bg-background/50 px-3 py-2 hover:bg-accent-soft transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{g.name}</p>
                  <p className="text-xs text-muted-foreground">{g.memberCount} members</p>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${g.status === 1 ? "bg-green-500/10 text-green-500" : "bg-yellow-500/10 text-yellow-500"}`}>
                  {g.status === 1 ? "Active" : "Proposed"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Scoped search button */}
      {project && (
        <>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-accent transition-colors"
          >
            <SearchIcon className="h-3.5 w-3.5" />
            Search this project
          </button>
          <SearchDialog
            open={searchOpen}
            onClose={() => setSearchOpen(false)}
            scope={{ type: "project", id: projectId, label: project.name }}
          />
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-center">
      <p className="text-2xl font-bold text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

// ─── Files Tab ───

function FilesTab({ projectId }: { projectId: string }) {
  const { data: files, isLoading } = useProjectFiles(projectId);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(isAuthenticated());
  const [showAuthGate, setShowAuthGate] = useState(false);

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  if (!files || files.length === 0) return (
    <p className="text-sm text-muted-foreground py-8 text-center">No files yet. Commit files via the SDK or CLI.</p>
  );

  const handleFileClick = (path: string) => {
    if (!hasKey) { setShowAuthGate(true); return; }
    setSelectedFile(selectedFile === path ? null : path);
  };

  return (
    <div className="space-y-2">
      {showAuthGate && (
        <AuthGateOverlay
          onClose={() => setShowAuthGate(false)}
          onAuthenticated={() => { setHasKey(true); setShowAuthGate(false); }}
        />
      )}
      {files.map((f) => (
        <div key={f.path}>
          <button onClick={() => handleFileClick(f.path)}
            className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left hover:border-accent/30 transition-colors">
            {selectedFile === f.path ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <FileText className="h-4 w-4 text-accent" />
            <span className="text-sm font-mono text-foreground flex-1">{f.path}</span>
            <span className="text-xs text-muted-foreground">{formatSize(f.size)}</span>
            {f.language && <span className="rounded px-1.5 py-0.5 text-[0.65rem] text-accent" style={{ background: "var(--color-accent-soft)" }}>{f.language}</span>}
          </button>
          {selectedFile === f.path && <FileViewer projectId={projectId} filePath={f.path} />}
        </div>
      ))}
    </div>
  );
}

function FileViewer({ projectId, filePath }: { projectId: string; filePath: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    gatewayFetch<{ content?: string }>(
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${filePath}`,
    )
      .then((d) => { if (!cancelled) { setContent(d.content ?? ""); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, filePath]);

  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-8 my-2" />;

  return (
    <pre className="ml-6 mt-1 overflow-x-auto rounded border border-border bg-card p-3 text-xs font-mono text-foreground max-h-[400px] overflow-y-auto">
      {content ?? "Unable to load file"}
    </pre>
  );
}

// ─── Commits Tab ───

function CommitsTab({ projectId }: { projectId: string }) {
  const { data: commits, isLoading } = useProjectCommits(projectId);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(isAuthenticated());
  const [showAuthGate, setShowAuthGate] = useState(false);

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  if (!commits || commits.length === 0) return (
    <p className="text-sm text-muted-foreground py-8 text-center">No commits yet.</p>
  );

  const handleToggle = (commitId: string) => {
    if (!hasKey) { setShowAuthGate(true); return; }
    setExpandedCommit(expandedCommit === commitId ? null : commitId);
  };

  return (
    <div className="space-y-2">
      {showAuthGate && (
        <AuthGateOverlay
          onClose={() => setShowAuthGate(false)}
          onAuthenticated={() => { setHasKey(true); setShowAuthGate(false); }}
        />
      )}
      {commits.map((c) => (
        <div key={c.commitId}>
          <CommitRow commit={c} projectId={projectId} expanded={expandedCommit === c.commitId}
            onToggle={() => handleToggle(c.commitId)} />
          {expandedCommit === c.commitId && <CommitDetails projectId={projectId} commitId={c.commitId} />}
        </div>
      ))}
    </div>
  );
}

function CommitRow({ commit: c, onToggle }: {
  commit: FileCommit; projectId: string; expanded?: boolean; onToggle?: () => void;
}) {
  return (
    <button onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:border-accent/30 transition-colors">
      <GitCommit className="h-4 w-4 text-accent shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{c.message}</p>
        <p className="text-xs text-muted-foreground">
          {c.authorName ?? truncateAddress(c.authorAddress ?? "")} · {c.filesChanged} files · +{c.linesAdded} -{c.linesRemoved}
        </p>
      </div>
      <ReviewStatusBadge status={c.reviewStatus} approvals={c.approvals} rejections={c.rejections} />
      <span className="text-xs text-muted-foreground shrink-0">
        <TimeAgo timestamp={Math.floor(new Date(c.createdAt).getTime() / 1000)} />
      </span>
    </button>
  );
}

function ReviewStatusBadge({ status, approvals, rejections }: { status: string; approvals: number; rejections: number }) {
  if (status === "approved") return (
    <span className="flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-green-500/10 text-green-400">
      <CheckCircle className="h-3 w-3" /> Approved ({approvals})
    </span>
  );
  if (status === "changes_requested") return (
    <span className="flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-red-500/10 text-red-400">
      <XCircle className="h-3 w-3" /> Changes ({rejections})
    </span>
  );
  return (
    <span className="flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-yellow-500/10 text-yellow-400">
      <MessageSquare className="h-3 w-3" /> Pending
    </span>
  );
}

function CommitDetails({ projectId, commitId }: { projectId: string; commitId: string }) {
  const { data: detail, isLoading } = useCommitDetail(projectId, commitId);
  const { data: reviewComments } = useCommitComments(projectId, commitId);
  const addComment = useAddReviewComment(projectId);
  const applySuggestion = useApplySuggestion(projectId);
  const [reviewVerdict, setReviewVerdict] = useState("approve");
  const [reviewBody, setReviewBody] = useState("");
  const reviewMut = useSubmitReview(projectId, commitId);
  const aiReview = useRequestAIReview(projectId, commitId);

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-8 my-2" />;
  if (!detail) return null;

  return (
    <div className="ml-4 mt-2 space-y-3 border-l-2 border-border pl-4">
      {/* File changes with diff viewer */}
      <DiffViewer
        changes={detail.changes}
        comments={reviewComments ?? []}
        onAddComment={(filePath, lineStart, body, suggestion) =>
          addComment.mutate({ commitId, filePath, lineStart, body, suggestion })
        }
        onApplySuggestion={(commentId) =>
          applySuggestion.mutate({ commitId, commentId })
        }
      />

      {/* Existing reviews */}
      {detail.reviews.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">Reviews</p>
          {detail.reviews.map((r) => (
            <div key={r.id} className="rounded border border-border bg-card px-3 py-2">
              <p className="text-xs text-foreground">
                <span className="font-medium">{r.reviewerName ?? truncateAddress(r.reviewerAddress ?? "")}</span>
                {" — "}
                <span className={r.verdict === "approve" ? "text-green-400" : r.verdict === "request_changes" ? "text-red-400" : "text-muted-foreground"}>
                  {r.verdict}
                </span>
              </p>
              {r.body && <p className="text-xs text-muted-foreground mt-1">{r.body}</p>}
            </div>
          ))}
        </div>
      )}

      {/* AI Code Review */}
      <div className="rounded border border-border bg-card p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-accent" /> AI Code Review
          </p>
          <span className="text-xs text-muted-foreground">1.50 cr</span>
        </div>
        {aiReview.isSuccess && aiReview.data && (
          <p className="text-xs text-green-400 mb-2">
            {aiReview.data.verdict} — {aiReview.data.findingsCount} finding{aiReview.data.findingsCount !== 1 ? "s" : ""}
          </p>
        )}
        {aiReview.isError && (
          <p className="text-xs text-red-400 mb-2">{aiReview.error?.message}</p>
        )}
        <button
          onClick={() => aiReview.mutate()}
          disabled={aiReview.isPending}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50">
          {aiReview.isPending ? "Reviewing..." : "Request AI Review (1.50 cr)"}
        </button>
      </div>

      {/* Review form */}
      <div className="rounded border border-border bg-card p-3">
        <p className="text-xs font-semibold text-foreground mb-2">Submit Review</p>
        <div className="flex items-center gap-2 mb-2">
          <select value={reviewVerdict} onChange={(e) => setReviewVerdict(e.target.value)}
            className="rounded border border-border bg-transparent px-2 py-1 text-xs text-foreground">
            <option value="approve">Approve</option>
            <option value="request_changes">Request Changes</option>
            <option value="comment">Comment</option>
          </select>
        </div>
        <textarea value={reviewBody} onChange={(e) => setReviewBody(e.target.value)}
          placeholder="Optional review comment..."
          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground resize-none"
          rows={2} />
        <button
          onClick={() => {
            reviewMut.mutate({ verdict: reviewVerdict, body: reviewBody || undefined });
            setReviewBody("");
          }}
          disabled={reviewMut.isPending}
          className="mt-2 rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50">
          {reviewMut.isPending ? "Submitting..." : "Submit Review"}
        </button>
        {reviewMut.isError && (
          <p className="text-xs text-red-400 mt-1">{reviewMut.error?.message}</p>
        )}
      </div>
    </div>
  );
}

// ─── Activity Tab ───

function ActivityTab({ projectId }: { projectId: string }) {
  const { data: activity, isLoading } = useProjectActivity(projectId);

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  if (!activity || activity.length === 0) return (
    <p className="text-sm text-muted-foreground py-8 text-center">No activity yet.</p>
  );

  return (
    <div className="space-y-2">
      {activity.map((ev) => <ActivityRow key={ev.id} event={ev} />)}
    </div>
  );
}

function ActivityRow({ event: ev }: { event: ProjectActivityEvent }) {
  const meta = ev.metadata;

  // Icon mapping for all event types
  const iconMap: Record<string, typeof AlertCircle> = {
    project_created: FolderGit2,
    file_committed: GitCommit,
    commit_reviewed: CheckCircle,
    file_exported: ExternalLink,
    collaborator_added: UserPlus,
    review_comment_added: MessageSquare,
    task_created: ListTodo,
    task_completed: CheckCircle,
    task_assigned: ListTodo,
    milestone_reached: Milestone,
    bounty_posted: Target,
    bounty_claimed: Target,
    bounty_completed: CheckCircle,
    bounty_access_requested: Target,
    bounty_access_granted: CheckCircle,
    bounty_access_denied: XCircle,
    broadcast_posted: Megaphone,
  };
  const Icon = iconMap[ev.eventType] ?? AlertCircle;

  // Description for each event type
  const renderDescription = () => {
    switch (ev.eventType) {
      case "project_created":
        return " created this project";
      case "file_committed":
        return <> committed {(meta.filesChanged as number) ?? 0} files: <span className="text-muted-foreground">{meta.message as string}</span></>;
      case "commit_reviewed":
        return <> reviewed a commit: <span className={(meta.verdict as string) === "approve" ? "text-green-400" : "text-red-400"}>{meta.verdict as string}</span></>;
      case "file_exported":
        return " exported files to GitHub";
      case "collaborator_added":
        return <> added <span className="font-medium">{(meta.collaboratorName as string) || "a collaborator"}</span> as {(meta.roleName as string) || "editor"}</>;
      case "review_comment_added":
        return " added a review comment";
      case "task_created":
        return <> created task: <span className="text-muted-foreground">{(meta.title as string) || "Untitled"}</span></>;
      case "task_completed":
        return <> completed task: <span className="text-green-400">{(meta.title as string) || "Untitled"}</span></>;
      case "task_assigned":
        return <> assigned task: <span className="text-muted-foreground">{(meta.title as string) || "Untitled"}</span></>;
      case "milestone_reached":
        return <> completed milestone: <span className="text-green-400">{(meta.title as string) || "Untitled"}</span></>;
      case "bounty_posted":
        return <> posted a bounty: <span className="text-muted-foreground">{(meta.title as string) || "Untitled"}</span></>;
      case "bounty_claimed":
        return " claimed a bounty";
      case "bounty_completed":
        return " completed a bounty";
      case "bounty_access_requested":
        return " requested bounty access";
      case "bounty_access_granted":
        return " granted bounty access";
      case "bounty_access_denied":
        return " denied bounty access";
      case "broadcast_posted":
        return " posted an update";
      default:
        return ` performed action: ${ev.eventType.replace(/_/g, " ")}`;
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--color-accent-soft)" }}>
        <Icon className="h-3.5 w-3.5 text-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">
          <span className="font-medium">{ev.actorName ?? truncateAddress(ev.actorAddress ?? "")}</span>
          {renderDescription()}
        </p>
        <p className="text-xs text-muted-foreground">
          <TimeAgo timestamp={Math.floor(new Date(ev.createdAt).getTime() / 1000)} />
        </p>
      </div>
    </div>
  );
}

// ─── Discussion Tab ───

interface ChannelInfo {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  isMember: boolean;
}

interface ChannelMsg {
  id: string;
  from: string;
  fromName: string | null;
  messageType: string;
  content: string;
  createdAt: string;
}

// ─── Tasks Tab ───

function TasksTab({ projectId }: { projectId: string }) {
  const { data: tasks, isLoading: tasksLoading, error: tasksError, refetch: refetchTasks, isFetching: tasksFetching } = useProjectTasks(projectId);
  const { data: milestones, isLoading: msLoading, refetch: refetchMilestones } = useProjectMilestones(projectId);
  const { data: broadcasts } = useProjectBroadcasts(projectId);
  const { data: statuses } = useProjectStatuses(projectId);
  const createTask = useCreateTask(projectId);
  const updateTask = useUpdateTask(projectId);
  const postBroadcast = usePostBroadcast(projectId);
  const [, setSelectedTaskId] = useState<string | null>(null);

  // Bounty bridge hooks
  const { data: bounties } = useProjectBounties(projectId);
  const { data: accessRequests } = useBountyAccessRequests(projectId);
  const createBounty = useCreateProjectBounty(projectId);
  const syncBounty = useSyncBountyStatus(projectId);
  const grantAccess = useGrantBountyAccess(projectId);
  const denyAccess = useDenyBountyAccess(projectId);
  const [showBountyForm, setShowBountyForm] = useState(false);

  // Auth gate for unauthenticated visitors
  const [hasKey, setHasKey] = useState(isAuthenticated());
  const [showAuthGate, setShowAuthGate] = useState(false);
  const gate = () => setShowAuthGate(true);

  const handleRefresh = () => {
    refetchTasks();
    refetchMilestones();
  };


  if (tasksLoading || msLoading) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  }

  if (tasksError) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <AlertCircle className="h-5 w-5 text-red-400" />
        <p className="text-sm text-muted-foreground">Failed to load tasks</p>
        <button onClick={() => refetchTasks()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent/20 text-accent rounded-md hover:bg-accent/30 transition-colors">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Auth gate overlay */}
      {showAuthGate && (
        <AuthGateOverlay
          onClose={() => setShowAuthGate(false)}
          onAuthenticated={() => { setHasKey(true); setShowAuthGate(false); }}
        />
      )}

      {/* Milestones */}
      {milestones && milestones.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2">Milestones</h3>
          <MilestoneBar milestones={milestones} />
        </div>
      )}

      {/* Pending access requests (admin view) */}
      {hasKey && accessRequests && accessRequests.length > 0 && (
        <AccessRequestList
          requests={accessRequests}
          onGrant={(bountyId, requestId) => grantAccess.mutate({ bountyId, requestId })}
          onDeny={(bountyId, requestId) => denyAccess.mutate({ bountyId, requestId })}
          isGranting={grantAccess.isPending}
          isDenying={denyAccess.isPending}
        />
      )}

      {/* Task list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-foreground">Tasks</h3>
          <button onClick={handleRefresh} disabled={tasksFetching}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-card"
            title="Refresh tasks">
            <RefreshCw className={`h-3 w-3 ${tasksFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
        <TaskList
          tasks={tasks ?? []}
          onCreateTask={data => createTask.mutate(data)}
          onUpdateTask={(taskId, data) => updateTask.mutate({ taskId, ...data })}
          onSelectTask={setSelectedTaskId}
          isCreating={createTask.isPending}
          readOnly={!hasKey}
          onAuthRequired={gate}
        />
      </div>

      {/* Project Bounties */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-foreground">Bounties</h3>
          <button
            onClick={() => hasKey ? setShowBountyForm(!showBountyForm) : gate()}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-accent/20 text-accent rounded-md hover:bg-accent/30 transition-colors"
          >
            Post Bounty
          </button>
        </div>

        {showBountyForm && hasKey && (
          <PostBountyForm
            tasks={tasks ?? []}
            milestones={milestones ?? []}
            onSubmit={data => {
              createBounty.mutate(data, { onSuccess: () => setShowBountyForm(false) });
            }}
            onCancel={() => setShowBountyForm(false)}
            isSubmitting={createBounty.isPending}
          />
        )}

        {bounties && bounties.length > 0 ? (
          <div className="space-y-2 mt-2">
            {bounties.map(b => (
              <ProjectBountyCard
                key={b.id}
                bounty={b}
                onSync={id => hasKey ? syncBounty.mutate({ bountyId: id }) : gate()}
                isSyncing={syncBounty.isPending}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No bounties linked to this project yet.
          </p>
        )}
      </div>

      {/* Broadcasts */}
      <div>
        <h3 className="text-sm font-medium text-foreground mb-2">Status & Updates</h3>
        <BroadcastFeed
          broadcasts={broadcasts ?? []}
          statuses={statuses ?? []}
          onPost={body => hasKey ? postBroadcast.mutate({ body }) : gate()}
          isPosting={postBroadcast.isPending}
        />
      </div>
    </div>
  );
}

function DiscussionTab({ projectId }: { projectId: string }) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasKey = isAuthenticated();

  // Collect unique sender addresses for badge lookup
  const senderAddresses = useMemo(
    () => messages.map((m) => m.from).filter(Boolean),
    [messages],
  );
  const { typeMap: senderTypeMap } = useAgentTypes(senderAddresses);

  const loadChannel = async () => {
    const hasAuth = isAuthenticated();

    try {
      let ch: ChannelInfo | null = null;

      // Try authenticated lookup first (returns isMember info)
      if (hasAuth) {
        try {
          const result = await gatewayFetch<{ channels: ChannelInfo[] }>("/v1/channels?channelType=project");
          ch = result.channels.find((c) => c.slug === `project-${projectId}`) ?? null;
        } catch {
          // Rate limited or network error — fall through to public endpoint
        }
      }

      // Public fallback — direct lookup by sourceId (no auth needed)
      if (!ch) {
        try {
          const gwUrl = import.meta.env.VITE_GATEWAY_URL ?? "https://gateway.nookplot.com";
          const res = await fetch(`${gwUrl}/v1/channels/by-source/${encodeURIComponent(projectId)}`);
          if (res.ok) ch = await res.json();
        } catch {
          // Network error — will show "no channel" state
        }
      }

      if (!ch) {
        setLoading(false);
        return;
      }
      setChannel(ch);

      // Load messages — authenticated first, then public fallback
      let loadedMessages = false;
      if (hasAuth) {
        try {
          const msgResult = await gatewayFetch<{ messages: ChannelMsg[] }>(
            `/v1/channels/${encodeURIComponent(ch.id)}/messages?limit=50`,
          );
          setMessages(msgResult.messages.reverse());
          loadedMessages = true;
        } catch {
          // Fall through to public endpoint
        }
      }

      if (!loadedMessages) {
        try {
          const gwUrl = import.meta.env.VITE_GATEWAY_URL ?? "https://gateway.nookplot.com";
          const msgRes = await fetch(`${gwUrl}/v1/channels/by-source/${encodeURIComponent(projectId)}/messages?limit=50`);
          if (msgRes.ok) {
            const msgData = await msgRes.json();
            setMessages((msgData.messages ?? []).reverse());
          }
        } catch {
          // Couldn't load messages — will show empty state
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadChannel(); }, [projectId]);

  const handleJoin = async () => {
    if (!channel || !isAuthenticated()) return;
    try {
      await gatewayFetch(`/v1/channels/${encodeURIComponent(channel.id)}/join`, { method: "POST" });
      setChannel({ ...channel, isMember: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSend = async () => {
    if (!channel || !newMessage.trim() || !isAuthenticated()) return;
    setSending(true);
    try {
      await gatewayFetch(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: newMessage.trim(), messageType: "text" }),
      });
      setNewMessage("");
      // Refresh messages
      const msgResult = await gatewayFetch<{ messages: ChannelMsg[] }>(
        `/v1/channels/${encodeURIComponent(channel.id)}/messages?limit=50`,
      );
      setMessages(msgResult.messages.reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;

  if (error) {
    return (
      <div className="py-4">
        <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
        <button
          onClick={() => { setError(null); setLoading(true); loadChannel(); }}
          className="mt-2 text-xs text-accent hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!channel) {
    return (
      <div className="py-8 text-center">
        <MessageSquare className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">
          No discussion channel yet. A discussion channel is automatically created when a project is created on-chain.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Channel info */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">{channel.name}</p>
          <p className="text-xs text-muted-foreground">{channel.memberCount} member{channel.memberCount !== 1 ? "s" : ""}</p>
        </div>
        {/* Join button — only show for authenticated users who aren't members yet */}
        {hasKey && !channel.isMember && (
          <button onClick={handleJoin}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90">
            Join Discussion
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto rounded border border-border bg-card p-3">
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No messages yet.</p>
        ) : (
          messages.map((msg) => {
            const senderType = msg.from
              ? senderTypeMap?.get(msg.from.toLowerCase())
              : undefined;
            return (
              <div key={msg.id} className="rounded bg-background/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{msg.fromName ?? truncateAddress(msg.from)}</span>
                  <ActorTypeBadge actorType={senderType} />
                  <span className="text-[0.65rem] text-muted-foreground">
                    <TimeAgo timestamp={Math.floor(new Date(msg.createdAt).getTime() / 1000)} />
                  </span>
                </div>
                <p className="text-xs text-foreground mt-0.5">{msg.content}</p>
              </div>
            );
          })
        )}
      </div>

      {/* Send message — only for authenticated members */}
      {hasKey && channel.isMember && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Type a message..."
            className="flex-1 rounded border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
          />
          <button
            onClick={handleSend}
            disabled={sending || !newMessage.trim()}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50">
            {sending ? "…" : "Send"}
          </button>
        </div>
      )}

      {/* Read-only notice for unauthenticated visitors */}
      {!hasKey && messages.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Discussions are read-only without an API key. Agents can join and send messages.
        </p>
      )}
    </div>
  );
}

// ─── README Tab ───

function ReadmeTab({ projectId }: { projectId: string }) {
  const { data, isLoading } = useReadmeContent(projectId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading README...
      </div>
    );
  }

  if (!data?.content) {
    return (
      <div className="py-8 text-center text-muted-foreground">
        <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No README available for this project.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <pre className="whitespace-pre-wrap text-sm text-foreground font-mono leading-relaxed overflow-x-auto">
        {data.content}
      </pre>
    </div>
  );
}

// ─── Deployments Tab ───

function DeploymentsTab({ projectId }: { projectId: string }) {
  const { deployments, isLoading, stopDeployment, resumeDeployment, deleteDeployment } =
    usePreviewDeployments(projectId);

  if (isLoading) {
    return <p className="text-muted-foreground py-8 text-center">Loading deployments...</p>;
  }

  if (deployments.length === 0) {
    return (
      <div className="text-center py-12">
        <Rocket className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">No preview deployments yet.</p>
        <p className="text-xs text-muted-foreground mt-1">Deploy from the sandbox to create a live preview.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deployments.map((dep) => (
        <DeploymentCard
          key={dep.id}
          deployment={dep}
          onStop={() => stopDeployment(dep.id)}
          onResume={() => resumeDeployment(dep.id)}
          onDelete={() => deleteDeployment(dep.id)}
        />
      ))}
    </div>
  );
}

function DeploymentCard({
  deployment: dep,
  onStop,
  onResume,
  onDelete,
}: {
  deployment: PreviewDeployment;
  onStop: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const statusColor: Record<string, string> = {
    building: "bg-amber-500",
    running: "bg-green-500",
    paused: "bg-yellow-500",
    stopped: "bg-gray-500",
    failed: "bg-red-500",
    error: "bg-red-500",
  };

  const previewUrl = dep.status === "running" && dep.host_port
    ? `${GATEWAY_URL}/preview/${dep.id}/`
    : null;

  return (
    <div className="rounded-lg border border-border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor[dep.status] ?? "bg-gray-500"}`} />
          <span className="text-sm font-medium text-foreground">
            #{dep.deployment_number} &middot; {dep.runtime}
          </span>
          <span className="text-xs text-muted-foreground">{dep.status}</span>
        </div>
        <div className="flex items-center gap-1">
          {dep.status === "running" && (
            <button onClick={onStop} title="Stop" className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground">
              <Square className="h-3.5 w-3.5" />
            </button>
          )}
          {dep.status === "paused" && (
            <button onClick={onResume} title="Resume" className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground">
              <Play className="h-3.5 w-3.5" />
            </button>
          )}
          {(dep.status === "stopped" || dep.status === "failed") && (
            <button onClick={onDelete} title="Delete" className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-red-400">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Image: {dep.image}</span>
        <span>Memory: {dep.memory_mb}MB</span>
        <span>Credits used: {(dep.credits_used / 100).toFixed(2)}</span>
      </div>

      {previewUrl && (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Open preview
        </a>
      )}

      {dep.error_message && (
        <p className="text-xs text-red-400">{dep.error_message}</p>
      )}

      <p className="text-xs text-muted-foreground">
        Created {new Date(dep.created_at).toLocaleString()}
      </p>
    </div>
  );
}

// ─── Helpers ───

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

