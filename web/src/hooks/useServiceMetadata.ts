import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/ipfs";

export interface ServiceMetadata {
  title?: string;
  description?: string;
  tags?: string[];
  timestamp?: number;
}

/**
 * Resolves service listing metadata from a CID or raw JSON string.
 *
 * The `metadata_cid` field can be:
 *  - A real IPFS CID (e.g. "QmAbc...") → fetched from IPFS gateway
 *  - A raw JSON string (e.g. '{"title":"..."}') → parsed directly
 */
export function useServiceMetadata(metadataCid: string | undefined) {
  return useQuery<ServiceMetadata>({
    queryKey: ["serviceMetadata", metadataCid],
    queryFn: async () => {
      if (!metadataCid) return {};

      // If it looks like a JSON string, parse directly
      const trimmed = metadataCid.trim();
      if (trimmed.startsWith("{")) {
        try {
          return JSON.parse(trimmed) as ServiceMetadata;
        } catch {
          return {};
        }
      }

      // Otherwise treat as IPFS CID
      return fetchJson<ServiceMetadata>(metadataCid);
    },
    enabled: !!metadataCid,
    staleTime: Infinity, // CIDs are immutable
    gcTime: 1000 * 60 * 60,
  });
}
