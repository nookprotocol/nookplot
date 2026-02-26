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
  ChevronDown, ChevronRight, UserPlus, Key,
} from "lucide-react";
import { useProjectDetail } from "@/hooks/useProjects";
import { gatewayFetch } from "@/lib/gateway";
import { getApiKey } from "@/hooks/useSandboxFiles";
import {
  useProjectFiles,
  useProjectCommits,
  useCommitDetail,
  useProjectActivity,
  useSubmitReview,
  type FileCommit,
  type ProjectActivityEvent,
} from "@/hooks/useProjectFiles";
import { GatewayKeyInput } from "@/components/sandbox/GatewayKeyInput";
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

type Tab = "overview" | "files" | "commits" | "tasks" | "activity" | "discussion";

export function ProjectDetailPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  if (!projectId) return <p className="p-8 text-muted-foreground">No project ID</p>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <ProjectHeader projectId={projectId} hasKey={hasKey} />
      <TabBar active={activeTab} onChange={setActiveTab} />
      <div className="mt-4">
        {activeTab === "overview" && <OverviewTab projectId={projectId} hasKey={hasKey} />}
        {activeTab === "files" && (hasKey ? <FilesTab projectId={projectId} /> : <NeedsKeyMessage onKeySet={() => setHasKey(true)} feature="browse files" />)}
        {activeTab === "commits" && (hasKey ? <CommitsTab projectId={projectId} /> : <NeedsKeyMessage onKeySet={() => setHasKey(true)} feature="view commits" />)}
        {activeTab === "tasks" && (hasKey ? <TasksTab projectId={projectId} /> : <NeedsKeyMessage onKeySet={() => setHasKey(true)} feature="manage tasks" />)}
        {activeTab === "activity" && (hasKey ? <ActivityTab projectId={projectId} /> : <NeedsKeyMessage onKeySet={() => setHasKey(true)} feature="view activity" />)}
        {activeTab === "discussion" && <DiscussionTab projectId={projectId} />}
      </div>
    </div>
  );
}

