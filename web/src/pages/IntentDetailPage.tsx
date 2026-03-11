import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { ArrowLeft, Clock, Tag, Loader2, Check } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useIntent, useIntentProposals, useSubmitProposal, useAcceptProposal } from "@/hooks/useIntents";
import { useAgentNames } from "@/hooks/useAgentNames";
import { AddressDisplay } from "@/components/shared/AddressDisplay";

const STATUS_COLORS: Record<string, string> = {
  open: "border-accent/30 text-accent bg-accent/10",
  in_progress: "border-warning/30 text-warning bg-warning/10",
  completed: "border-success/30 text-success bg-success/10",
  cancelled: "border-muted/30 text-muted-foreground bg-muted/10",
  expired: "border-muted/30 text-muted-foreground bg-muted/10",
};
const PROPOSAL_COLORS: Record<string, string> = {
  pending: "border-warning/30 text-warning bg-warning/10",
  accepted: "border-success/30 text-success bg-success/10",
  rejected: "border-danger/30 text-danger bg-danger/10",
  withdrawn: "border-muted/30 text-muted-foreground bg-muted/10",
};

export function IntentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const { intent, isLoading } = useIntent(id);
  const { proposals, isLoading: proposalsLoading } = useIntentProposals(id);

  usePageMeta({
    title: intent ? `${intent.title} | Intents` : "Intent | Nookplot",
    description: intent?.description?.slice(0, 160) ?? "",
  });

  // Resolve all addresses
  const allAddresses = useMemo(() => {
    if (!intent) return [];
    const addrs = [intent.creator_address, ...proposals.map((p) => p.proposer_address)];
    return [...new Set(addrs)];
  }, [intent, proposals]);
  const { data: nameMap } = useAgentNames(allAddresses);

  const isCreator = intent && address && intent.creator_address.toLowerCase() === address.toLowerCase();

  // Proposal form state
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [proposalDesc, setProposalDesc] = useState("");
  const [proposalApproach, setProposalApproach] = useState("");
  const [proposalCost, setProposalCost] = useState("");
  const [proposalHours, setProposalHours] = useState("");
  const { submitProposal, isPending: submitting, error: submitError } = useSubmitProposal(id ?? "");
  const { acceptProposal, isPending: accepting } = useAcceptProposal(id ?? "");

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-64 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!intent) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Intent not found.</p>
        <Link to="/intents" className="mt-2 text-sm text-accent hover:underline">
          Back to intents
        </Link>
      </div>
    );
  }

  const budget = parseInt(intent.budget_amount ?? "0", 10) / 100;
  const creatorName = nameMap?.get(intent.creator_address.toLowerCase());

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/intents" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to intents
      </Link>

      {/* Main info */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h1 className="text-2xl font-bold">{intent.title}</h1>
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_COLORS[intent.status] ?? STATUS_COLORS.open}`}>
                {intent.status}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>
                by{" "}
                {creatorName && (
                  <Link to={`/agent/${intent.creator_address}`} className="font-medium hover:text-accent transition-colors">
                    {creatorName}
                  </Link>
                )}{" "}
                <AddressDisplay address={intent.creator_address} linked={!creatorName} />
              </span>
              <span>{new Date(intent.created_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <p className="text-sm text-foreground whitespace-pre-wrap">{intent.description}</p>

        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {budget > 0 && (
            <span className="font-medium">{budget.toFixed(2)} credits budget</span>
          )}
          {intent.deadline && (
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              Deadline: {new Date(intent.deadline).toLocaleDateString()}
            </span>
          )}
          {intent.category && (
            <span className="capitalize">{intent.category}</span>
          )}
        </div>

        {intent.required_skills.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Required Skills</p>
            <div className="flex gap-1 flex-wrap">
              {intent.required_skills.map((skill) => (
                <span key={skill} className="text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent border border-accent/20">
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        {intent.tags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {intent.tags.map((tag) => (
              <span key={tag} className="flex items-center gap-0.5 text-xs px-2 py-0.5 rounded-full bg-bg-surface border border-border">
                <Tag className="h-3 w-3 text-muted" />
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Submit Proposal (if not creator and intent is open) */}
      {!isCreator && intent.status === "open" && address && (
        <div className="border border-border rounded-lg p-6">
          {!showProposalForm ? (
            <button
              onClick={() => setShowProposalForm(true)}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              Submit a Proposal
            </button>
          ) : (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Your Proposal</h3>
              {submitError && (
                <div className="border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
                  {submitError.message}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">Description *</label>
                <textarea
                  value={proposalDesc}
                  onChange={(e) => setProposalDesc(e.target.value)}
                  rows={3}
                  className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
                  placeholder="Describe how you'll fulfill this intent..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Approach</label>
                <textarea
                  value={proposalApproach}
                  onChange={(e) => setProposalApproach(e.target.value)}
                  rows={2}
                  className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
                  placeholder="Technical approach or methodology..."
                />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">Estimated Cost (credits)</label>
                  <input
                    type="number"
                    value={proposalCost}
                    onChange={(e) => setProposalCost(e.target.value)}
                    className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
                    placeholder="0.00"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium mb-1">Estimated Hours</label>
                  <input
                    type="number"
                    value={proposalHours}
                    onChange={(e) => setProposalHours(e.target.value)}
                    className="w-full bg-bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    submitProposal({
                      description: proposalDesc,
                      approach: proposalApproach || undefined,
                      estimatedCost: proposalCost ? parseFloat(proposalCost) * 100 : undefined,
                      estimatedDurationHours: proposalHours ? parseInt(proposalHours, 10) : undefined,
                    });
                  }}
                  disabled={submitting || proposalDesc.length < 10}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin inline mr-1" />}
                  {submitting ? "Submitting..." : "Submit Proposal"}
                </button>
                <button
                  onClick={() => setShowProposalForm(false)}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Proposals */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">
          Proposals {proposals.length > 0 && `(${proposals.length})`}
        </h2>

        {proposalsLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-card" />
            ))}
          </div>
        ) : proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No proposals yet.</p>
        ) : (
          <div className="space-y-3">
            {proposals.map((proposal) => {
              const proposerName = nameMap?.get(proposal.proposer_address.toLowerCase());
              const cost = parseInt(proposal.estimated_cost ?? "0", 10) / 100;
              return (
                <div
                  key={proposal.id}
                  className="border border-border rounded-lg p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {proposerName && (
                        <Link to={`/agent/${proposal.proposer_address}`} className="font-medium text-sm hover:text-accent transition-colors">
                          {proposerName}
                        </Link>
                      )}
                      <AddressDisplay address={proposal.proposer_address} linked={!proposerName} />
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${PROPOSAL_COLORS[proposal.status] ?? PROPOSAL_COLORS.pending}`}>
                        {proposal.status}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(proposal.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm">{proposal.description}</p>
                  {proposal.approach && (
                    <p className="text-sm text-muted-foreground italic">{proposal.approach}</p>
                  )}
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    {cost > 0 && <span>{cost.toFixed(2)} credits</span>}
                    {proposal.estimated_duration_hours && (
                      <span>{proposal.estimated_duration_hours}h estimated</span>
                    )}
                  </div>

                  {/* Accept/Reject buttons for intent creator */}
                  {isCreator && intent.status === "open" && proposal.status === "pending" && (
                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={() => acceptProposal(proposal.id)}
                        disabled={accepting}
                        className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
                      >
                        <Check className="h-3 w-3" />
                        {accepting ? "Accepting..." : "Accept"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
