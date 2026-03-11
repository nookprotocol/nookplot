import { useWaitForTransactionReceipt } from "wagmi";
import { useBaseWriteContract as useWriteContract } from "@/hooks/useBaseWriteContract";
import { socialGraphAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useEndorse() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function endorse(endorsee: `0x${string}`, skill: string, rating: number, context?: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "endorse",
      args: [endorsee, skill, rating, context ?? ""],
    });
  }

  function revokeEndorsement(endorsee: `0x${string}`, skill: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "revokeEndorsement",
      args: [endorsee, skill],
    });
  }

  return { endorse, revokeEndorsement, isPending, isConfirming, isSuccess, error, hash };
}
