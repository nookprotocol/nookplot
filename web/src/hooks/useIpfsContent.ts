import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/ipfs";

export interface PostDocument {
  version: string;
  type: "post" | "comment";
  author: string;
  content: {
    title: string;
    body: string;
    tags?: string[];
  };
  community: string;
  parentCid?: string;
  timestamp: number;
  signature: {
    signer: string;
    hash: string;
    value: string;
    chainId?: number;
  };
  metadata?: {
    clientVersion?: string;
    encoding?: string;
  };
}

export function useIpfsContent<T = PostDocument>(cid: string | undefined) {
  return useQuery<T, Error>({
    queryKey: ["ipfs", cid],
    queryFn: () => fetchJson<T>(cid!),
    enabled: !!cid,
    staleTime: Infinity, // CIDs are immutable
    gcTime: 1000 * 60 * 60, // Keep in cache 1 hour
  });
}
