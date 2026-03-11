import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useBountyDetail } from "@/hooks/useBountyDetail";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { BountyStatusBadge } from "@/components/bounty/BountyStatusBadge";
import { BountyApplicationSection } from "@/components/bounty/BountyApplicationSection";
import { BountyApplicationReview } from "@/components/bounty/BountyApplicationReview";
import { BountyActivityTimeline } from "@/components/bounty/BountyActivityTimeline";
import { SubmitWorkForm } from "@/components/bounty/SubmitWorkForm";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { useAgentNames } from "@/hooks/useAgentNames";
import { useAgentTypes } from "@/hooks/useAgentTypes";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { useMemo, useCallback } from "react";
import {
  useUnclaimBounty,
  useApproveWork,
  useDisputeWork,
  useCancelBounty,
  useExpireBounty,
  useExpireSubmitted,
} from "@/hooks/useBountyActions";
import { usePlatformFeeBps } from "@/hooks/usePlatformFeeBps";
import { useSubmitWorkPrepare } from "@/hooks/useSubmitWorkPrepare";
import { useBountyApplications } from "@/hooks/useBountyApplications";
import { formatUnits } from "viem";
import { Clock, Coins, ArrowLeft, Users, FileText, Trophy, ShieldCheck, XCircle, FlaskConical, Bot, ClipboardCheck, Code } from "lucide-react";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { useIpfsContent } from "@/hooks/useIpfsContent";
import { resolveTokenMeta } from "@/config/constants";
import { BountyVerificationBadge, type VerificationStatus } from "@/components/bounty/BountyVerificationBadge";
import { useBountySubmissions } from "@/hooks/useBountySubmissions";
import { gatewayFetch } from "@/lib/gateway";
import { useState } from "react";

/** IPFS bounty metadata shape */
interface BountyMeta {
  title?: string;
  description?: string;
}

const STATUS_LABELS: Record<number, string> = {
  0: "Open",
  1: "Claimed",
  2: "Submitted",
  3: "Approved",
  4: "Disputed",
  5: "Cancelled",
  6: "Expired",
};

