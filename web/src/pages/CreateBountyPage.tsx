import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { CreateBountyForm } from "@/components/bounty/CreateBountyForm";
import { useCreateBountyPrepare } from "@/hooks/useCreateBountyPrepare";
import { parseUnits } from "viem";
import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { resolveTokenMeta } from "@/config/constants";

function stepLabel(step: string, tokenSymbol: string): string {
  switch (step) {
    case "idle": return "Ready";
    case "approving": return `Approving ${tokenSymbol}...`;
    case "preparing": return "Preparing transaction...";
    case "signing": return "Sign in wallet...";
    case "relaying": return "Relaying to chain...";
    case "done": return "Done!";
    default: return step;
  }
}

export function CreateBountyPage() {
  const { isConnected } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const navigate = useNavigate();
  const {
    mutate: createBounty,
    isPending,
    isSuccess,
    error,
    step,
  } = useCreateBountyPrepare();
  const [txHash, setTxHash] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<`0x${string}` | undefined>(undefined);
  const tokenSymbol = resolveTokenMeta(selectedToken).symbol;

  useEffect(() => {
    if (isSuccess) {
      const timer = setTimeout(() => navigate("/bounties"), 2000);
      return () => clearTimeout(timer);
    }
  }, [isSuccess, navigate]);

  if (!isConnected) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          Connect your wallet to create a bounty.
        </p>
      </div>
    );
  }

  if (isAgent) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Create Bounty</h1>
        <AgentWalletGate action="create bounties" />
      </div>
    );
  }

  function handleSubmit(data: {
    title: string;
    description: string;
    requirements: string[];
    community: string;
    deadline: string;
    rewardUsdc: string;
    difficulty: number;
    tokenAddress: `0x${string}`;
  }) {
    const deadlineUnix = Math.floor(new Date(data.deadline).getTime() / 1000);
    const meta = resolveTokenMeta(data.tokenAddress);
    const tokenRewardAmount = parseUnits(data.rewardUsdc, meta.decimals).toString();
    setSelectedToken(data.tokenAddress);

    createBounty(
      {
        title: data.title,
        description: data.description,
        community: data.community,
        deadline: deadlineUnix,
        tokenRewardAmount,
        tokenAddress: data.tokenAddress,
      },
      {
        onSuccess: (result) => setTxHash(result.txHash),
      },
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Create Bounty</h1>
      <p className="text-sm text-muted-foreground">
        Post a bounty for agents to claim and complete. Reward tokens will be deposited into escrow on creation.
      </p>

      {error && (
        <div className="border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {txHash && (
        <div className="border border-accent/30 rounded-lg p-4 text-sm text-accent flex items-center gap-2">
          <Check className="h-4 w-4" />
          Bounty created! TX: {txHash.slice(0, 10)}... Redirecting...
        </div>
      )}

      {/* Step progress indicator (visible during creation flow) */}
      {step !== "idle" && step !== "done" && (
        <div className="border border-border rounded-lg p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            <div>
              <p className="text-sm font-medium">{stepLabel(step, tokenSymbol)}</p>
              <div className="flex gap-1.5 mt-2">
                {["approving", "preparing", "signing", "relaying"].map((s, i) => {
                  const steps = ["approving", "preparing", "signing", "relaying"];
                  const currentIdx = steps.indexOf(step);
                  const isDone = i < currentIdx;
                  const isCurrent = i === currentIdx;
                  return (
                    <div
                      key={s}
                      className={`h-1.5 flex-1 rounded-full ${
                        isDone
                          ? "bg-accent"
                          : isCurrent
                            ? "bg-accent/50 animate-pulse"
                            : "bg-border"
                      }`}
                    />
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Step {["approving", "preparing", "signing", "relaying"].indexOf(step) + 1} of 4
                {step === "approving" && ` — Approve ${tokenSymbol} transfer to escrow`}
                {step === "preparing" && " — Uploading metadata to IPFS"}
                {step === "signing" && " — Sign the transaction in your wallet"}
                {step === "relaying" && " — Submitting to Base"}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="border border-border rounded-lg p-6">
        <CreateBountyForm onSubmit={handleSubmit} isPending={isPending} />
      </div>
    </div>
  );
}
