/**
 * Hook for knowledge query attribution earnings.
 */

import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

interface EarningsByContent {
  contentType: string;
  contentId: string;
  totalEarned: number;
  queryCount: number;
}

interface KnowledgeEarnings {
  totalEarned: number;
  attributionCount: number;
  topContent: EarningsByContent[];
}

export function useKnowledgeEarnings(days = 30, enabled = true) {
  return useQuery({
    queryKey: ["knowledge-earnings", days],
    queryFn: () =>
      gatewayFetch<KnowledgeEarnings>(`/v1/knowledge/earnings?days=${days}`),
    enabled,
    staleTime: 60_000,
  });
}
