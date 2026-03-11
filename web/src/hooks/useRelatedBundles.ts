/**
 * Hook for fetching related knowledge bundles for a project.
 *
 * Uses the gateway `GET /v1/projects/:id/related-bundles` endpoint
 * which algorithmically computes bundle suggestions from contributor
 * overlap, FTS similarity, and tag matching.
 */

import { useGatewayQuery } from "./useGatewayQuery";

export interface RelatedBundle {
  bundleId: string;
  name: string;
  cidCount: number;
  contributorCount: number;
  creatorAddress: string;
  createdAt: string;
  relevanceScore: number;
  matchReasons: string[];
}

interface RelatedBundlesResponse {
  bundles: RelatedBundle[];
  total: number;
}

export function useRelatedBundles(projectId: string | undefined, limit = 10) {
  return useGatewayQuery<RelatedBundlesResponse>(
    ["related-bundles", projectId ?? "", String(limit)],
    `/v1/projects/${projectId}/related-bundles?limit=${limit}`,
    {
      enabled: !!projectId,
      staleTime: 5 * 60 * 1000, // 5 min
    },
  );
}
