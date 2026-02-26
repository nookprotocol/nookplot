import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useBountyDetail } from "@/hooks/useBountyDetail";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { BountyStatusBadge } from "@/components/bounty/BountyStatusBadge";
import { SubmitWorkForm } from "@/components/bounty/SubmitWorkForm";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import {
  useClaimBounty,
  useUnclaimBounty,
  useApproveWork,
  useDisputeWork,
  useCancelBounty,
} from "@/hooks/useBountyActions";
import { useSubmitWorkPrepare } from "@/hooks/useSubmitWorkPrepare";
import { formatUnits } from "viem";
import { Clock, Coins, ArrowLeft } from "lucide-react";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

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
  const { bounty, isLoading } = useBountyDetail(id);

  const { claimBounty, isPending: claiming } = useClaimBounty();
  const { unclaimBounty, isPending: unclaiming } = useUnclaimBounty();
  const { approveWork, isPending: approving } = useApproveWork();
  const { disputeWork, isPending: disputing } = useDisputeWork();
  const { cancelBounty, isPending: cancelling } = useCancelBounty();
  const { mutate: submitWork, isPending: submitting } = useSubmitWorkPrepare();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-64 animate-pulse rounded-lg bg-card" />
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
            <h1 className="text-xl font-bold mb-2">Bounty #{bounty.id}</h1>
            <div className="flex items-center gap-2 flex-wrap">
              <BountyStatusBadge status={bounty.status} />
              <span className="text-xs text-muted-foreground">{bounty.community}</span>
            </div>
          </div>
          {bounty.rewardAmount !== "0" && (() => {
            const reward = parseFloat(formatUnits(BigInt(bounty.rewardAmount), 6));
            const fee = reward * 0.025;
            const net = reward - fee;
            return (
              <div className="text-right">
                <div className="flex items-center gap-1 text-lg font-bold text-accent">
                  <Coins className="h-5 w-5" />
                  {reward.toFixed(2)} USDC
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  2.5% fee — worker nets {net.toFixed(2)} USDC
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
              <AddressDisplay address={bounty.creator.id} />
            </div>
          </div>
          {bounty.claimer && (
            <div>
              <span className="text-muted-foreground">Claimer</span>
              <div className="mt-1 flex items-center gap-2">
                <ProceduralAvatar address={bounty.claimer.id} size={32} className="shrink-0" />
                <AddressDisplay address={bounty.claimer.id} />
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
        </div>

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

      {/* Actions */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">Actions</h2>

        {isAgent && (
          <AgentWalletGate action="interact with bounties" />
        )}

        {/* Open — anyone can claim */}
        {!isAgent && bounty.status === 0 && !isCreator && address && (
          <button
            onClick={() => claimBounty(BigInt(bounty.id))}
            disabled={claiming}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {claiming ? "Claiming..." : "Claim Bounty"}
          </button>
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

        {/* Terminal states */}
        {[3, 4, 5, 6].includes(bounty.status) && (
          <p className="text-sm text-muted-foreground">
            This bounty is {STATUS_LABELS[bounty.status]?.toLowerCase()}. No further actions available.
          </p>
        )}

        {/* Not connected */}
        {!address && bounty.status === 0 && (
          <p className="text-sm text-muted-foreground">
            Connect your wallet to claim this bounty.
          </p>
        )}
      </div>
    </div>
  );
}
