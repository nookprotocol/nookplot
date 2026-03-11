/**
 * WorkspaceProposals — Displays workspace proposals with voting controls.
 * Members can create new proposals and vote approve/reject on existing ones.
 */

import { useState } from "react";
import { Plus, Vote, ThumbsUp, ThumbsDown } from "lucide-react";
import {
  useWorkspaceProposals,
  createWorkspaceProposal,
  voteOnProposal,
} from "@/hooks/useWorkspaces";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { truncateAddress } from "@/lib/format";

interface WorkspaceProposalsProps {
  workspaceId: string;
}

function statusBadge(status: string) {
  switch (status) {
    case "open":
      return "bg-[var(--nook-signal-cool)]/15 text-[var(--nook-signal-cool)]";
    case "approved":
    case "executed":
      return "bg-[var(--nook-emerald)]/15 text-[var(--nook-emerald)]";
    case "rejected":
    case "cancelled":
      return "bg-[var(--nook-signal-hot)]/15 text-[var(--nook-signal-hot)]";
    case "expired":
      return "bg-[var(--nook-signal-warm)]/15 text-[var(--nook-signal-warm)]";
    default:
      return "bg-card text-muted-foreground";
  }
}

export function WorkspaceProposals({ workspaceId }: WorkspaceProposalsProps) {
  const { proposals, isLoading, isError, refresh } = useWorkspaceProposals(workspaceId);
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [votingId, setVotingId] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!formTitle.trim()) return;
    setSubmitting(true);
    try {
      await createWorkspaceProposal(workspaceId, formTitle.trim(), formDesc.trim() || undefined);
      setFormTitle("");
      setFormDesc("");
      setShowForm(false);
      refresh();
    } catch {
      // Silently fail
    } finally {
      setSubmitting(false);
    }
  };

  const handleVote = async (proposalId: string, vote: boolean) => {
    setVotingId(proposalId);
    try {
      await voteOnProposal(workspaceId, proposalId, vote);
      refresh();
    } catch {
      // Silently fail
    } finally {
      setVotingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 bg-card rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Failed to load proposals. You may not have access.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Proposals ({proposals.length})
        </span>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New Proposal
        </button>
      </div>

      {/* Inline create form */}
      {showForm && (
        <div className="px-4 py-3 border-b border-border space-y-2 shrink-0">
          <input
            type="text"
            placeholder="Proposal title"
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm"
            autoFocus
          />
          <textarea
            placeholder="Description (optional)"
            value={formDesc}
            onChange={(e) => setFormDesc(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!formTitle.trim() || submitting}
              className="flex-1 rounded-md bg-accent text-white text-sm py-1.5 hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setFormTitle("");
                setFormDesc("");
              }}
              className="px-3 rounded-md border border-border text-sm py-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Proposals list */}
      <div className="flex-1 overflow-y-auto">
        {proposals.length === 0 ? (
          <div className="text-center py-12 px-4">
            <Vote className="h-8 w-8 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm text-muted-foreground">
              No proposals. Members can propose actions for collective voting.
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {proposals.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-border bg-card/50 p-4"
              >
                {/* Title row */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h4 className="text-sm font-medium text-foreground">{p.title}</h4>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide ${statusBadge(
                      p.status,
                    )}`}
                  >
                    {p.status}
                  </span>
                </div>

                {/* Description */}
                {p.description && (
                  <p className="text-xs text-muted-foreground mb-2 line-clamp-3">
                    {p.description}
                  </p>
                )}

                {/* Meta */}
                <div className="flex items-center gap-3 text-[0.65rem] text-muted-foreground mb-3">
                  <span>by {truncateAddress(p.createdBy)}</span>
                  {p.createdAt && <TimeAgo date={p.createdAt} />}
                  {p.actionType && (
                    <span className="px-1.5 py-0.5 rounded bg-card text-[0.6rem] font-mono">
                      {p.actionType}
                    </span>
                  )}
                </div>

                {/* Vote controls */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleVote(p.id, true)}
                    disabled={p.status !== "open" || votingId === p.id}
                    className="flex items-center gap-1.5 rounded-md border border-[var(--nook-emerald)]/30 px-3 py-1.5 text-xs text-[var(--nook-emerald)] hover:bg-[var(--nook-emerald)]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ThumbsUp className="h-3 w-3" />
                    Approve
                    {p.approveCount != null && p.approveCount > 0 && (
                      <span className="ml-0.5 text-[0.65rem] opacity-75">
                        ({p.approveCount})
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => handleVote(p.id, false)}
                    disabled={p.status !== "open" || votingId === p.id}
                    className="flex items-center gap-1.5 rounded-md border border-[var(--nook-signal-hot)]/30 px-3 py-1.5 text-xs text-[var(--nook-signal-hot)] hover:bg-[var(--nook-signal-hot)]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ThumbsDown className="h-3 w-3" />
                    Reject
                    {p.rejectCount != null && p.rejectCount > 0 && (
                      <span className="ml-0.5 text-[0.65rem] opacity-75">
                        ({p.rejectCount})
                      </span>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
