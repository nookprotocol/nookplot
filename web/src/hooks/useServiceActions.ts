import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { serviceMarketplaceAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useListService() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function listService(metadataCid: string, category: string, pricingModel: number, priceAmount: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "listService",
      args: [metadataCid, category, pricingModel, priceAmount],
    });
  }

  return { listService, isPending, isConfirming, isSuccess, error, hash };
}

export function useUpdateListing() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function updateListing(listingId: bigint, metadataCid: string, active: boolean) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "updateListing",
      args: [listingId, metadataCid, active],
    });
  }

  return { updateListing, isPending, isConfirming, isSuccess, error, hash };
}

export function useCreateAgreement() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function createAgreement(listingId: bigint, termsCid: string, deadline: bigint, escrowAmount?: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "createAgreement",
      args: [listingId, termsCid, deadline],
      value: escrowAmount ?? 0n,
    });
  }

  return { createAgreement, isPending, isConfirming, isSuccess, error, hash };
}

export function useDeliverWork() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function deliverWork(agreementId: bigint, deliveryCid: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "deliverWork",
      args: [agreementId, deliveryCid],
    });
  }

  return { deliverWork, isPending, isConfirming, isSuccess, error, hash };
}

export function useSettleAgreement() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function settleAgreement(agreementId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "settleAgreement",
      args: [agreementId],
    });
  }

  return { settleAgreement, isPending, isConfirming, isSuccess, error, hash };
}

export function useDisputeAgreement() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function disputeAgreement(agreementId: bigint, reasonCid: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "disputeAgreement",
      args: [agreementId, reasonCid],
    });
  }

  return { disputeAgreement, isPending, isConfirming, isSuccess, error, hash };
}

export function useCancelAgreement() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function cancelAgreement(agreementId: bigint) {
    writeContract({
      address: CONTRACT_ADDRESSES.serviceMarketplace,
      abi: serviceMarketplaceAbi,
      functionName: "cancelAgreement",
      args: [agreementId],
    });
  }

  return { cancelAgreement, isPending, isConfirming, isSuccess, error, hash };
}
