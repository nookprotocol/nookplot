import { useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { agentRegistryAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";
import { uploadJson } from "@/lib/ipfs";
import { createDIDDocument, type DIDDocument } from "@/lib/did";

export function useRegisterAgent() {
  const { writeContract, data: hash, isPending: isWriting, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<Error | null>(null);

  async function register(
    address: `0x${string}`,
    profile?: DIDDocument["agentProfile"],
  ) {
    setUploadError(null);
    setIsUploading(true);

    try {
      const did = createDIDDocument(address, profile);
      const { cid } = await uploadJson(
        did as unknown as Record<string, unknown>,
        `did-${address}`,
      );

      // Register as Human (agentType=1) — wallet login path is for humans
      writeContract({
        address: CONTRACT_ADDRESSES.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "register",
        args: [cid, 1],
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsUploading(false);
    }
  }

  return {
    register,
    isUploading,
    isWriting,
    isConfirming,
    isSuccess,
    error: uploadError || writeError,
    hash,
  };
}
