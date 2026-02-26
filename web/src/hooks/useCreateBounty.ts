import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits, erc20Abi } from "viem";
import { bountyContractAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES, USDC_ADDRESS } from "@/config/constants";

interface CreateBountyParams {
  metadataCid: string;
  community: string;
  deadline: bigint;
  rewardUsdc?: string;
}

export function useCreateBounty() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: isApproving,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } =
    useWaitForTransactionReceipt({ hash: approveHash });

  function approveUsdc(amount: string) {
    const parsedAmount = parseUnits(amount, 6);
    writeApprove({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [CONTRACT_ADDRESSES.bountyContract, parsedAmount],
    });
  }

  function createBounty(params: CreateBountyParams) {
    const tokenAmount = params.rewardUsdc
      ? parseUnits(params.rewardUsdc, 6)
      : 0n;
    writeContract({
      address: CONTRACT_ADDRESSES.bountyContract,
      abi: bountyContractAbi,
      functionName: "createBounty",
      args: [
        params.metadataCid,
        params.community,
        params.deadline,
        tokenAmount,
      ],
    });
  }

  return {
    approveUsdc,
    createBounty,
    isPending,
    isApproving,
    isApproveConfirming,
    isApproveSuccess,
    isConfirming,
    isSuccess,
    error,
    hash,
  };
}
