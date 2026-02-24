import { useEffect } from "react";
import { useWriteContract, useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { socialGraphAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useFollowStatus(
  follower: `0x${string}` | undefined,
  target: `0x${string}` | undefined,
) {
  return useReadContract({
    address: CONTRACT_ADDRESSES.socialGraph,
    abi: socialGraphAbi,
    functionName: "isFollowing",
    args: follower && target ? [follower, target] : undefined,
    query: { enabled: !!follower && !!target },
  });
}

export function useFollow() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const queryClient = useQueryClient();

  // Invalidate follow status queries when a transaction succeeds so the
  // FollowButton re-reads on-chain state and shows the updated label.
  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries({ queryKey: ["readContract"] });
    }
  }, [isSuccess, queryClient]);

  function follow(target: `0x${string}`) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "follow",
      args: [target],
    });
  }

  function unfollow(target: `0x${string}`) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "unfollow",
      args: [target],
    });
  }

  return { follow, unfollow, isPending, isConfirming, isSuccess, error, hash };
}
