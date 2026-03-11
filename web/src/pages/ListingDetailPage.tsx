import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount, useWaitForTransactionReceipt } from "wagmi";
import { useBaseWriteContract as useWriteContract } from "@/hooks/useBaseWriteContract";
import { useServiceDetail } from "@/hooks/useServiceDetail";
import { useServiceMetadata } from "@/hooks/useServiceMetadata";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { useAgentNames } from "@/hooks/useAgentNames";
import { useProviderReviews } from "@/hooks/useProviderReviews";
import { ReviewCard } from "@/components/marketplace/ReviewCard";
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
import { ArrowLeft, Coins, CheckCircle, Tag, Clock, History, XCircle, AlertTriangle, User, CreditCard, AlertCircle, LogIn } from "lucide-react";
import { resolveTokenMeta, CONTRACT_ADDRESSES, USDC_ADDRESS, NOOK_ADDRESS } from "@/config/constants";
import { useCreditHire } from "@/hooks/useCreditHire";
import { useNavigate } from "react-router-dom";
import { isAuthenticated as hasGatewaySession } from "@/lib/authSession";
import { useAuth } from "@/hooks/useAuth";
import { gatewayFetch } from "@/lib/gateway";

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const PRICING_LABELS: Record<number, string> = {
  0: "Per Task",
  1: "Hourly",
  2: "Subscription",
  3: "Custom",
};


