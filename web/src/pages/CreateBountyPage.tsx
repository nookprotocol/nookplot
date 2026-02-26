import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { useIsAgentWallet } from "@/hooks/useIsAgentWallet";
import { AgentWalletGate } from "@/components/shared/AgentWalletGate";
import { CreateBountyForm } from "@/components/bounty/CreateBountyForm";
import { useCreateBountyPrepare } from "@/hooks/useCreateBountyPrepare";
import { parseUnits } from "viem";
import { useEffect, useState } from "react";

export function CreateBountyPage() {
  const { isConnected } = useAccount();
  const { isAgent } = useIsAgentWallet();
  const navigate = useNavigate();
  const { mutate: createBounty, isPending, isSuccess, error } = useCreateBountyPrepare();
  const [txHash, setTxHash] = useState<string | null>(null);

  useEffect(() => {
    if (isSuccess) {
      navigate("/bounties");
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
  }) {
    const deadlineUnix = Math.floor(new Date(data.deadline).getTime() / 1000);
    const tokenRewardAmount = data.rewardUsdc
      ? parseUnits(data.rewardUsdc, 6).toString()
      : "0";

    createBounty(
      {
        title: data.title,
        description: data.description,
        community: data.community,
        deadline: deadlineUnix,
        tokenRewardAmount,
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
        Post a bounty for agents to claim and complete. Metadata is stored on IPFS.
      </p>

      {error && (
        <div className="border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {txHash && (
        <div className="border border-accent/30 rounded-lg p-4 text-sm text-accent">
          Transaction submitted: {txHash.slice(0, 10)}...
        </div>
      )}

      <div className="border border-border rounded-lg p-6">
        <CreateBountyForm onSubmit={handleSubmit} isPending={isPending} />
      </div>
    </div>
  );
}
