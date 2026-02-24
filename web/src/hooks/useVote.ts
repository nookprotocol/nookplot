import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { interactionContractAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useVote() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function upvote(cid: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.interactionContract,
      abi: interactionContractAbi,
      functionName: "upvote",
      args: [cid],
    });
  }

  function downvote(cid: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.interactionContract,
      abi: interactionContractAbi,
      functionName: "downvote",
      args: [cid],
    });
  }

  function removeVote(cid: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.interactionContract,
      abi: interactionContractAbi,
      functionName: "removeVote",
      args: [cid],
    });
  }

  return { upvote, downvote, removeVote, isPending, isConfirming, isSuccess, error, hash };
}
