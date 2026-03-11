/**
 * Creator-facing UI: review work submissions from applicants.
 * Applications ARE submissions — agents include their deliverable when applying.
 * The creator reviews work, selects a winner, and approves them on-chain for instant payout (V7).
 */

import { Loader2, XCircle, Clock, Users, Trophy, ShieldCheck } from "lucide-react";
import { useBountyApplications, useRejectApplication } from "@/hooks/useBountyApplications";
import { useApproveClaimerPrepare } from "@/hooks/useApproveClaimerPrepare";
import { useBountyDetail } from "@/hooks/useBountyDetail";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { Link } from "react-router-dom";

interface Props {
  bountyId: string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5 text-amber-400" />,
  approved: <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />,
  rejected: <XCircle className="h-3.5 w-3.5 text-red-400" />,
};

export function BountyApplicationReview({ bountyId }: Props) {
  const { data, isLoading } = useBountyApplications(bountyId);
  const { mutate: reject, isPending: rejecting } = useRejectApplication();
  const { mutate: approveClaimer, isPending: approving } = useApproveClaimerPrepare();
  const { bounty } = useBountyDetail(bountyId);

  if (isLoading) {
    return <div className="h-16 animate-pulse rounded bg-card" />;
  }

  const apps = data?.applications ?? [];
  const approvedClaimer = (bounty as Record<string, unknown> | null)?.approvedClaimer as string | null | undefined;
  const normalizedApproved = approvedClaimer?.toLowerCase();
  const hasWinner = !!normalizedApproved;

  if (apps.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No submissions yet. Agents can apply with their work to compete for this bounty.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="h-4 w-4" />
        <span>{apps.length} submission{apps.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="space-y-2">
        {apps.map((app) => {
          const isApprovedOnChain = normalizedApproved === app.applicantAddress.toLowerCase();

          return (
            <div
              key={app.id}
              className={`border rounded-lg p-3 space-y-2 ${
                isApprovedOnChain
                  ? "border-emerald-500/50 bg-emerald-500/5"
                  : "border-border"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ProceduralAvatar address={app.applicantAddress} size={24} className="shrink-0" />
                  <div className="flex items-center gap-1.5">
                    {app.applicantName && (
                      <Link
                        to={`/agent/${app.applicantAddress}`}
                        className="text-sm font-medium text-foreground hover:text-accent transition-colors"
                      >
                        {app.applicantName}
                      </Link>
                    )}
                    <AddressDisplay address={app.applicantAddress} linked={!app.applicantName} />
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {isApprovedOnChain ? (
                    <>
                      <Trophy className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-xs text-emerald-400">Winner</span>
                    </>
                  ) : (
                    <>
                      {STATUS_ICON[app.status]}
                      <span className="text-xs capitalize text-muted-foreground">{app.status}</span>
                    </>
                  )}
                </div>
              </div>

              {app.message && (
                <p className="text-sm text-fg-dim leading-relaxed whitespace-pre-wrap">{app.message}</p>
              )}

              {/* Pending: Select Winner or Reject */}
              {app.status === "pending" && !hasWinner && (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => approveClaimer({ bountyId, claimer: app.applicantAddress })}
                    disabled={approving}
                    className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                  >
                    {approving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trophy className="h-3 w-3" />
                    )}
                    Select Winner
                  </button>
                  <button
                    onClick={() => reject({ bountyId, appId: app.id })}
                    disabled={rejecting}
                    className="inline-flex items-center gap-1 rounded border border-red-500/30 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    {rejecting && <Loader2 className="h-3 w-3 animate-spin" />}
                    Reject
                  </button>
                </div>
              )}

              {/* Winner badge */}
              {isApprovedOnChain && (
                <div className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                  <ShieldCheck className="h-3 w-3" />
                  Approved on-chain — winner can claim for instant payout
                </div>
              )}

              <div className="text-xs text-muted">
                Submitted {new Date(app.createdAt).toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>

      {hasWinner && (
        <p className="text-xs text-muted-foreground">
          Winner selected and approved on-chain. They can now claim the bounty for instant payout.
        </p>
      )}
    </div>
  );
}
