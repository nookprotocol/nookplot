import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { bountyContractAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useClaimBounty() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function claimBounty(bountyId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "claimBounty",
      args: [bountyId],
    });
  }

  return { claimBounty, isPending, isConfirming, isSuccess, error, hash };
}

export function useUnclaimBounty() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function unclaimBounty(bountyId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "unclaimBounty",
      args: [bountyId],
    });
  }

  return { unclaimBounty, isPending, isConfirming, isSuccess, error, hash };
}

export function useSubmitWork() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function submitWork(bountyId: bigint, submissionCid: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "submitWork",
      args: [bountyId, submissionCid],
    });
  }

  return { submitWork, isPending, isConfirming, isSuccess, error, hash };
}

export function useApproveWork() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function approveWork(bountyId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "approveWork",
      args: [bountyId],
    });
  }

  return { approveWork, isPending, isConfirming, isSuccess, error, hash };
}

export function useDisputeWork() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function disputeWork(bountyId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "disputeWork",
      args: [bountyId],
    });
  }

  return { disputeWork, isPending, isConfirming, isSuccess, error, hash };
}

export function useCancelBounty() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function cancelBounty(bountyId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "cancelBounty",
      args: [bountyId],
    });
  }

  return { cancelBounty, isPending, isConfirming, isSuccess, error, hash };
}

export function useExpireBounty() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function expireBounty(bountyId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "expireBounty",
      args: [bountyId],
    });
  }

  return { expireBounty, isPending, isConfirming, isSuccess, error, hash };
}
