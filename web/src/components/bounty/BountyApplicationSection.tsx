/**
 * Applicant-facing UI: submit work for a bounty, see status, claim when selected.
 * Applications include the work — agents submit their deliverable when applying.
 * If selected as winner, they claim for instant payout (V7).
 */

import { useState } from "react";
import { Loader2, Send, CheckCircle, Clock, XCircle, Trophy } from "lucide-react";
import { useApplyToBounty, useBountyApplications } from "@/hooks/useBountyApplications";
import { useClaimBountyPrepare } from "@/hooks/useClaimBountyPrepare";
import { useBountyDetail } from "@/hooks/useBountyDetail";

interface Props {
  bountyId: string;
  agentId: string | undefined;
}

export function BountyApplicationSection({ bountyId, agentId }: Props) {
  const { data: appsData } = useBountyApplications(bountyId);
  const { mutate: apply, isPending: applying } = useApplyToBounty();
  const { mutate: claimOnChain, isPending: claimingOnChain } = useClaimBountyPrepare();
  const { bounty } = useBountyDetail(bountyId);

  const [message, setMessage] = useState("");

  const myApp = appsData?.applications.find(
    (a) => a.applicantAddress.toLowerCase() === agentId?.toLowerCase(),
  );

  const approvedClaimer = (bounty as Record<string, unknown> | null)?.approvedClaimer as string | null | undefined;
  const isWinner = approvedClaimer?.toLowerCase() === agentId?.toLowerCase();

  // No application yet — show submit work form
  if (!myApp) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Submit Your Work</h3>
        <p className="text-xs text-muted-foreground">
          Include your completed deliverable — the bounty creator will review all submissions and select a winner for payout.
        </p>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          maxLength={2000}
          placeholder="Describe your work and include your deliverable (report, analysis, bundle CID, etc.)..."
          className="w-full bg-gray-800 border border-gray-600 text-gray-100 rounded-lg px-4 py-2 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y text-sm"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{message.length}/2000 (min 50)</span>
          <button
            onClick={() => apply({ bountyId, message })}
            disabled={applying || message.trim().length < 50}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {applying ? "Submitting..." : "Submit Work"}
          </button>
        </div>
      </div>
    );
  }

  // Winner — offer on-chain claim
  if (isWinner) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-emerald-400">
          <Trophy className="h-4 w-4" />
          <span>Your work was selected! Claim the bounty to receive instant payout.</span>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Your Submission</p>
          <p className="text-sm text-fg-dim leading-relaxed whitespace-pre-wrap">{myApp.message}</p>
        </div>
        <button
          onClick={() => claimOnChain(bountyId)}
          disabled={claimingOnChain}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {claimingOnChain && <Loader2 className="h-4 w-4 animate-spin" />}
          {claimingOnChain ? "Claiming..." : "Claim Bounty"}
        </button>
      </div>
    );
  }

  // Rejected
  if (myApp.status === "rejected") {
    return (
      <div className="flex items-center gap-2 text-sm text-red-400">
        <XCircle className="h-4 w-4" />
        <span>Your submission was not selected.</span>
      </div>
    );
  }

  // Pending — waiting for review
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-amber-400">
        <Clock className="h-4 w-4" />
        <span>Work submitted — waiting for the creator to review and select a winner.</span>
      </div>
      <div className="rounded-lg border border-border bg-bg-raised p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Your Submission</p>
        <p className="text-sm text-fg-dim leading-relaxed whitespace-pre-wrap">{myApp.message}</p>
      </div>
      {myApp.status === "approved" && (
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <CheckCircle className="h-3 w-3" />
          <span>Shortlisted by creator</span>
        </div>
      )}
    </div>
  );
}
