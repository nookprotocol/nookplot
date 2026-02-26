import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { useServiceDetail } from "@/hooks/useServiceDetail";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { ServiceStatusBadge } from "@/components/marketplace/ServiceStatusBadge";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import {
  useCreateAgreement,
  useDeliverWork,
  useSettleAgreement,
  useDisputeAgreement,
  useCancelAgreement,
} from "@/hooks/useServiceActions";
import { formatUnits } from "viem";
import { ArrowLeft, Coins, CheckCircle, Tag, Clock } from "lucide-react";

const PRICING_LABELS: Record<number, string> = {
  0: "Per Task",
  1: "Hourly",
  2: "Subscription",
  3: "Custom",
};

const AGREEMENT_STATUS: Record<number, string> = {
  0: "Listed",
  1: "Agreed",
  2: "Delivered",
  3: "Settled",
  4: "Disputed",
  5: "Cancelled",
};

export function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const { listing, isLoading } = useServiceDetail(id);

  const { createAgreement, isPending: creating } = useCreateAgreement();
  const { deliverWork, isPending: delivering } = useDeliverWork();
  const { settleAgreement, isPending: settling } = useSettleAgreement();
  const { disputeAgreement, isPending: disputing } = useDisputeAgreement();
  const { cancelAgreement, isPending: cancelling } = useCancelAgreement();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-64 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Listing not found.</p>
        <Link to="/marketplace" className="mt-2 text-sm text-accent hover:underline">
          Back to marketplace
        </Link>
      </div>
    );
  }

  const isProvider = address?.toLowerCase() === listing.provider.id?.toLowerCase();
  const completedCount = Number(listing.totalCompleted);
  const disputedCount = Number(listing.totalDisputed);
  const totalJobs = completedCount + disputedCount;
  const successRate = totalJobs > 0 ? Math.round((completedCount / totalJobs) * 100) : 0;

  function handleHire() {
    if (!id) return;
    const termsCid = JSON.stringify({ terms: "Standard agreement", timestamp: Date.now() });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60); // 7 days
    createAgreement(BigInt(id), termsCid, deadline);
  }

  return (
    <div className="space-y-6">
      <Link to="/marketplace" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to marketplace
      </Link>

      {/* Listing Details */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <ProceduralAvatar address={listing.provider.id} size={48} className="shrink-0" />
            <div>
              <h1 className="text-xl font-bold mb-1">Service #{listing.id}</h1>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 border border-accent/20 px-2 py-0.5 text-xs text-accent">
                  <Tag className="h-3 w-3" />
                  {listing.category}
                </span>
                <span className="text-xs text-muted-foreground">
                  {PRICING_LABELS[listing.pricingModel] ?? "Custom"}
                </span>
                {!listing.active && (
                  <span className="rounded-full bg-gray-500/15 border border-gray-500/30 px-2 py-0.5 text-xs text-gray-400">
                    Inactive
                  </span>
                )}
              </div>
            </div>
          </div>
          {listing.priceAmount !== "0" && (
            <div className="flex items-center gap-1 text-lg font-bold text-accent">
              <Coins className="h-5 w-5" />
              {parseFloat(formatUnits(BigInt(listing.priceAmount), 6)).toFixed(2)} USDC
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Provider</span>
            <div className="mt-1">
              <AddressDisplay address={listing.provider.id} />
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Completed</span>
            <div className="mt-1 flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-emerald-400" />
              {completedCount} jobs
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Success Rate</span>
            <p className="mt-1">{totalJobs > 0 ? `${successRate}%` : "N/A"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Listed</span>
            <p className="mt-1">{new Date(Number(listing.createdAt) * 1000).toLocaleDateString()}</p>
          </div>
        </div>

        {/* CID */}
        {listing.metadataCid && (
          <div className="text-xs text-muted">
            <span>Metadata: </span>
            <code className="text-muted-foreground">{listing.metadataCid}</code>
          </div>
        )}
      </div>

      {/* Hire Action */}
      {listing.active && !isProvider && address && !isAgent && (
        <div className="border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Hire This Agent</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Create an agreement to hire this agent. A 7-day deadline will be set by default.
          </p>
          <button
            onClick={handleHire}
            disabled={creating}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {creating ? "Creating Agreement..." : "Hire Agent"}
          </button>
        </div>
      )}

      {!address && listing.active && (
        <div className="border border-border rounded-lg p-6">
          <p className="text-sm text-muted-foreground">
            Connect your wallet to hire this agent.
          </p>
        </div>
      )}

      {/* Agreements */}
      {listing.agreements && listing.agreements.length > 0 && (
        <div className="border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Agreements</h2>
          <div className="space-y-3">
            {listing.agreements.map((agreement) => {
              const isBuyer = address?.toLowerCase() === agreement.buyer.id?.toLowerCase();
              const isAgreementProvider = address?.toLowerCase() === agreement.provider.id?.toLowerCase();
              const deadlineDate = new Date(Number(agreement.deadline) * 1000);

              return (
                <div key={agreement.id} className="border border-border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Agreement #{agreement.id}</span>
                      <ServiceStatusBadge status={agreement.status} />
                    </div>
                    {agreement.escrowAmount !== "0" && (
                      <span className="flex items-center gap-1 text-sm text-accent">
                        <Coins className="h-3.5 w-3.5" />
                        {parseFloat(formatUnits(BigInt(agreement.escrowAmount), 6)).toFixed(2)} USDC
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div>
                      Buyer: <AddressDisplay address={agreement.buyer.id} />
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {deadlineDate.toLocaleDateString()}
                    </div>
                  </div>

                  {/* Agreement Actions */}
                  <div className="flex gap-2 flex-wrap">
                    {/* Provider can deliver when Agreed */}
                    {!isAgent && agreement.status === 1 && isAgreementProvider && (
                      <button
                        onClick={() => deliverWork(BigInt(agreement.id), JSON.stringify({ delivered: true, timestamp: Date.now() }))}
                        disabled={delivering}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                      >
                        {delivering ? "Delivering..." : "Deliver Work"}
                      </button>
                    )}

                    {/* Buyer can settle when Delivered */}
                    {!isAgent && agreement.status === 2 && isBuyer && (
                      <button
                        onClick={() => settleAgreement(BigInt(agreement.id))}
                        disabled={settling}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {settling ? "Settling..." : "Settle & Pay"}
                      </button>
                    )}

                    {/* Either party can dispute when Agreed or Delivered */}
                    {!isAgent && [1, 2].includes(agreement.status) && (isBuyer || isAgreementProvider) && (
                      <button
                        onClick={() => disputeAgreement(BigInt(agreement.id), "")}
                        disabled={disputing}
                        className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {disputing ? "Disputing..." : "Dispute"}
                      </button>
                    )}

                    {/* Buyer can cancel when Agreed (before delivery) */}
                    {!isAgent && agreement.status === 1 && isBuyer && (
                      <button
                        onClick={() => cancelAgreement(BigInt(agreement.id))}
                        disabled={cancelling}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-border-hover disabled:opacity-50"
                      >
                        {cancelling ? "Cancelling..." : "Cancel"}
                      </button>
                    )}

                    {/* Terminal states */}
                    {[3, 4, 5].includes(agreement.status) && (
                      <p className="text-xs text-muted-foreground py-1.5">
                        {AGREEMENT_STATUS[agreement.status]}. No further actions.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
