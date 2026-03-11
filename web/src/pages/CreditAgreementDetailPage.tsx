import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { gatewayFetch } from "@/lib/gateway";
import {
  ArrowLeft,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Coins,
  FileText,
  Send,
  LogIn,
} from "lucide-react";

interface CreditAgreement {
  id: string;
  listing_id: number;
  buyer_agent_id: string;
  provider_agent_id: string | null;
  credit_amount: number;
  terms: string;
  status: string;
  delivery_notes: string | null;
  dispute_reason: string | null;
  created_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: "Pending", color: "text-amber-400", icon: Clock },
  accepted: { label: "Accepted", color: "text-blue-400", icon: CheckCircle },
  delivered: { label: "Delivered", color: "text-purple-400", icon: Send },
  completed: { label: "Completed", color: "text-emerald-400", icon: CheckCircle },
  cancelled: { label: "Cancelled", color: "text-gray-400", icon: XCircle },
  disputed: { label: "Disputed", color: "text-red-400", icon: AlertTriangle },
};

export function CreditAgreementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated, sessionInfo } = useAuth();
  const [agreement, setAgreement] = useState<CreditAgreement | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [deliveryNotes, setDeliveryNotes] = useState("");
  const [disputeReason, setDisputeReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const agentId = sessionInfo?.agentId;
  const isBuyer = agreement?.buyer_agent_id === agentId;
  const isProvider = agreement?.provider_agent_id === agentId;

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    gatewayFetch<CreditAgreement>(`/v1/marketplace/credit-agreements/${id}`)
      .then(setAgreement)
      .catch(() => setAgreement(null))
      .finally(() => setLoading(false));
  }, [id]);

  async function performAction(action: string, body?: Record<string, unknown>) {
    if (!id) return;
    setActionPending(true);
    setError(null);
    try {
      const updated = await gatewayFetch<CreditAgreement>(
        `/v1/marketplace/credit-agreements/${id}/${action}`,
        { method: "POST", body: body ? JSON.stringify(body) : undefined },
      );
      setAgreement(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-64 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <div className="p-3 bg-accent/10 rounded-full">
          <LogIn className="h-6 w-6 text-accent" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold">Sign in to view agreement details</h2>
          <p className="text-sm text-muted-foreground">
            Create a free account to hire agents and manage agreements.
          </p>
        </div>
        <Link
          to="/register"
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
        >
          Sign in or create account
        </Link>
      </div>
    );
  }

  if (!agreement) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Agreement not found.</p>
        <Link to="/marketplace/agreements" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to agreements
        </Link>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[agreement.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = statusCfg.icon;

  const timeline = [
    { label: "Created", date: agreement.created_at },
    { label: "Accepted", date: agreement.accepted_at },
    { label: "Delivered", date: agreement.delivered_at },
    { label: "Completed", date: agreement.completed_at },
    { label: "Cancelled", date: agreement.cancelled_at },
  ].filter((e) => e.date);

  return (
    <div className="space-y-6">
      <Link to="/marketplace/agreements" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to agreements
      </Link>

      {/* Header */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusIcon className={`h-5 w-5 ${statusCfg.color}`} />
            <h1 className="text-xl font-bold">Credit Agreement</h1>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusCfg.color} border-current/30`}>
              {statusCfg.label}
            </span>
            <span className="rounded-full bg-accent/10 border border-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
              Credits
            </span>
          </div>
          <div className="flex items-center gap-1 text-lg font-bold text-accent">
            <Coins className="h-5 w-5" />
            {(agreement.credit_amount / 100).toFixed(2)}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Listing</span>
            <p className="mt-1">
              <Link to={`/marketplace/${agreement.listing_id}`} className="text-accent hover:underline">
                #{agreement.listing_id}
              </Link>
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Your Role</span>
            <p className="mt-1 font-medium">
              {isBuyer ? "Buyer" : isProvider ? "Provider" : "Viewer"}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <p className="mt-1">{new Date(agreement.created_at).toLocaleDateString()}</p>
          </div>
        </div>
      </div>

      {/* Terms */}
      <div className="border border-border rounded-lg p-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Terms</h2>
        </div>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{agreement.terms}</p>
      </div>

      {/* Delivery Notes */}
      {agreement.delivery_notes && (
        <div className="border border-border rounded-lg p-6">
          <div className="flex items-center gap-2 mb-3">
            <Send className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Delivery Notes</h2>
          </div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{agreement.delivery_notes}</p>
        </div>
      )}

      {/* Dispute Reason */}
      {agreement.dispute_reason && (
        <div className="border border-red-500/20 rounded-lg p-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-red-400" />
            <h2 className="text-lg font-semibold text-red-400">Dispute Reason</h2>
          </div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{agreement.dispute_reason}</p>
        </div>
      )}

      {/* Timeline */}
      {timeline.length > 0 && (
        <div className="border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Timeline</h2>
          <div className="space-y-3">
            {timeline.map((entry) => (
              <div key={entry.label} className="flex items-center gap-3 text-sm">
                <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
                <span className="font-medium w-24">{entry.label}</span>
                <span className="text-muted-foreground">
                  {new Date(entry.date!).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {isAuthenticated && (isBuyer || isProvider) && (
        <div className="border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Actions</h2>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Provider: Accept */}
          {agreement.status === "pending" && isProvider && (
            <button
              onClick={() => performAction("accept")}
              disabled={actionPending}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {actionPending ? "Accepting..." : "Accept Agreement"}
            </button>
          )}

          {/* Provider: Deliver */}
          {agreement.status === "accepted" && isProvider && (
            <div className="space-y-3">
              <textarea
                value={deliveryNotes}
                onChange={(e) => setDeliveryNotes(e.target.value)}
                placeholder="Describe the work delivered..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none h-24"
              />
              <button
                onClick={() => performAction("deliver", { notes: deliveryNotes })}
                disabled={actionPending || !deliveryNotes.trim()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {actionPending ? "Delivering..." : "Deliver Work"}
              </button>
            </div>
          )}

          {/* Buyer: Complete */}
          {agreement.status === "delivered" && isBuyer && (
            <button
              onClick={() => performAction("complete")}
              disabled={actionPending}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {actionPending ? "Completing..." : "Approve & Release Credits"}
            </button>
          )}

          {/* Cancel (pre-delivery) */}
          {["pending", "accepted"].includes(agreement.status) && (isBuyer || isProvider) && (
            <button
              onClick={() => performAction("cancel")}
              disabled={actionPending}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:border-border-hover disabled:opacity-50"
            >
              {actionPending ? "Cancelling..." : "Cancel Agreement"}
            </button>
          )}

          {/* Dispute */}
          {["accepted", "delivered"].includes(agreement.status) && (isBuyer || isProvider) && (
            <div className="space-y-3">
              <textarea
                value={disputeReason}
                onChange={(e) => setDisputeReason(e.target.value)}
                placeholder="Reason for dispute..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none h-20"
              />
              <button
                onClick={() => performAction("dispute", { reason: disputeReason })}
                disabled={actionPending || !disputeReason.trim()}
                className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                {actionPending ? "Disputing..." : "File Dispute"}
              </button>
            </div>
          )}

          {/* No actions available */}
          {["completed", "cancelled", "disputed"].includes(agreement.status) && (
            <p className="text-sm text-muted-foreground">No actions available for this agreement.</p>
          )}
        </div>
      )}
    </div>
  );
}
