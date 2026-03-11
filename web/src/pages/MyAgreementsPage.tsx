import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { Link } from "react-router-dom";
import { useGatewayQuery } from "@/hooks/useGatewayQuery";
import { ServiceStatusBadge } from "@/components/marketplace/ServiceStatusBadge";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import {
  useDeliverWork,
  useSettleAgreement,
  useDisputeAgreement,
  useCancelAgreement,
} from "@/hooks/useServiceActions";
import { formatUnits } from "viem";
import { Coins, Clock, ArrowLeft, AlertCircle, CreditCard, LogIn } from "lucide-react";
import { resolveTokenMeta } from "@/config/constants";
import { gatewayFetch } from "@/lib/gateway";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";

interface SubgraphAgreement {
  id: string;
  listing: { id: string; category: string };
  buyer: { id: string };
  provider: { id: string };
  termsCid: string;
  deliveryCid: string | null;
  escrowAmount: string;
  escrowType: number;
  escrowToken?: string | null;
  status: number;
  deadline: string;
  createdAt: string;
  settledAt: string | null;
}

/** Shape returned by GET /v1/index/agents/:addr/agreements */
interface IndexAgreementsResponse {
  asBuyer: Array<{
    id: string;
    listing_id: string;
    listing_category: string;
    buyer_id: string;
    provider_id: string;
    terms_cid: string;
    delivery_cid: string | null;
    escrow_amount: string;
    escrow_type: number;
    escrow_token?: string | null;
    status: number;
    deadline: string;
    created_at: string;
    settled_at: string | null;
  }>;
  asProvider: Array<{
    id: string;
    listing_id: string;
    listing_category: string;
    buyer_id: string;
    provider_id: string;
    terms_cid: string;
    delivery_cid: string | null;
    escrow_amount: string;
    escrow_type: number;
    escrow_token?: string | null;
    status: number;
    deadline: string;
    created_at: string;
    settled_at: string | null;
  }>;
}

function toSubgraphAgreement(raw: IndexAgreementsResponse["asBuyer"][number]): SubgraphAgreement {
  return {
    id: raw.id,
    listing: { id: raw.listing_id, category: raw.listing_category },
    buyer: { id: raw.buyer_id },
    provider: { id: raw.provider_id },
    termsCid: raw.terms_cid,
    deliveryCid: raw.delivery_cid,
    escrowAmount: raw.escrow_amount,
    escrowType: raw.escrow_type,
    escrowToken: raw.escrow_token ?? null,
    status: raw.status,
    deadline: raw.deadline,
    createdAt: raw.created_at,
    settledAt: raw.settled_at,
  };
}

interface Result {
  asBuyer: SubgraphAgreement[];
  asProvider: SubgraphAgreement[];
}

interface CreditAgreementRow {
  id: string;
  listing_id: number;
  credit_amount: number;
  status: string;
  terms: string;
  created_at: string;
}

const STATUS_FILTERS = [
  { label: "All", value: null },
  { label: "Agreed", value: 1 },
  { label: "Delivered", value: 2 },
  { label: "Settled", value: 3 },
  { label: "Disputed", value: 4 },
  { label: "Cancelled", value: 5 },
];

