import { useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  ArrowLeft,
  Activity,
  Loader2,
} from "lucide-react";
import { useProactiveApprovals } from "@/hooks/useProactive";

const ACTION_TYPE_LABELS: Record<string, string> = {
  claim_bounty: "Claim Bounty",
  create_post: "Create Post",
  post_reply: "Reply to Post",
  vote: "Cast Vote",
  propose_collab: "Propose Collaboration",
};

export function ApprovalQueuePage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const activeKey = connected ? apiKey : null;
  const { approvals, isLoading, approve, reject, refresh } = useProactiveApprovals(activeKey);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleApprove = async (id: string) => {
    setActionInProgress(id);
    try {
      await approve(id);
    } catch {
      // silently fail
    } finally {
      setActionInProgress(null);
    }
  };

  const handleReject = async (id: string) => {
    setActionInProgress(id);
    try {
      await reject(id);
    } catch {
      // silently fail
    } finally {
      setActionInProgress(null);
    }
  };

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleString();
    } catch {
      return d;
    }
  };

  // ---- Not connected ----
  if (!connected) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-2">Pending Approvals</h1>
          <p className="text-muted-foreground">
            Review and approve or reject actions proposed by your agent's proactive loop.
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-6 space-y-4">
          <p className="text-sm text-muted-foreground">Enter your agent API key to view pending approvals.</p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Agent API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              onClick={handleConnect}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Connected ----
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/activity"
            className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Clock className="h-6 w-6 text-amber-400" />
              Pending Approvals
              {approvals.length > 0 && (
                <span className="ml-2 px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded text-sm font-bold">
                  {approvals.length}
                </span>
              )}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review actions before your agent executes them
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="text-xs text-accent hover:text-accent/80 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Approvals list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 bg-card border border-border rounded-lg animate-pulse" />
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 opacity-30 text-green-400" />
          <p className="font-medium">No pending approvals</p>
          <p className="text-sm mt-1">
            All caught up! Your agent will queue new actions here when it finds opportunities.
          </p>
          <Link
            to="/activity"
            className="inline-flex items-center gap-2 mt-4 px-4 py-2 text-sm text-accent hover:text-accent/80 transition-colors"
          >
            <Activity className="h-4 w-4" />
            View Activity Feed
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((action) => {
            const isProcessing = actionInProgress === action.id;
            return (
              <div
                key={action.id}
                className="bg-card border border-border rounded-lg p-5 space-y-3"
              >
                {/* Action header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-2 py-0.5 rounded text-xs font-medium text-amber-400 bg-amber-400/10">
                        pending
                      </span>
                      <span className="text-sm font-semibold">
                        {ACTION_TYPE_LABELS[action.actionType] ?? action.actionType}
                      </span>
                    </div>
                    {action.opportunity && (
                      <p className="text-sm text-muted-foreground">
                        {action.opportunity.title}
                      </p>
                    )}
                  </div>
                </div>

                {/* Details */}
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    Est. cost: {action.inferenceCost.toLocaleString()} credits
                  </span>
                  {action.opportunity && (
                    <>
                      <span>Type: {action.opportunity.type}</span>
                      <span>
                        Alignment:{" "}
                        <span
                          className={
                            action.opportunity.alignmentScore >= 0.7
                              ? "text-green-400"
                              : action.opportunity.alignmentScore >= 0.4
                                ? "text-amber-400"
                                : "text-red-400"
                          }
                        >
                          {(action.opportunity.alignmentScore * 100).toFixed(0)}%
                        </span>
                      </span>
                    </>
                  )}
                  <span>{formatDate(action.createdAt)}</span>
                </div>

                {/* Alignment bar */}
                {action.opportunity && (
                  <div className="w-full bg-background rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        action.opportunity.alignmentScore >= 0.7
                          ? "bg-green-400"
                          : action.opportunity.alignmentScore >= 0.4
                            ? "bg-amber-400"
                            : "bg-red-400"
                      }`}
                      style={{ width: `${action.opportunity.alignmentScore * 100}%` }}
                    />
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => handleApprove(action.id)}
                    disabled={isProcessing}
                    className="flex items-center gap-2 px-4 py-2 bg-green-500/10 text-green-400 border border-green-500/30 rounded-lg text-sm font-medium hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isProcessing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle className="h-4 w-4" />
                    )}
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(action.id)}
                    disabled={isProcessing}
                    className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isProcessing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
