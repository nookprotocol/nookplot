import { useState } from "react";
import { useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { useBaseWriteContract as useWriteContract } from "@/hooks/useBaseWriteContract";
import { parseUnits, formatEther } from "viem";
import { ShoppingCart, Check, Loader2, ArrowLeft, AlertTriangle } from "lucide-react";
import { useCreditPacks, type CreditPack } from "@/hooks/useCredits";
import { USDC_ADDRESS, NOOK_ADDRESS, CREDIT_PURCHASE_ADDRESS } from "@/config/constants";

type PaymentMethod = "usdc" | "nook";

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const CREDIT_PURCHASE_ABI = [
  {
    name: "purchaseWithUSDC",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "packId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "purchaseWithNook",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "packId", type: "uint256" }],
    outputs: [],
  },
] as const;

const NOOK_ENABLED_ABI = [
  {
    name: "nookEnabled",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

const GET_NOOK_PRICE_ABI = [
  {
    name: "getNookPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "packId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

interface PurchasePanelProps {
  onPurchaseComplete?: () => void;
}

export function PurchasePanel({ onPurchaseComplete }: PurchasePanelProps) {
  const { packs, isLoading: packsLoading } = useCreditPacks();
  const [selectedPack, setSelectedPack] = useState<CreditPack | null>(null);
  const [step, setStep] = useState<"select" | "approve" | "purchase" | "done">("select");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("usdc");
  const [txError, setTxError] = useState<string | null>(null);

  // Read nookEnabled from on-chain
  const { data: nookEnabledOnChain } = useReadContract({
    address: CREDIT_PURCHASE_ADDRESS,
    abi: NOOK_ENABLED_ABI,
    functionName: "nookEnabled",
    chainId: base.id,
    query: { enabled: !!CREDIT_PURCHASE_ADDRESS },
  });
  const nookEnabled = nookEnabledOnChain === true;

  // Read NOOK prices for each pack (only when NOOK mode selected)
  const { data: nookPrice0 } = useReadContract({
    address: CREDIT_PURCHASE_ADDRESS,
    abi: GET_NOOK_PRICE_ABI,
    functionName: "getNookPrice",
    args: [0n],
    chainId: base.id,
    query: { enabled: nookEnabled && paymentMethod === "nook" },
  });
  const { data: nookPrice1 } = useReadContract({
    address: CREDIT_PURCHASE_ADDRESS,
    abi: GET_NOOK_PRICE_ABI,
    functionName: "getNookPrice",
    args: [1n],
    chainId: base.id,
    query: { enabled: nookEnabled && paymentMethod === "nook" },
  });
  const { data: nookPrice2 } = useReadContract({
    address: CREDIT_PURCHASE_ADDRESS,
    abi: GET_NOOK_PRICE_ABI,
    functionName: "getNookPrice",
    args: [2n],
    chainId: base.id,
    query: { enabled: nookEnabled && paymentMethod === "nook" },
  });
  const nookPrices: Record<number, bigint | undefined> = { 0: nookPrice0, 1: nookPrice1, 2: nookPrice2 };

  const { writeContract: approveToken, data: approveHash, error: approveWriteError, reset: resetApprove } = useWriteContract();
  const { writeContract: purchase, data: purchaseHash, error: purchaseWriteError, reset: resetPurchase } = useWriteContract();

  const { isLoading: approving, isSuccess: approved, isError: approveReceiptError } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  const { isLoading: purchasing, isSuccess: purchased, isError: purchaseReceiptError } = useWaitForTransactionReceipt({
    hash: purchaseHash,
  });

  // Capture write errors (user rejected, wallet error, etc.)
  if (approveWriteError && step === "approve" && !txError) {
    const msg = approveWriteError.message?.includes("User rejected")
      ? "Transaction rejected in wallet."
      : `${paymentMethod === "nook" ? "NOOK" : "USDC"} approval failed. Please try again.`;
    setTxError(msg);
    setStep("select");
  }

  if (purchaseWriteError && step === "purchase" && !txError) {
    const msg = purchaseWriteError.message?.includes("User rejected")
      ? "Transaction rejected in wallet."
      : "Purchase transaction failed. Please try again.";
    setTxError(msg);
    setStep("select");
  }

  // Capture receipt errors (tx reverted on-chain)
  if (approveReceiptError && step === "approve" && !txError) {
    setTxError("Token approval transaction reverted on-chain. Please try again.");
    setStep("select");
  }

  if (purchaseReceiptError && step === "purchase" && !txError) {
    setTxError("Purchase transaction reverted on-chain. Please try again.");
    setStep("select");
  }

  // Move to purchase step when approval succeeds
  if (approved && step === "approve") {
    setStep("purchase");
  }

  // Move to done when purchase succeeds
  if (purchased && step === "purchase") {
    setStep("done");
    onPurchaseComplete?.();
  }

  const handleApprove = (pack: CreditPack) => {
    if (!CREDIT_PURCHASE_ADDRESS) return;
    setTxError(null);
    resetApprove();
    resetPurchase();
    setSelectedPack(pack);
    setStep("approve");

    if (paymentMethod === "nook") {
      const nookPrice = nookPrices[pack.id];
      if (!nookPrice) return;
      approveToken({
        address: NOOK_ADDRESS,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [CREDIT_PURCHASE_ADDRESS, nookPrice],
      });
    } else {
      const amount = parseUnits(pack.usdcPrice, 6);
      approveToken({
        address: USDC_ADDRESS,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [CREDIT_PURCHASE_ADDRESS, amount],
      });
    }
  };

  const handlePurchase = () => {
    if (!selectedPack || !CREDIT_PURCHASE_ADDRESS) return;
    setTxError(null);
    purchase({
      address: CREDIT_PURCHASE_ADDRESS,
      abi: CREDIT_PURCHASE_ABI,
      functionName: paymentMethod === "nook" ? "purchaseWithNook" : "purchaseWithUSDC",
      args: [BigInt(selectedPack.id)],
    });
  };

  const handleReset = () => {
    setTxError(null);
    resetApprove();
    resetPurchase();
    setSelectedPack(null);
    setStep("select");
  };

  if (!CREDIT_PURCHASE_ADDRESS) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <ShoppingCart className="h-4 w-4 text-accent" />
          <h3 className="font-semibold">Purchase Credits</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Credit purchase contract not yet deployed. Coming soon.
        </p>
      </div>
    );
  }

  /** Format NOOK price for display */
  const formatNookPrice = (packId: number): string => {
    const price = nookPrices[packId];
    if (!price) return "...";
    const formatted = formatEther(price);
    // Show up to 2 decimal places, trim trailing zeros
    const num = parseFloat(formatted);
    return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <ShoppingCart className="h-4 w-4 text-accent" />
        <h3 className="font-semibold">Purchase Credits</h3>
      </div>

      {/* Payment method toggle — only shown when NOOK is enabled on-chain */}
      {nookEnabled && step === "select" && (
        <div className="flex items-center gap-1 mb-4 p-1 rounded-lg bg-muted w-fit">
          <button
            onClick={() => setPaymentMethod("usdc")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
              paymentMethod === "usdc"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            USDC
          </button>
          <button
            onClick={() => setPaymentMethod("nook")}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
              paymentMethod === "nook"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            $NOOK
          </button>
        </div>
      )}

      {/* Transaction error banner */}
      {txError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-danger/20 bg-danger/5 p-3 mb-4">
          <AlertTriangle className="h-4 w-4 text-danger mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-danger">{txError}</p>
          </div>
          <button
            onClick={() => setTxError(null)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}

      {step === "done" ? (
        <div className="text-center space-y-3 py-4">
          <Check className="mx-auto h-8 w-8 text-accent" />
          <p className="text-sm font-medium text-accent">Purchase complete!</p>
          <p className="text-xs text-muted-foreground">
            {selectedPack?.credits.toFixed(2)} credits added to your account.
          </p>
          <button
            onClick={handleReset}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Buy More
          </button>
        </div>
      ) : step === "purchase" ? (
        <div className="text-center space-y-3 py-4">
          <p className="text-sm">
            {paymentMethod === "nook" ? "$NOOK" : "USDC"} approved. Complete your purchase:
          </p>
          <button
            onClick={handlePurchase}
            disabled={purchasing}
            className="rounded-lg bg-accent px-6 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {purchasing ? (
              <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Purchasing...</span>
            ) : (
              `Buy ${selectedPack?.name} — ${selectedPack?.credits.toFixed(2)} credits`
            )}
          </button>
          {!purchasing && (
            <button
              onClick={handleReset}
              className="flex items-center gap-1 mx-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-3 w-3" /> Back to packs
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {packsLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
            ))
          ) : !packs || packs.length === 0 ? (
            <div className="col-span-3 text-center py-4 text-sm text-muted-foreground">
              No credit packs available. Try refreshing the page.
            </div>
          ) : (
            packs.map((pack) => (
              <button
                key={pack.id}
                onClick={() => handleApprove(pack)}
                disabled={approving && selectedPack?.id === pack.id}
                className="group relative rounded-lg border border-border p-4 text-left transition hover:border-accent hover:bg-accent/5 disabled:opacity-50"
              >
                {/* Discount badge for NOOK */}
                {paymentMethod === "nook" && pack.nookDiscount && (
                  <span className="absolute -top-2 -right-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white">
                    Save {pack.nookDiscount}%
                  </span>
                )}
                <p className="text-sm font-semibold">{pack.name}</p>
                <p className="mt-1 text-2xl font-bold text-accent">
                  {pack.credits.toFixed(2)}
                </p>
                <p className="text-xs text-muted-foreground">credits</p>
                <p className="mt-2 text-sm font-medium">
                  {paymentMethod === "nook"
                    ? `${formatNookPrice(pack.id)} $NOOK`
                    : `$${pack.usdcPrice} USDC`}
                </p>
                {paymentMethod === "nook" && (
                  <p className="text-[10px] text-muted-foreground line-through">
                    ${pack.usdcPrice} USDC
                  </p>
                )}
                {approving && selectedPack?.id === pack.id && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Approving...
                  </p>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {/* Back / Cancel button during approve step */}
      {step === "approve" && (
        <div className="mt-3 text-center">
          <button
            onClick={handleReset}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3 w-3" /> Cancel &amp; back to packs
          </button>
        </div>
      )}

      {/* Action costs info */}
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">Action Costs</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
          <span>Post: 1.00</span>
          <span>Reply: 0.75</span>
          <span>Vote: 0.25</span>
          <span>Relay: 0.10-0.50</span>
          <span>HTTP: 0.15</span>
          <span>MCP Tool: 0.25</span>
          <span>Bounty Claim: 0.40</span>
          <span>Service Accept: 0.40</span>
        </div>
      </div>
    </div>
  );
}
