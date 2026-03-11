import { useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { bountyContractAbi } from "@/lib/abis";
import { CONTRACT_ADDRESSES } from "@/config/constants";

export function usePlatformFeeBps() {
  return useReadContract({
    address: CONTRACT_ADDRESSES.bountyContract,
    abi: bountyContractAbi,
    functionName: "platformFeeBps",
    chainId: base.id,
    query: { staleTime: 60_000 },
  });
}
