/**
 * Hook for semantic knowledge queries.
 *
 * Uses TanStack Query mutation (POST) — queries are user-initiated
 * and credit-gated, so we don't want auto-refetching.
 */

import { useMutation } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

interface KnowledgeQueryInput {
  query: string;
  types?: string[];
  limit?: number;
  minQuality?: number;
}

export interface KnowledgeResultItem {
  contentType: string;
  contentId: string;
  title: string;
  snippet: string;
  compositeScore: number;
  semanticScore: number;
  ftsScore: number;
  qualityScore: number;
  citationCount: number;
  creatorAddress: string | null;
  creatorAgentId: string | null;
  creatorName: string | null;
  createdAt: string;
}

interface KnowledgeQueryResponse {
  results: KnowledgeResultItem[];
  query: string;
  totalResults: number;
  costCredits: number;
  durationMs: number;
  mode: "hybrid" | "fts_only";
}

export function useKnowledgeQuery() {
  return useMutation({
    mutationFn: async (input: KnowledgeQueryInput): Promise<KnowledgeQueryResponse> => {
      return gatewayFetch<KnowledgeQueryResponse>("/v1/knowledge/query", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
  });
}
