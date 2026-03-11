import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { ArrowLeft, Coins, Clock, AlertTriangle, ExternalLink } from "lucide-react";
import { useAgreementDetail } from "@/hooks/useAgreementDetail";
import { useAgreementMessages } from "@/hooks/useAgreementMessages";
import { useAgentNames } from "@/hooks/useAgentNames";
import { useIpfsContent } from "@/hooks/useIpfsContent";
import {
  useDeliverWork,
  useSettleAgreement,
  useDisputeAgreement,
  useCancelAgreement,
} from "@/hooks/useServiceActions";
import { ServiceStatusBadge } from "@/components/marketplace/ServiceStatusBadge";
import { StatusTimeline } from "@/components/marketplace/StatusTimeline";
import { MessageThread } from "@/components/marketplace/MessageThread";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { resolveTokenMeta } from "@/config/constants";
import { getSessionInfo } from "@/lib/authSession";

function daysUntil(deadline: string | null, graceDays = 14): number | null {
  if (!deadline) return null;
  const deadlineMs = Number(deadline) > 1e12
    ? Number(deadline)
    : Number(deadline) * 1000;
  const graceEnd = deadlineMs + graceDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((graceEnd - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function AgreementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address: walletAddress } = useAccount();
  const sessionInfo = getSessionInfo();

  const { agreement, isLoading, refetch } = useAgreementDetail(id);
  const { messages, sendMessage, isSending } = useAgreementMessages(id);

  const addresses = useMemo(() => {
    if (!agreement) return [];
    return [agreement.buyer_address, agreement.provider_address].filter(Boolean);
  }, [agreement]);

  const { data: nameMap } = useAgentNames(addresses);

  // Delivery content (IPFS) — only fetched if party and delivery exists
  const { data: deliveryContent } = useIpfsContent<{
    description?: string;
    deliverables?: string[];
    delivered?: string;
  }>(agreement?.delivery_cid ?? undefined);

  // Terms content (IPFS)
  const { data: termsContent } = useIpfsContent<{
    terms?: string;
    description?: string;
  }>(agreement?.terms_cid ?? undefined);

  // Role detection
  const currentAddress = walletAddress?.toLowerCase() ?? sessionInfo?.address?.toLowerCase();
  const isBuyer = currentAddress === agreement?.buyer_address?.toLowerCase();
  const isProvider = currentAddress === agreement?.provider_address?.toLowerCase();
  const isParty = isBuyer || isProvider;

  // Contract action hooks
  const { deliverWork, isPending: delivering, isSuccess: deliverSuccess } = useDeliverWork();
  const { settleAgreement, isPending: settling, isSuccess: settleSuccess } = useSettleAgreement();
  const { disputeAgreement, isPending: disputing } = useDisputeAgreement();
  const { cancelAgreement, isPending: cancelling } = useCancelAgreement();

  // Refetch after successful tx
  if (deliverSuccess || settleSuccess) {
    setTimeout(() => refetch(), 3000);
  }

  // Auto-settle countdown
  const daysLeft = agreement?.status === "delivered"
    ? daysUntil(agreement.deadline)
    : null;

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-card" />
        <div className="h-24 animate-pulse rounded-lg bg-card" />
        <div className="h-64 animate-pulse rounded-lg bg-card" />
      </div>
    );
  }

  if (!agreement) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Agreement not found.</p>
        <Link to="/marketplace/agreements" className="mt-2 text-sm text-accent hover:underline">
          Back to my agreements
        </Link>
      </div>
    );
  }

  const statusNum = { agreed: 1, delivered: 2, settled: 3, disputed: 4, cancelled: 5 }[agreement.status] ?? 0;
  const tokenMeta = resolveTokenMeta(agreement.escrow_token);
  const buyerName = nameMap?.get(agreement.buyer_address);
  const providerName = nameMap?.get(agreement.provider_address);

  // Build address map for message thread (agent_id → address)
  const addressMap: Record<string, string> = {};
  if (agreement.buyer_agent_id) addressMap[agreement.buyer_agent_id] = agreement.buyer_address;
  if (agreement.provider_agent_id) addressMap[agreement.provider_agent_id] = agreement.provider_address;

  const currentAgentId = isBuyer ? agreement.buyer_agent_id : isProvider ? agreement.provider_agent_id : undefined;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/marketplace/agreements" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to my agreements
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">Agreement #{agreement.agreement_id}</h1>
          <ServiceStatusBadge status={statusNum} />
        </div>
        <div className="flex items-center gap-3">
          {agreement.escrow_amount !== "0" && (
            <span className="flex items-center gap-1 text-sm font-medium text-accent">
              <Coins className="h-4 w-4" />
              {parseFloat(formatUnits(BigInt(agreement.escrow_amount), tokenMeta.decimals)).toFixed(2)} {tokenMeta.symbol}
            </span>
          )}
          <Link
            to={`/marketplace/${agreement.listing_id}`}
            className="text-xs text-accent hover:underline flex items-center gap-1"
          >
            Listing #{agreement.listing_id}
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* Status Timeline */}
      <div className="border border-border rounded-lg p-4">
        <StatusTimeline
          status={agreement.status}
          createdAt={agreement.created_at}
          deadline={agreement.deadline}
          settledAt={agreement.settled_at}
        />
      </div>

      {/* Auto-settle warning */}
      {isBuyer && agreement.status === "delivered" && daysLeft !== null && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
          <p className="text-sm text-amber-300">
            {daysLeft > 0
              ? `Escrow auto-releases to provider in ${daysLeft} day${daysLeft === 1 ? "" : "s"} if not reviewed.`
              : "Grace period has expired. Escrow may be released to provider."}
          </p>
        </div>
      )}

      {/* Info grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm border border-border rounded-lg p-4">
        <div>
          <span className="text-muted-foreground">Buyer</span>
          <div className="mt-1 flex items-center gap-1.5">
            <ProceduralAvatar address={agreement.buyer_address} size={20} />
            {buyerName && (
              <Link to={`/agent/${agreement.buyer_address}`} className="font-medium hover:text-accent text-sm">
                {buyerName}
              </Link>
            )}
            <AddressDisplay address={agreement.buyer_address} linked={!buyerName} />
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Provider</span>
          <div className="mt-1 flex items-center gap-1.5">
            <ProceduralAvatar address={agreement.provider_address} size={20} />
            {providerName && (
              <Link to={`/agent/${agreement.provider_address}`} className="font-medium hover:text-accent text-sm">
                {providerName}
              </Link>
            )}
            <AddressDisplay address={agreement.provider_address} linked={!providerName} />
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Deadline</span>
          <div className="mt-1 flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {agreement.deadline
              ? new Date(Number(agreement.deadline) > 1e12 ? Number(agreement.deadline) : Number(agreement.deadline) * 1000).toLocaleDateString()
              : "None"}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Created</span>
          <div className="mt-1">
            {new Date(agreement.created_at).toLocaleDateString()}
          </div>
        </div>
      </div>

      {/* Terms section */}
      {termsContent && (
        <div className="border border-border rounded-lg p-4 space-y-2">
          <h2 className="text-sm font-semibold">Agreement Terms</h2>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {termsContent.terms ?? termsContent.description ?? "No terms description available."}
          </p>
        </div>
      )}

      {/* Delivery section — PARTY-ONLY */}
      {statusNum >= 2 && isParty && agreement.delivery_cid && (
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Delivered Work</h2>
            {!agreement.buyer_viewed_delivery_at && isBuyer && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
                NEW
              </span>
            )}
          </div>
          {deliveryContent ? (
            <div className="space-y-2">
              {deliveryContent.description && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {deliveryContent.description}
                </p>
              )}
              {deliveryContent.deliverables && deliveryContent.deliverables.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground">Deliverables:</span>
                  <ul className="mt-1 space-y-1">
                    {deliveryContent.deliverables.map((d, i) => (
                      <li key={i} className="text-sm text-foreground">{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading delivery content...</p>
          )}
        </div>
      )}

      {/* Public-facing delivery indicator (non-party) */}
      {statusNum >= 2 && !isParty && (
        <div className="border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Work has been submitted. Delivery details are only visible to the buyer and provider.</p>
        </div>
      )}

      {/* Action bar */}
      {isParty && (
        <div className="flex gap-2 flex-wrap">
          {agreement.status === "agreed" && isProvider && (
            <button
              onClick={() => deliverWork(BigInt(agreement.agreement_id), JSON.stringify({ delivered: true, timestamp: Date.now() }))}
              disabled={delivering}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {delivering ? "Delivering..." : "Deliver Work"}
            </button>
          )}

          {agreement.status === "delivered" && isBuyer && (
            <button
              onClick={() => settleAgreement(BigInt(agreement.agreement_id))}
              disabled={settling}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {settling ? "Settling..." : "Approve & Pay"}
            </button>
          )}

          {["agreed", "delivered"].includes(agreement.status) && (
            <button
              onClick={() => disputeAgreement(BigInt(agreement.agreement_id), "")}
              disabled={disputing}
              className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              {disputing ? "Disputing..." : "Dispute"}
            </button>
          )}

          {agreement.status === "agreed" && isBuyer && (
            <button
              onClick={() => cancelAgreement(BigInt(agreement.agreement_id))}
              disabled={cancelling}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:border-border-hover disabled:opacity-50"
            >
              {cancelling ? "Cancelling..." : "Cancel Agreement"}
            </button>
          )}
        </div>
      )}

      {/* Message thread — party-only */}
      {isParty && (
        <MessageThread
          messages={messages}
          currentAgentId={currentAgentId}
          buyerAgentId={agreement.buyer_agent_id}
          providerAgentId={agreement.provider_agent_id}
          nameMap={nameMap}
          addressMap={addressMap}
          status={agreement.status}
          isBuyer={isBuyer}
          onSend={sendMessage}
          isSending={isSending}
        />
      )}
    </div>
  );
}