/** Inline prompt shown in tabs that require an API key. */
function NeedsKeyMessage({ onKeySet, feature }: { onKeySet: () => void; feature: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-start gap-3 mb-4">
        <Key className="h-5 w-5 text-accent mt-0.5 shrink-0" />
        <div>
          <h3 className="text-sm font-medium text-foreground mb-1">
            API key required to {feature}
          </h3>
          <p className="text-sm text-muted-foreground">
            Enter your nookplot gateway API key to access project files, commits, and activity.
          </p>
        </div>
      </div>
      <GatewayKeyInput onKeySet={onKeySet} />
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
        </div>
      </div>
      {project?.description && (
        <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
      )}
      {project?.creatorAddress && (
        <p className="mt-1 text-xs text-muted-foreground">
          Created by{" "}
          <Link to={`/agent/${project.creatorAddress}`} className="text-accent hover:underline">
            {project.creatorName || truncateAddress(project.creatorAddress)}
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

function OverviewTab({ projectId, hasKey }: { projectId: string; hasKey: boolean }) {
  const { data: project } = useProjectDetail(projectId);
  const { data: commits } = useProjectCommits(projectId, 5);
  const { data: files } = useProjectFiles(projectId);

  return (
    <div className="space-y-6">
      {/* Project info — always visible (public) */}
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

      {/* Stats + recent commits — only if API key is set */}
      {hasKey ? (
        <>
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
        </>
      ) : (
        <div className="rounded-lg border border-border bg-card/50 p-4 text-center">
          <p className="text-sm text-muted-foreground">
            Enter a gateway API key in the Files or Commits tab to see project statistics and recent activity.
          </p>
        </div>
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

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  if (!files || files.length === 0) return (
    <p className="text-sm text-muted-foreground py-8 text-center">No files yet. Commit files via the SDK or CLI.</p>
  );

  return (
    <div className="space-y-2">
      {files.map((f) => (
        <div key={f.path}>
          <button onClick={() => setSelectedFile(selectedFile === f.path ? null : f.path)}
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
    const apiKey = getApiKey();
    if (!apiKey) { setLoading(false); return; }
    gatewayFetch<{ content?: string }>(`/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${filePath}`, apiKey)
      .then((d) => { setContent(d.content ?? ""); setLoading(false); })
      .catch(() => setLoading(false));
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

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  if (!commits || commits.length === 0) return (
    <p className="text-sm text-muted-foreground py-8 text-center">No commits yet.</p>
  );

  return (
    <div className="space-y-2">
      {commits.map((c) => (
        <div key={c.commitId}>
          <CommitRow commit={c} projectId={projectId} expanded={expandedCommit === c.commitId}
            onToggle={() => setExpandedCommit(expandedCommit === c.commitId ? null : c.commitId)} />
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
  const icon = ev.eventType === "file_committed" ? GitCommit
    : ev.eventType === "commit_reviewed" ? CheckCircle
    : ev.eventType === "project_created" ? FolderGit2
    : ev.eventType === "collaborator_added" ? UserPlus
    : AlertCircle;
  const Icon = icon;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--color-accent-soft)" }}>
        <Icon className="h-3.5 w-3.5 text-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">
          <span className="font-medium">{ev.actorName ?? truncateAddress(ev.actorAddress ?? "")}</span>
          {ev.eventType === "project_created" && " created this project"}
          {ev.eventType === "file_committed" && <> committed {(meta.filesChanged as number) ?? 0} files: <span className="text-muted-foreground">{meta.message as string}</span></>}
          {ev.eventType === "commit_reviewed" && <> reviewed a commit: <span className={(meta.verdict as string) === "approve" ? "text-green-400" : "text-red-400"}>{meta.verdict as string}</span></>}
          {ev.eventType === "file_exported" && " exported files to GitHub"}
          {ev.eventType === "collaborator_added" && <> added <span className="font-medium">{(meta.collaboratorName as string) || "a collaborator"}</span> as {(meta.roleName as string) || "editor"}</>}
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
  const { data: tasks, isLoading: tasksLoading } = useProjectTasks(projectId);
  const { data: milestones, isLoading: msLoading } = useProjectMilestones(projectId);
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

  if (tasksLoading || msLoading) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  }

  return (
    <div className="space-y-6">
      {/* Milestones */}
      {milestones && milestones.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2">Milestones</h3>
          <MilestoneBar milestones={milestones} />
        </div>
      )}

      {/* Pending access requests (admin view) */}
      {accessRequests && accessRequests.length > 0 && (
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
        <h3 className="text-sm font-medium text-foreground mb-2">Tasks</h3>
        <TaskList
          tasks={tasks ?? []}
          onCreateTask={data => createTask.mutate(data)}
          onUpdateTask={(taskId, data) => updateTask.mutate({ taskId, ...data })}
          onSelectTask={setSelectedTaskId}
          isCreating={createTask.isPending}
        />
      </div>

      {/* Project Bounties */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-foreground">Bounties</h3>
          <button
            onClick={() => setShowBountyForm(!showBountyForm)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-accent/20 text-accent rounded-md hover:bg-accent/30 transition-colors"
          >
            Post Bounty
          </button>
        </div>

        {showBountyForm && (
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
                onSync={id => syncBounty.mutate({ bountyId: id })}
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
          onPost={body => postBroadcast.mutate({ body })}
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

  const hasKey = !!getApiKey();

  // Collect unique sender addresses for badge lookup
  const senderAddresses = useMemo(
    () => messages.map((m) => m.from).filter(Boolean),
    [messages],
  );
  const { typeMap: senderTypeMap } = useAgentTypes(senderAddresses);

  const loadChannel = async () => {
    const apiKey = getApiKey();

    try {
      let ch: ChannelInfo | null = null;

      // Try authenticated lookup first (returns isMember info)
      if (apiKey) {
        try {
          const result = await gatewayFetch<{ channels: ChannelInfo[] }>("/v1/channels?channelType=project", apiKey);
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
      if (apiKey) {
        try {
          const msgResult = await gatewayFetch<{ messages: ChannelMsg[] }>(
            `/v1/channels/${encodeURIComponent(ch.id)}/messages?limit=50`, apiKey,
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
    if (!channel) return;
    const apiKey = getApiKey();
    if (!apiKey) return;
    try {
      await gatewayFetch(`/v1/channels/${encodeURIComponent(channel.id)}/join`, apiKey, { method: "POST" });
      setChannel({ ...channel, isMember: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSend = async () => {
    if (!channel || !newMessage.trim()) return;
    const apiKey = getApiKey();
    if (!apiKey) return;
    setSending(true);
    try {
      await gatewayFetch(`/v1/channels/${encodeURIComponent(channel.id)}/messages`, apiKey, {
        method: "POST",
        body: JSON.stringify({ content: newMessage.trim(), messageType: "text" }),
      });
      setNewMessage("");
      // Refresh messages
      const msgResult = await gatewayFetch<{ messages: ChannelMsg[] }>(
        `/v1/channels/${encodeURIComponent(channel.id)}/messages?limit=50`, apiKey,
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

// ─── Helpers ───

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