export function MyAgreementsPage() {
  const { address } = useAccount();
  const [tab, setTab] = useState<"buyer" | "provider">("buyer");
  const [statusFilter, setStatusFilter] = useState<number | null>(null);
  const [creditAgreements, setCreditAgreements] = useState<CreditAgreementRow[]>([]);
  const [creditLoading, setCreditLoading] = useState(false);
  const hasSession = hasGatewaySession();

  // Fetch credit-based agreements
  useEffect(() => {
    if (!hasSession) return;
    setCreditLoading(true);
    gatewayFetch<CreditAgreementRow[]>("/v1/marketplace/credit-agreements")
      .then(setCreditAgreements)
      .catch(() => setCreditAgreements([]))
      .finally(() => setCreditLoading(false));
  }, [hasSession]);

  const normalizedAddress = address?.toLowerCase() ?? "";

  const rawResult = useGatewayQuery<IndexAgreementsResponse>(
    ["myAgreements", normalizedAddress],
    `/v1/index/agents/${normalizedAddress}/agreements`,
    { enabled: !!address, staleTime: 15_000 },
  );

  // Transform to expected camelCase shape
  const transformedData: Result | undefined = rawResult.data
    ? {
        asBuyer: rawResult.data.asBuyer?.map(toSubgraphAgreement) ?? [],
        asProvider: rawResult.data.asProvider?.map(toSubgraphAgreement) ?? [],
      }
    : undefined;

  const { deliverWork, isPending: delivering } = useDeliverWork();
  const { settleAgreement, isPending: settling } = useSettleAgreement();
  const { disputeAgreement, isPending: disputing } = useDisputeAgreement();
  const { cancelAgreement, isPending: cancelling } = useCancelAgreement();

  const agreements = tab === "buyer"
    ? (transformedData?.asBuyer ?? [])
    : (transformedData?.asProvider ?? []);

  // Sort delivered (pending review) agreements to top when viewing as buyer
  const sorted = tab === "buyer"
    ? [...agreements].sort((a, b) => {
        if (a.status === 2 && b.status !== 2) return -1;
        if (a.status !== 2 && b.status === 2) return 1;
        return Number(b.createdAt) - Number(a.createdAt);
      })
    : agreements;

  const filtered = statusFilter !== null
    ? sorted.filter((a) => a.status === statusFilter)
    : sorted;

  if (!address && !hasSession) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <div className="p-3 bg-accent/10 rounded-full">
          <LogIn className="h-6 w-6 text-accent" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold">Sign in to view your agreements</h2>
          <p className="text-sm text-muted-foreground">
            Create a free account to hire agents and track your work.
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

  return (
    <div className="space-y-6">
      <Link to="/marketplace" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Back to marketplace
      </Link>

      <h1 className="text-2xl font-bold">My Agreements</h1>

      {/* On-Chain Agreements section — only when wallet is connected */}
      {address && (
        <>
          {/* Tabs */}
          <div className="flex gap-2">
            <button
              onClick={() => setTab("buyer")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                tab === "buyer"
                  ? "bg-accent text-white"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              As Buyer ({transformedData?.asBuyer?.length ?? 0})
            </button>
            <button
              onClick={() => setTab("provider")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                tab === "provider"
                  ? "bg-accent text-white"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              As Provider ({transformedData?.asProvider?.length ?? 0})
            </button>
          </div>

          {/* Status Filters */}
          <div className="flex gap-2 flex-wrap">
            {STATUS_FILTERS.map((opt) => (
              <button
                key={opt.label}
                onClick={() => setStatusFilter(opt.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  statusFilter === opt.value
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-muted-foreground hover:border-border-hover"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* List */}
          {rawResult.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-28 animate-pulse rounded-lg bg-card" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No on-chain agreements found.</p>
              {statusFilter !== null && (
                <button
                  onClick={() => setStatusFilter(null)}
                  className="mt-2 text-sm text-accent hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((agreement) => {
            const counterparty = tab === "buyer" ? agreement.provider.id : agreement.buyer.id;
            const deadlineDate = new Date(Number(agreement.deadline) * 1000);
            const isBuyer = tab === "buyer";
            const isAgreementProvider = tab === "provider";

            // Calculate auto-settle countdown for delivered agreements
            const autoSettleDays = agreement.status === 2
              ? Math.max(0, Math.ceil((deadlineDate.getTime() + 14 * 86400_000 - Date.now()) / 86400_000))
              : null;

            return (
              <Link
                key={agreement.id}
                to={`/marketplace/agreements/${agreement.id}`}
                className="block border border-border rounded-lg p-4 space-y-3 hover:border-accent/40 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Agreement #{agreement.id}</span>
                    <ServiceStatusBadge status={agreement.status} />
                    {/* Pending Review badge for delivered agreements when viewing as buyer */}
                    {agreement.status === 2 && isBuyer && (
                      <span className="flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                        <AlertCircle className="h-3 w-3" />
                        Pending Review
                      </span>
                    )}
                    <span
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      className="text-xs text-accent hover:underline"
                    >
                      <Link to={`/marketplace/${agreement.listing.id}`}>
                        Listing #{agreement.listing.id}
                      </Link>
                    </span>
                  </div>
                  {agreement.escrowAmount !== "0" && (() => {
                    const aMeta = resolveTokenMeta(agreement.escrowToken);
                    return (
                      <span className="flex items-center gap-1 text-sm text-accent">
                        <Coins className="h-3.5 w-3.5" />
                        {parseFloat(formatUnits(BigInt(agreement.escrowAmount), aMeta.decimals)).toFixed(2)} {aMeta.symbol}
                      </span>
                    );
                  })()}
                </div>

                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <ProceduralAvatar address={counterparty} size={20} className="shrink-0" />
                    <span>{tab === "buyer" ? "Provider" : "Buyer"}:</span>
                    <AddressDisplay address={counterparty} />
                  </div>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {deadlineDate.toLocaleDateString()}
                  </span>
                  {autoSettleDays !== null && (
                    <span className={`text-xs font-medium ${autoSettleDays <= 3 ? "text-red-400" : "text-amber-400"}`}>
                      Auto-settles in {autoSettleDays}d
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-wrap" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                  {agreement.status === 1 && isAgreementProvider && (
                    <button
                      onClick={() => deliverWork(BigInt(agreement.id), JSON.stringify({ delivered: true, timestamp: Date.now() }))}
                      disabled={delivering}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                    >
                      {delivering ? "Delivering..." : "Deliver Work"}
                    </button>
                  )}

                  {agreement.status === 2 && isBuyer && (
                    <button
                      onClick={() => settleAgreement(BigInt(agreement.id))}
                      disabled={settling}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {settling ? "Approving..." : "Approve & Pay"}
                    </button>
                  )}

                  {[1, 2].includes(agreement.status) && (isBuyer || isAgreementProvider) && (
                    <button
                      onClick={() => disputeAgreement(BigInt(agreement.id), "")}
                      disabled={disputing}
                      className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {disputing ? "Disputing..." : "Dispute"}
                    </button>
                  )}

                  {agreement.status === 1 && isBuyer && (
                    <button
                      onClick={() => cancelAgreement(BigInt(agreement.id))}
                      disabled={cancelling}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-border-hover disabled:opacity-50"
                    >
                      {cancelling ? "Cancelling..." : "Cancel"}
                    </button>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
          )}
        </>
      )}

      {/* Credit-Based Agreements — visible for ALL session users */}
      {hasSession && (
        <>
          <div className="flex items-center gap-3 pt-4 border-t border-border">
            <CreditCard className="h-5 w-5 text-accent" />
            <h2 className="text-xl font-bold">Credit Agreements</h2>
            <span className="text-xs text-muted-foreground">({creditAgreements.length})</span>
          </div>

          {creditLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-20 animate-pulse rounded-lg bg-card" />
              ))}
            </div>
          ) : creditAgreements.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">No credit agreements yet.</p>
              <Link to="/marketplace" className="mt-2 inline-block text-sm text-accent hover:underline">
                Browse marketplace to hire an agent
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {creditAgreements.map((ca) => (
                <Link
                  key={ca.id}
                  to={`/marketplace/credit-agreements/${ca.id}`}
                  className="block border border-border rounded-lg p-4 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Listing #{ca.listing_id}</span>
                      <span className="rounded-full bg-accent/10 border border-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
                        Credits
                      </span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground capitalize">
                        {ca.status}
                      </span>
                    </div>
                    <span className="flex items-center gap-1 text-sm text-accent font-medium">
                      <Coins className="h-3.5 w-3.5" />
                      {(ca.credit_amount / 100).toFixed(2)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {new Date(ca.created_at).toLocaleDateString()}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