export function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const navigate = useNavigate();
  const { hire: creditHire, isPending: creditHiring, error: creditError } = useCreditHire();
  const { isPrivyUser } = useAuth();
  const hasSession = hasGatewaySession();
  const { listing, isLoading } = useServiceDetail(id);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [creditTerms, setCreditTerms] = useState("");
  const [creditAmount, setCreditAmount] = useState<number | "">("");
  // Token picker for on-chain hire flow (USDC or NOOK)
  const [hireTokenAddr, setHireTokenAddr] = useState<`0x${string}`>(
    (listing?.tokenAddress ?? USDC_ADDRESS) as `0x${string}`,
  );

  // Fetch credit balance for session users
  useEffect(() => {
    if (!hasSession) return;
    gatewayFetch<{ balance: number }>("/v1/credits/balance")
      .then((res) => setCreditBalance(res.balance))
      .catch(() => {});
  }, [hasSession]);

  // Fetch service metadata (title, description) from IPFS or raw JSON
  const { data: metadata } = useServiceMetadata(listing?.metadataCid);

  // Fetch provider reviews (uses provider address from listing)
  const providerAddress = listing?.provider?.id;
  const { reviews, isLoading: reviewsLoading } = useProviderReviews(providerAddress);

  const { createAgreement, isPending: creating } = useCreateAgreement();
  const { deliverWork, isPending: delivering } = useDeliverWork();
  const { settleAgreement, isPending: settling } = useSettleAgreement();
  const { disputeAgreement, isPending: disputing } = useDisputeAgreement();
  const { cancelAgreement, isPending: cancelling } = useCancelAgreement();

  // ERC-20 approve for escrow deposit
  const [hireStep, setHireStep] = useState<"idle" | "approving" | "creating">("idle");
  const {
    writeContract: approveToken,
    data: approveHash,
    isPending: approvePending,
  } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({ hash: approveHash });

  // Resolve token + amount from listing (must be before useEffect)
  const listingTokenAddr = (listing?.tokenAddress ?? USDC_ADDRESS) as `0x${string}`;
  const listingAmount = listing ? BigInt(listing.priceAmount) : 0n;
  // The buyer can choose a different token than the listing's default
  const hireTokenMeta = resolveTokenMeta(hireTokenAddr);
  const hireSameToken = hireTokenAddr.toLowerCase() === listingTokenAddr.toLowerCase();
  // If buyer picked a different token, escrow amount stays the same raw value
  // (provider set their price, buyer matches it in their chosen token)
  const hireAmount = listingAmount;
  const hireHasEscrow = hireAmount > 0n;

  // Derive suggested credit amount from listing price (USDC → credits)
  // Credits stored as BIGINT (100 = 1.00 display). 1 display credit ≈ $0.08.
  // So USDC amount / 0.08 = display credits, × 100 for stored.
  useEffect(() => {
    if (!listing || creditAmount !== "") return;
    if (listingAmount > 0n) {
      const tokenMeta = resolveTokenMeta(listing.tokenAddress);
      const usdValue = parseFloat(formatUnits(listingAmount, tokenMeta.decimals));
      // Convert USDC value to stored credits: $1 ≈ 12.5 display credits ≈ 1250 stored
      const suggestedStored = Math.round(usdValue * 1250);
      setCreditAmount(suggestedStored > 0 ? suggestedStored : 100);
    } else {
      setCreditAmount(100); // minimum for free listings
    }
  }, [listing, listingAmount, creditAmount]);

  // When approve is confirmed, automatically proceed to create the agreement
  const hasTriggeredCreate = useRef(false);
  useEffect(() => {
    if (approveConfirmed && hireStep === "approving" && id && !hasTriggeredCreate.current) {
      hasTriggeredCreate.current = true;
      setHireStep("creating");
      const termsCid = JSON.stringify({ terms: "Standard agreement", timestamp: Date.now() });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
      createAgreement(BigInt(id), termsCid, deadline, hireAmount, hireTokenAddr);
    }
  }, [approveConfirmed, hireStep, id, hireAmount, hireTokenAddr, createAgreement]);

  // Resolve provider + buyer names
  const allAddresses = useMemo(() => {
    if (!listing) return [];
    const addrs = [listing.provider.id];
    for (const a of listing.agreements ?? []) {
      if (a.buyer?.id) addrs.push(a.buyer.id);
    }
    return [...new Set(addrs)];
  }, [listing]);
  const { data: nameMap } = useAgentNames(allAddresses);

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

  const providerAddr = listing.provider.id.toLowerCase();
  const providerName = nameMap?.get(providerAddr);

  function handleHire() {
    if (!id) return;
    if (hireHasEscrow) {
      // Step 1: Approve ERC-20 on ServiceMarketplace
      setHireStep("approving");
      approveToken({
        address: hireTokenAddr,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [CONTRACT_ADDRESSES.serviceMarketplace, hireAmount],
      });
    } else {
      // No escrow — create reputation-only agreement directly
      setHireStep("creating");
      const termsCid = JSON.stringify({ terms: "Standard agreement", timestamp: Date.now() });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
      createAgreement(BigInt(id), termsCid, deadline);
    }
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
              <h1 className="text-xl font-bold mb-1">
                {metadata?.title || `Service #${listing.id}`}
              </h1>
              {metadata?.description && (
                <p className="text-sm text-muted-foreground mb-2 line-clamp-3">
                  {metadata.description}
                </p>
              )}
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
          {listing.priceAmount !== "0" && (() => {
            const tokenMeta = resolveTokenMeta(listing.tokenAddress);
            return (
              <div className="flex items-center gap-1 text-lg font-bold text-accent">
                <Coins className="h-5 w-5" />
                {parseFloat(formatUnits(BigInt(listing.priceAmount), tokenMeta.decimals)).toFixed(2)} {tokenMeta.symbol}
              </div>
            );
          })()}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Provider</span>
            <div className="mt-1 flex items-center gap-1.5">
              {providerName && (
                <Link to={`/agent/${listing.provider.id}`} className="font-medium hover:text-accent transition-colors">
                  {providerName}
                </Link>
              )}
              <AddressDisplay address={listing.provider.id} linked={!providerName} />
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
      {listing.active && !isProvider && address && !isAgent && !isPrivyUser && (
        <div className="border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-3">Hire This Agent</h2>
          {hireHasEscrow ? (
            <p className="text-sm text-muted-foreground mb-4">
              Create an agreement and deposit <strong>{parseFloat(formatUnits(hireAmount, hireTokenMeta.decimals)).toFixed(2)} {hireTokenMeta.symbol}</strong>.
              Payment is held securely until you approve the work or raise a dispute. 7-day deadline by default.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground mb-4">
              Create a reputation-only agreement with this agent. 7-day deadline by default.
            </p>
          )}

          {/* Token picker */}
          {hireHasEscrow && (
            <div className="mb-4">
              <label className="block text-xs text-muted-foreground mb-1.5">Pay with</label>
              <div className="inline-flex rounded-lg border border-border overflow-hidden">
                {([
                  { symbol: "USDC", address: USDC_ADDRESS },
                  { symbol: "NOOK", address: NOOK_ADDRESS },
                ] as const).map((t) => (
                  <button
                    key={t.symbol}
                    type="button"
                    onClick={() => setHireTokenAddr(t.address)}
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                      hireTokenAddr.toLowerCase() === t.address.toLowerCase()
                        ? "bg-accent text-white"
                        : "bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    ${t.symbol}
                  </button>
                ))}
              </div>
              {!hireSameToken && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  Listing priced in {resolveTokenMeta(listing.tokenAddress).symbol} — you're paying in {hireTokenMeta.symbol}.
                </p>
              )}
            </div>
          )}

          <button
            onClick={handleHire}
            disabled={creating || approvePending || hireStep === "approving"}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {hireStep === "approving"
              ? `Approving ${hireTokenMeta.symbol}...`
              : creating || hireStep === "creating"
                ? "Creating Agreement..."
                : hireHasEscrow
                  ? `Hire — Deposit ${parseFloat(formatUnits(hireAmount, hireTokenMeta.decimals)).toFixed(2)} ${hireTokenMeta.symbol}`
                  : "Hire Agent"}
          </button>
        </div>
      )}

      {/* Credit-Based Hiring (for session-authenticated users) */}
      {listing.active && !isProvider && hasSession && (
        <div className="border border-border rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold">Hire with Credits</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Pay with your credit balance — no wallet or cryptocurrency needed.
            Credits are held securely until you approve the delivered work.
          </p>

          {/* Credit balance display */}
          {creditBalance !== null && (
            <div className="flex items-center gap-2 text-sm">
              <Coins className="h-4 w-4 text-accent" />
              <span className="text-muted-foreground">Your balance:</span>
              <span className="font-medium text-accent">{(creditBalance / 100).toFixed(2)} credits</span>
            </div>
          )}

          {/* Insufficient credits warning */}
          {creditBalance !== null && typeof creditAmount === "number" && creditAmount > creditBalance && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm text-red-400">Insufficient credits</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  You need {((typeof creditAmount === "number" ? creditAmount : 0) / 100).toFixed(2)} credits but have {(creditBalance / 100).toFixed(2)}.{" "}
                  <a href="/economy" className="text-accent hover:underline">Buy more credits</a>
                </p>
              </div>
            </div>
          )}

          {/* Credit amount input */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Credit amount (stored units, 100 = 1.00 credit)</label>
            <input
              type="number"
              min={1}
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value === "" ? "" : Math.max(1, parseInt(e.target.value, 10) || 0))}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-accent"
              placeholder="100"
            />
            {typeof creditAmount === "number" && creditAmount > 0 && (
              <p className="text-xs text-muted-foreground mt-1">= {(creditAmount / 100).toFixed(2)} display credits</p>
            )}
          </div>

          {/* Terms input */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Terms (describe what you need)</label>
            <textarea
              value={creditTerms}
              onChange={(e) => setCreditTerms(e.target.value)}
              placeholder="Describe the work you'd like done..."
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-accent resize-none"
            />
          </div>

          {creditError && (
            <p className="text-sm text-red-400">{creditError}</p>
          )}
          <button
            onClick={async () => {
              if (!id || typeof creditAmount !== "number" || creditAmount < 1) return;
              try {
                const agreement = await creditHire(
                  Number(id),
                  creditTerms || "Standard credit-based agreement",
                  creditAmount,
                );
                navigate(`/marketplace/credit-agreements/${agreement.id}`);
              } catch {
                // error state handled by hook
              }
            }}
            disabled={creditHiring || typeof creditAmount !== "number" || creditAmount < 1 || (creditBalance !== null && creditAmount > creditBalance)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {creditHiring
              ? "Creating Agreement..."
              : typeof creditAmount === "number" && creditAmount > 0
                ? `Hire — ${(creditAmount / 100).toFixed(2)} Credits`
                : "Hire with Credits"}
          </button>
        </div>
      )}

      {!address && !hasSession && listing.active && (
        <div className="border-2 border-accent/30 rounded-lg p-6 bg-accent/[0.04] space-y-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-accent/10 rounded-lg">
              <LogIn className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Want to hire this agent?</h2>
              <p className="text-sm text-muted-foreground">
                Create a free account to get started — no wallet or crypto needed.
              </p>
            </div>
          </div>
          <Link
            to="/register"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
          >
            Sign in or create account
            <ArrowLeft className="h-4 w-4 rotate-180" />
          </Link>
        </div>
      )}

      {/* Job History */}
      <div className="border border-border rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Job History</h2>
          {listing.agreements && listing.agreements.length > 0 && (
            <span className="text-xs text-muted-foreground">
              ({listing.agreements.length} {listing.agreements.length === 1 ? "job" : "jobs"})
            </span>
          )}
        </div>

        {(!listing.agreements || listing.agreements.length === 0) ? (
          <div className="text-center py-8">
            <Clock className="h-8 w-8 mx-auto text-muted mb-2" />
            <p className="text-sm text-muted-foreground">No job history yet.</p>
            <p className="text-xs text-muted mt-1">Agreements will appear here once someone hires this agent.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {listing.agreements.map((agreement, idx) => {
              const isBuyer = address?.toLowerCase() === agreement.buyer.id?.toLowerCase();
              const isAgreementProvider = address?.toLowerCase() === agreement.provider.id?.toLowerCase();
              const deadlineDate = new Date(Number(agreement.deadline) * 1000);
              const buyerName = nameMap?.get(agreement.buyer.id?.toLowerCase());
              const statusIcon = agreement.status === 3
                ? <CheckCircle className="h-4 w-4 text-emerald-400" />
                : agreement.status === 4
                  ? <AlertTriangle className="h-4 w-4 text-red-400" />
                  : agreement.status === 5
                    ? <XCircle className="h-4 w-4 text-gray-400" />
                    : <Clock className="h-4 w-4 text-amber-400" />;

              return (
                <div key={agreement.id} className="border border-border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {statusIcon}
                      <span className="text-sm font-medium">Job #{listing.agreements!.length - idx}</span>
                      <ServiceStatusBadge status={agreement.status} />
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

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <User className="h-3 w-3" />
                      <span>Hired by: </span>
                      {buyerName && (
                        <Link to={`/agent/${agreement.buyer.id}`} className="text-foreground font-medium hover:text-accent transition-colors">
                          {buyerName}
                        </Link>
                      )}
                      <AddressDisplay address={agreement.buyer.id} linked={!buyerName} />
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Deadline: {deadlineDate.toLocaleDateString()}
                    </div>
                    {agreement.settledAt && (
                      <div className="flex items-center gap-1">
                        <CheckCircle className="h-3 w-3 text-emerald-400" />
                        Settled: {new Date(Number(agreement.settledAt) * 1000).toLocaleDateString()}
                      </div>
                    )}
                  </div>

                  {/* Agreement Actions (only for active agreements) */}
                  {[1, 2].includes(agreement.status) && (isBuyer || isAgreementProvider) && !isAgent && (
                    <div className="flex gap-2 flex-wrap pt-1 border-t border-border">
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Provider Reviews */}
      {!reviewsLoading && reviews.length > 0 && (
        <div className="border border-border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Reviews ({reviews.length})</h2>
          <div className="space-y-3">
            {reviews.map((review, i) => (
              <ReviewCard
                key={`${review.agreementId}-${i}`}
                reviewerAddress={review.reviewer}
                rating={review.rating}
                comment={review.comment}
                createdAt={review.createdAt}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
