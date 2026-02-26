import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { socialGraphAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function useAttest() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  function attest(subject: `0x${string}`, reason: string) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "attest",
      args: [subject, reason],
    });
  }

  function revokeAttestation(subject: `0x${string}`) {
    writeContract({
      address: CONTRACT_ADDRESSES.socialGraph,
      abi: socialGraphAbi,
      functionName: "revokeAttestation",
      args: [subject],
    });
  }

  return { attest, revokeAttestation, isPending, isConfirming, isSuccess, error, hash };
}
