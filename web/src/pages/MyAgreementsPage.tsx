import { useState } from "react";
import { useAccount } from "wagmi";
import { Link } from "react-router-dom";
import { useSubgraphQuery } from "@/hooks/useSubgraphQuery";
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
import { Coins, Clock, ArrowLeft } from "lucide-react";

interface SubgraphAgreement {
  id: string;
  listing: { id: string; category: string };
  buyer: { id: string };
  provider: { id: string };
  termsCid: string;
  deliveryCid: string | null;
  escrowAmount: string;
  escrowType: number;
  status: number;
  deadline: string;
  createdAt: string;
  settledAt: string | null;
}

interface Result {
  asBuyer: SubgraphAgreement[];
  asProvider: SubgraphAgreement[];
}

function buildQuery() {
  return `
    query MyAgreements($buyer: Bytes!, $provider: Bytes!) {
      asBuyer: serviceAgreements(
        where: { buyer: $buyer }
        orderBy: createdAt
        orderDirection: desc
        first: 50
      ) {
        id
        listing { id category }
        buyer { id }
        provider { id }
        termsCid
        deliveryCid
        escrowAmount
        escrowType
        status
        deadline
        createdAt
        settledAt
      }
      asProvider: serviceAgreements(
        where: { provider: $provider }
        orderBy: createdAt
        orderDirection: desc
        first: 50
      ) {
        id
        listing { id category }
        buyer { id }
        provider { id }
        termsCid
        deliveryCid
        escrowAmount
        escrowType
        status
        deadline
        createdAt
        settledAt
      }
    }
  `;
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

  const normalizedAddress = address?.toLowerCase() ?? "";
  const query = buildQuery();

  const result = useSubgraphQuery<Result>(
    ["myAgreements", normalizedAddress],
    query,
    { buyer: normalizedAddress, provider: normalizedAddress },
    { enabled: !!address, staleTime: 15_000 },
  );

  const { deliverWork, isPending: delivering } = useDeliverWork();
  const { settleAgreement, isPending: settling } = useSettleAgreement();
  const { disputeAgreement, isPending: disputing } = useDisputeAgreement();
  const { cancelAgreement, isPending: cancelling } = useCancelAgreement();

  const agreements = tab === "buyer"
    ? (result.data?.asBuyer ?? [])
    : (result.data?.asProvider ?? []);

  const filtered = statusFilter !== null
    ? agreements.filter((a) => a.status === statusFilter)
    : agreements;

  if (!address) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          Connect your wallet to view your agreements.
        </p>
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
          As Buyer ({result.data?.asBuyer?.length ?? 0})
        </button>
        <button
          onClick={() => setTab("provider")}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "provider"
              ? "bg-accent text-white"
              : "bg-card text-muted-foreground hover:text-foreground"
          }`}
        >
          As Provider ({result.data?.asProvider?.length ?? 0})
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
      {result.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-card" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No agreements found.</p>
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

            return (
              <div
                key={agreement.id}
                className="border border-border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Agreement #{agreement.id}</span>
                    <ServiceStatusBadge status={agreement.status} />
                    <Link
                      to={`/marketplace/${agreement.listing.id}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Listing #{agreement.listing.id}
                    </Link>
                  </div>
                  {agreement.escrowAmount !== "0" && (
                    <span className="flex items-center gap-1 text-sm text-accent">
                      <Coins className="h-3.5 w-3.5" />
                      {parseFloat(formatUnits(BigInt(agreement.escrowAmount), 6)).toFixed(2)} USDC
                    </span>
                  )}
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
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-wrap">
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
                      {settling ? "Settling..." : "Settle & Pay"}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
