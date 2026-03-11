/**
 * Merge requests tab for the project detail page.
 *
 * Shows a filterable list of merge requests with status badges,
 * inline detail expansion, and merge/close actions.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  GitPullRequest, GitMerge, Loader2, ChevronDown, ChevronRight,
  GitCommit, XCircle, FilePlus, FilePen, FileX,
} from "lucide-react";
import {
  useMergeRequests,
  useMergeRequestDetail,
  useMergeMR,
  useCloseMR,
  type MergeRequest,
  type FileCommitChange,
} from "@/hooks/useProjectForks";
import { truncateAddress } from "@/lib/format";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { isAuthenticated } from "@/lib/authSession";

// ─── Status filter tabs ───

type StatusFilter = "open" | "merged" | "closed" | undefined;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: undefined, label: "All" },
  { key: "open", label: "Open" },
  { key: "merged", label: "Merged" },
  { key: "closed", label: "Closed" },
];

// ─── Status badge ───

function MRStatusBadge({ status }: { status: MergeRequest["status"] }) {
  if (status === "merged") {
    return (
      <span className="flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-green-500/20 text-green-400 font-medium">
        <GitMerge className="h-3 w-3" /> Merged
      </span>
    );
  }
  if (status === "closed") {
    return (
      <span className="flex items-center gap-1 rounded px-2 py-0.5 text-xs bg-gray-500/20 text-gray-400 font-medium">
        <XCircle className="h-3 w-3" /> Closed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded px-2 py-0.5 text-xs border border-green-500/40 text-green-400 font-medium">
      <GitPullRequest className="h-3 w-3" /> Open
    </span>
  );
}

// ─── MR Detail (inline expand) ───

function MRDetail({ projectId, mrId }: { projectId: string; mrId: string }) {
  const { data: detail, isLoading } = useMergeRequestDetail(projectId, mrId);
  const mergeMut = useMergeMR(projectId);
  const closeMut = useCloseMR(projectId);
  const hasKey = isAuthenticated();

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-8 my-2" />;
  if (!detail) return null;

  return (
    <div className="ml-4 mt-2 space-y-3 border-l-2 border-border pl-4">
      {/* Description */}
      {detail.description && (
        <p className="text-sm text-muted-foreground">{detail.description}</p>
      )}

      {/* Source project */}
      {detail.sourceProjectId && (
        <p className="text-xs text-muted-foreground">
          From:{" "}
          <Link to={`/projects/${detail.sourceProjectId}`} className="text-accent hover:underline">
            {detail.sourceProjectName || detail.sourceProjectId}
          </Link>
        </p>
      )}

      {/* Commits list */}
      {detail.commits && detail.commits.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">
            Commits ({detail.commits.length})
          </p>
          {detail.commits.map((c) => (
            <div key={c.commitId} className="flex items-center gap-2 rounded border border-border bg-card px-3 py-2">
              <GitCommit className="h-3 w-3 text-accent shrink-0" />
              <span className="text-xs text-foreground truncate flex-1">{c.message}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {c.authorName || "unknown"} · +{c.linesAdded} −{c.linesRemoved}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* File diffs */}
      {detail.fileDiffs && detail.fileDiffs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground">
            Files changed ({detail.fileDiffs.length})
          </p>
          {detail.fileDiffs.map((d: FileCommitChange) => (
            <div key={d.filePath} className="flex items-center gap-2 rounded border border-border bg-card px-3 py-1.5">
              {d.changeType === "added" && <FilePlus className="h-3 w-3 text-green-400 shrink-0" />}
              {d.changeType === "modified" && <FilePen className="h-3 w-3 text-yellow-400 shrink-0" />}
              {d.changeType === "deleted" && <FileX className="h-3 w-3 text-red-400 shrink-0" />}
              <span className="text-xs text-foreground truncate flex-1 font-mono">{d.filePath}</span>
              <span className={`text-xs font-medium ${
                d.changeType === "added" ? "text-green-400" :
                d.changeType === "deleted" ? "text-red-400" : "text-yellow-400"
              }`}>
                {d.changeType}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Actions (only for open MRs when authenticated) */}
      {hasKey && detail.status === "open" && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => mergeMut.mutate({ mrId })}
            disabled={mergeMut.isPending}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            <GitMerge className="h-3 w-3" />
            {mergeMut.isPending ? "Merging..." : "Merge"}
          </button>
          <button
            onClick={() => closeMut.mutate({ mrId })}
            disabled={closeMut.isPending}
            className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <XCircle className="h-3 w-3" />
            {closeMut.isPending ? "Closing..." : "Close"}
          </button>
          {mergeMut.isError && (
            <p className="text-xs text-red-400">{mergeMut.error?.message}</p>
          )}
          {closeMut.isError && (
            <p className="text-xs text-red-400">{closeMut.error?.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───

export function MergeRequestsTab({ projectId }: { projectId: string }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(undefined);
  const [expandedMR, setExpandedMR] = useState<string | null>(null);
  const { data: mergeRequests, isLoading } = useMergeRequests(projectId, statusFilter);

  if (isLoading) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto mt-8" />;
  }

  return (
    <div className="space-y-4">
      {/* Status filter tabs */}
      <div className="flex gap-1">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setStatusFilter(f.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
              statusFilter === f.key
                ? "bg-accent/20 text-accent"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* MR list */}
      {!mergeRequests || mergeRequests.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No merge requests{statusFilter ? ` with status "${statusFilter}"` : ""}.
        </p>
      ) : (
        <div className="space-y-2">
          {mergeRequests.map((mr) => (
            <div key={mr.id}>
              <button
                onClick={() => setExpandedMR(expandedMR === mr.id ? null : mr.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left hover:border-accent/30 transition-colors"
              >
                {expandedMR === mr.id
                  ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                }
                <GitPullRequest className="h-4 w-4 text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{mr.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {mr.authorName ?? truncateAddress(mr.authorAddress)} · {mr.commitIds.length} commit{mr.commitIds.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <MRStatusBadge status={mr.status} />
                <span className="text-xs text-muted-foreground shrink-0">
                  <TimeAgo timestamp={Math.floor(new Date(mr.createdAt).getTime() / 1000)} />
                </span>
              </button>
              {expandedMR === mr.id && <MRDetail projectId={projectId} mrId={mr.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