export function BountyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { bounty, isLoading, isError } = useBountyDetail(id);

  // Use gateway-resolved title (instant), fall back to IPFS fetch
  const { data: ipfsMeta } = useIpfsContent<BountyMeta>(
    bounty?.title ? undefined : bounty?.metadataCid,
  );

  const { unclaimBounty, isPending: unclaiming } = useUnclaimBounty();
  const { approveWork, isPending: approving } = useApproveWork();
  const { disputeWork, isPending: disputing } = useDisputeWork();
  const { cancelBounty, isPending: cancelling } = useCancelBounty();
  const { expireBounty, isPending: expiring } = useExpireBounty();
  const { expireSubmitted, isPending: expiringSubmitted } = useExpireSubmitted();
  const { mutate: submitWork, isPending: submitting } = useSubmitWorkPrepare();
  const { data: feeBpsRaw } = usePlatformFeeBps();
  const { data: appsData } = useBountyApplications(id);

  // Resolve agent names for creator + claimer + applicants
  const nameAddresses = useMemo(() => {
    const addrs: string[] = [];
    if (bounty?.creator?.id) addrs.push(bounty.creator.id);
    if (bounty?.claimer?.id) addrs.push(bounty.claimer.id);
    for (const app of appsData?.applications ?? []) {
      addrs.push(app.applicantAddress);
    }
    return [...new Set(addrs)];
  }, [bounty?.creator?.id, bounty?.claimer?.id, appsData]);
  const { data: nameMap } = useAgentNames(nameAddresses);
  const { typeMap } = useAgentTypes(nameAddresses);

  // Submissions with verification status
  const { data: submissionsData } = useBountySubmissions(id);
  const submissions = submissionsData?.submissions ?? [];

  const [runningAction, setRunningAction] = useState<string | null>(null);

  const handleVerificationAction = useCallback(
    async (submissionId: string, action: "run_tests" | "ai_review" | "match_spec") => {
      const key = `${submissionId}-${action}`;
      setRunningAction(key);
      try {
        await gatewayFetch(`/v1/bounties/${id}/submissions/${submissionId}/${action}`, {
          method: "POST",
        });
      } catch {
        // Silently handle — the UI will reflect status on next refetch
      } finally {
        setRunningAction(null);
      }
    },
    [id],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-64 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Failed to load bounty — the server may still be waking up.</p>
        <button onClick={() => window.location.reload()} className="mt-2 text-sm text-accent hover:underline">
          Retry
        </button>
      </div>
    );
  }

  if (!bounty) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Bounty not found.</p>
        <Link to="/bounties" className="mt-2 text-sm text-accent hover:underline">
          Back to bounties
        </Link>
      </div>
    );
  }

  const isCreator = address?.toLowerCase() === bounty.creator?.id?.toLowerCase();
  const isClaimer = bounty.claimer && address?.toLowerCase() === bounty.claimer.id?.toLowerCase();
  const deadlineDate = new Date(Number(bounty.deadline) * 1000);
  const isExpired = deadlineDate < new Date();

  return (
    <div className="space-y-6">
      <Link to="/bounties" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to bounties
      </Link>

      <div className="border border-border rounded-lg p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold mb-2">{bounty.title || ipfsMeta?.title || `Bounty #${bounty.id}`}</h1>
            <div className="flex items-center gap-2 flex-wrap">
              <BountyStatusBadge status={bounty.status} />
              <span className="text-xs text-muted-foreground">{bounty.community}</span>
            </div>
          </div>
          {bounty.rewardAmount !== "0" && (() => {
            const tokenMeta = resolveTokenMeta(bounty.tokenAddress);
            const reward = parseFloat(formatUnits(BigInt(bounty.rewardAmount), tokenMeta.decimals));
            const feePct = Number(feeBpsRaw ?? 250n) / 10000;
            const fee = reward * feePct;
            const net = reward - fee;
            return (
              <div className="text-right">
                <div className="flex items-center gap-1 text-lg font-bold text-accent">
                  <Coins className="h-5 w-5" />
                  {reward.toFixed(2)} {tokenMeta.symbol}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {(feePct * 100).toFixed(1)}% fee — worker nets {net.toFixed(2)} {tokenMeta.symbol}
                </p>
              </div>
            );
          })()}
        </div>

        {/* Info */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Creator</span>
            <div className="mt-1 flex items-center gap-2">
              <ProceduralAvatar address={bounty.creator.id} size={32} className="shrink-0" />
              <div className="flex flex-col gap-0.5">
                {nameMap?.get(bounty.creator.id.toLowerCase()) && (
                  <Link to={`/agent/${bounty.creator.id}`} className="text-sm font-medium text-foreground hover:text-accent transition-colors">
                    {nameMap.get(bounty.creator.id.toLowerCase())}
                  </Link>
                )}
                <div className="flex items-center gap-1.5">
                  <AddressDisplay address={bounty.creator.id} />
                  <ActorTypeBadge actorType={typeMap.get(bounty.creator.id.toLowerCase())} />
                </div>
              </div>
            </div>
          </div>
          {bounty.claimer && (
            <div>
              <span className="text-muted-foreground">Claimer</span>
              <div className="mt-1 flex items-center gap-2">
                <ProceduralAvatar address={bounty.claimer.id} size={32} className="shrink-0" />
                <div className="flex flex-col gap-0.5">
                  {nameMap?.get(bounty.claimer.id.toLowerCase()) && (
                    <Link to={`/agent/${bounty.claimer.id}`} className="text-sm font-medium text-foreground hover:text-accent transition-colors">
                      {nameMap.get(bounty.claimer.id.toLowerCase())}
                    </Link>
                  )}
                  <div className="flex items-center gap-1.5">
                    <AddressDisplay address={bounty.claimer.id} />
                    <ActorTypeBadge actorType={typeMap.get(bounty.claimer.id.toLowerCase())} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div>
            <span className="text-muted-foreground">Deadline</span>
            <div className="mt-1 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {deadlineDate.toLocaleString()}
              {isExpired && <span className="text-red-400 text-xs">(expired)</span>}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Status</span>
            <p className="mt-1">{STATUS_LABELS[bounty.status] ?? "Unknown"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Applications</span>
            <div className="mt-1 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-[#5B8FA8]" />
              <span>{bounty.applicationCount ?? 0}</span>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Submissions</span>
            <div className="mt-1 flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-accent" />
              <span>{bounty.submissionCount ?? 0}</span>
            </div>
          </div>
        </div>

        {/* Description from gateway or IPFS metadata */}
        {(bounty.description || ipfsMeta?.description) && (
          <p className="text-sm text-fg-dim leading-relaxed">{bounty.description || ipfsMeta?.description}</p>
        )}

        {/* CIDs */}
        {bounty.metadataCid && (
          <div className="text-xs text-muted">
            <span>Metadata: </span>
            <code className="text-muted-foreground">{bounty.metadataCid}</code>
          </div>
        )}
        {bounty.submissionCid && (
          <div className="text-xs text-muted">
            <span>Submission: </span>
            <code className="text-muted-foreground">{bounty.submissionCid}</code>
          </div>
        )}
      </div>

      {/* Activity Timeline — visible to everyone */}
      <div className="border border-border rounded-lg p-6 space-y-3">
        <h2 className="text-lg font-semibold">Activity</h2>
        <BountyActivityTimeline bountyId={bounty.id} bounty={bounty} />
      </div>

      {/* Submissions with Verification Status */}
      {submissions.length > 0 && (
        <div className="border border-border rounded-lg p-6 space-y-3">
          <h2 className="text-lg font-semibold">Submissions</h2>
          <div className="space-y-2">
            {submissions.map((sub) => (
              <div key={sub.id} className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ProceduralAvatar address={sub.applicantAddress} size={24} className="shrink-0" />
                    <span className="text-sm font-medium">
                      {sub.applicantName ?? sub.applicantAddress.slice(0, 10) + "..."}
                    </span>
                  </div>
                  <BountyVerificationBadge
                    status={(sub.verificationStatus as VerificationStatus) ?? "unverified"}
                  />
                </div>
                {sub.content && (
                  <p className="text-sm text-fg-dim leading-relaxed whitespace-pre-wrap">{sub.content}</p>
                )}
                {sub.projectId && (
                  <Link
                    to={`/sandbox/${sub.projectId}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
                  >
                    <Code className="h-3 w-3" />
                    View Code in Sandbox
                  </Link>
                )}
                <div className="text-xs text-muted">
                  Submitted {new Date(sub.createdAt).toLocaleString()}
                </div>
                {/* Creator verification actions */}
                {isCreator && (
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => handleVerificationAction(sub.id, "run_tests")}
                      disabled={runningAction === `${sub.id}-run_tests`}
                      className="inline-flex items-center gap-1.5 rounded border border-[#6DB874]/30 px-2.5 py-1 text-xs font-medium text-[#6DB874] hover:bg-[#6DB874]/10 disabled:opacity-50"
                    >
                      <FlaskConical className="h-3 w-3" />
                      {runningAction === `${sub.id}-run_tests` ? "Running..." : "Run Tests"}
                    </button>
                    <button
                      onClick={() => handleVerificationAction(sub.id, "ai_review")}
                      disabled={runningAction === `${sub.id}-ai_review`}
                      className="inline-flex items-center gap-1.5 rounded border border-[#5B8FA8]/30 px-2.5 py-1 text-xs font-medium text-[#5B8FA8] hover:bg-[#5B8FA8]/10 disabled:opacity-50"
                    >
                      <Bot className="h-3 w-3" />
                      {runningAction === `${sub.id}-ai_review` ? "Reviewing..." : "AI Review"}
                    </button>
                    <button
                      onClick={() => handleVerificationAction(sub.id, "match_spec")}
                      disabled={runningAction === `${sub.id}-match_spec`}
                      className="inline-flex items-center gap-1.5 rounded border border-[#C4883A]/30 px-2.5 py-1 text-xs font-medium text-[#C4883A] hover:bg-[#C4883A]/10 disabled:opacity-50"
                    >
                      <ClipboardCheck className="h-3 w-3" />
                      {runningAction === `${sub.id}-match_spec` ? "Matching..." : "Match Spec"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Apply / Review Flow — Open Bounties */}
      {bounty.status === 0 && (
        <div className="border border-border rounded-lg p-6 space-y-6">
          {isCreator ? (
            <div>
              <h2 className="text-lg font-semibold mb-3">Review Submissions</h2>
              <BountyApplicationReview bountyId={bounty.id} />
            </div>
          ) : address ? (
            <BountyApplicationSection bountyId={bounty.id} agentId={address} />
          ) : null}
        </div>
      )}

      {/* Public Applications List — visible to everyone */}
      {(appsData?.applications ?? []).length > 0 && (
        <div className="border border-border rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Users className="h-5 w-5 text-[#5B8FA8]" />
              Applications
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
              >
                {appsData!.applications.length}
              </span>
            </h2>
          </div>
          <div className="space-y-2">
            {appsData!.applications.map((app) => {
              const name = nameMap?.get(app.applicantAddress.toLowerCase()) ?? app.applicantName;
              const approvedClaimer = (bounty as unknown as Record<string, unknown>).approvedClaimer as string | null | undefined;
              const isWinner = approvedClaimer?.toLowerCase() === app.applicantAddress.toLowerCase();

              return (
                <div
                  key={app.id}
                  className={`border rounded-lg p-3 space-y-2 ${
                    isWinner ? "border-emerald-500/50 bg-emerald-500/5" : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ProceduralAvatar address={app.applicantAddress} size={24} className="shrink-0" />
                      <div className="flex items-center gap-1.5">
                        {name && (
                          <Link
                            to={`/agent/${app.applicantAddress}`}
                            className="text-sm font-medium text-foreground hover:text-accent transition-colors"
                          >
                            {name}
                          </Link>
                        )}
                        <AddressDisplay address={app.applicantAddress} linked={!name} />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isWinner ? (
                        <>
                          <Trophy className="h-3.5 w-3.5 text-emerald-400" />
                          <span className="text-xs text-emerald-400">Winner</span>
                        </>
                      ) : app.status === "approved" ? (
                        <>
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                          <span className="text-xs text-emerald-400">Approved</span>
                        </>
                      ) : app.status === "rejected" ? (
                        <>
                          <XCircle className="h-3.5 w-3.5 text-red-400" />
                          <span className="text-xs text-red-400">Rejected</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-3.5 w-3.5 text-amber-400" />
                          <span className="text-xs text-amber-400">Pending</span>
                        </>
                      )}
                    </div>
                  </div>
                  {app.message && (
                    <p className="text-sm text-fg-dim leading-relaxed whitespace-pre-wrap line-clamp-4">{app.message}</p>
                  )}
                  <div className="text-xs text-muted">
                    Submitted {new Date(app.createdAt).toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">Actions</h2>

        {isAgent && (
          <AgentWalletGate action="interact with bounties" />
        )}

        {/* Open — creator can cancel */}
        {!isAgent && bounty.status === 0 && isCreator && (
          <button
            onClick={() => cancelBounty(BigInt(bounty.id))}
            disabled={cancelling}
            className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            {cancelling ? "Cancelling..." : "Cancel Bounty"}
          </button>
        )}

        {/* Claimed — claimer can unclaim or submit */}
        {!isAgent && bounty.status === 1 && isClaimer && (
          <div className="space-y-4">
            <button
              onClick={() => unclaimBounty(BigInt(bounty.id))}
              disabled={unclaiming}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:border-border-hover disabled:opacity-50"
            >
              {unclaiming ? "Unclaiming..." : "Unclaim"}
            </button>
            <SubmitWorkForm
              onSubmit={(description, evidence) => {
                submitWork({
                  bountyId: bounty.id,
                  description,
                  deliverables: evidence,
                });
              }}
              isPending={submitting}
            />
          </div>
        )}

        {/* Submitted — creator can approve or dispute */}
        {!isAgent && bounty.status === 2 && isCreator && (
          <div className="flex gap-2">
            <button
              onClick={() => approveWork(BigInt(bounty.id))}
              disabled={approving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {approving ? "Approving..." : "Approve Work"}
            </button>
            <button
              onClick={() => disputeWork(BigInt(bounty.id))}
              disabled={disputing}
              className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              {disputing ? "Disputing..." : "Dispute"}
            </button>
          </div>
        )}

        {/* Expired Open/Claimed — anyone can trigger expire & refund */}
        {isExpired && (bounty.status === 0 || bounty.status === 1) && address && (
          <button
            onClick={() => expireBounty(BigInt(bounty.id))}
            disabled={expiring}
            className="rounded-lg border border-amber-500/30 px-4 py-2 text-sm font-medium text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
          >
            {expiring ? "Expiring..." : "Expire & Refund Creator"}
          </button>
        )}

        {/* Expired Submitted — anyone can trigger release to worker */}
        {isExpired && bounty.status === 2 && address && (
          <button
            onClick={() => expireSubmitted(BigInt(bounty.id))}
            disabled={expiringSubmitted}
            className="rounded-lg border border-emerald-500/30 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
          >
            {expiringSubmitted ? "Resolving..." : "Resolve — Release to Worker"}
          </button>
        )}

        {/* Disputed — awaiting resolution */}
        {bounty.status === 4 && (
          <p className="text-sm text-amber-400">
            This bounty is disputed and awaiting platform resolution.
          </p>
        )}

        {/* Terminal states (not disputed) */}
        {[3, 5, 6].includes(bounty.status) && (
          <p className="text-sm text-muted-foreground">
            This bounty is {STATUS_LABELS[bounty.status]?.toLowerCase()}. No further actions available.
          </p>
        )}

        {/* Not connected */}
        {!address && bounty.status === 0 && (
          <p className="text-sm text-muted-foreground">
            Connect your wallet to apply for this bounty.
          </p>
        )}
      </div>
    </div>
  );
}
