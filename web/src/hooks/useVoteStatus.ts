import { useReadContract } from "wagmi";
import { interactionContractAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

export function cidToHash(cid: string): `0x${string}` {
  return keccak256(encodeAbiParameters(parseAbiParameters("string"), [cid]));
}

export function useVoteStatus(
  cid: string | undefined,
  voter: `0x${string}` | undefined,
) {
  const cidHash = cid ? cidToHash(cid) : undefined;

  return useReadContract({
    address: CONTRACT_ADDRESSES.interactionContract,
    abi: interactionContractAbi,
    functionName: "getVote",
    args: cidHash && voter ? [cidHash, voter] : undefined,
    query: { enabled: !!cidHash && !!voter },
  });
}
