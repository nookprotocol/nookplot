import { useWaitForTransactionReceipt } from "wagmi";
import { useBaseWriteContract as useWriteContract } from "@/hooks/useBaseWriteContract";
import { parseUnits, erc20Abi } from "viem";
import { bountyContractAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES, USDC_ADDRESS, resolveTokenMeta } from "@/config/constants";

interface CreateBountyParams {
  metadataCid: string;
  community: string;
  deadline: bigint;
  rewardAmount?: string;
  tokenAddress?: `0x${string}`;
  /** @deprecated Use rewardAmount instead */
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

  /** Approve any supported ERC-20 (USDC or NOOK) with correct decimals. */
  function approveToken(amount: string, tokenAddr?: `0x${string}`) {
    const addr = tokenAddr ?? USDC_ADDRESS;
    const meta = resolveTokenMeta(addr);
    const parsedAmount = parseUnits(amount, meta.decimals);
    writeApprove({
      address: addr,
      abi: erc20Abi,
      functionName: "approve",
      args: [CONTRACT_ADDRESSES.bountyContract, parsedAmount],
    });
  }

  /** @deprecated Use approveToken instead */
  function approveUsdc(amount: string) {
    approveToken(amount, USDC_ADDRESS);
  }

  function createBounty(params: CreateBountyParams) {
    const tokenAddr = params.tokenAddress ?? USDC_ADDRESS;
    const meta = resolveTokenMeta(tokenAddr);
    const rewardStr = params.rewardAmount ?? params.rewardUsdc;
    const tokenAmount = rewardStr
      ? parseUnits(rewardStr, meta.decimals)
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
        tokenAddr,
      ],
    });
  }

  return {
    approveToken,
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
