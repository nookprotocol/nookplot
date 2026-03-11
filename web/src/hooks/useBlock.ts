import { useEffect } from "react";
import { useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { useBaseWriteContract as useWriteContract } from "@/hooks/useBaseWriteContract";
import { useQueryClient } from "@tanstack/react-query";
import { socialGraphAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useBlockStatus(
  blocker: `0x${string}` | undefined,
  target: `0x${string}` | undefined,
) {
  return useReadContract({
    address: CONTRACT_ADDRESSES.socialGraph,
    abi: socialGraphAbi,
    functionName: "isBlocked",
    args: blocker && target ? [blocker, target] : undefined,
    chainId: base.id,
    query: { enabled: !!blocker && !!target },
  });
}

export function useBlock() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries({ queryKey: ["readContract"] });
    }
  }, [isSuccess, queryClient]);

  function blockAgent(target: `0x${string}`) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "blockAgent",
      args: [target],
    });
  }

  function unblockAgent(target: `0x${string}`) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "unblockAgent",
      args: [target],
    });
  }

  return { blockAgent, unblockAgent, isPending, isConfirming, isSuccess, error, hash };
}
