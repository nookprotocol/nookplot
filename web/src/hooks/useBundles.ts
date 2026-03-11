import { keepPreviousData } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";

export interface SubgraphBundle {
  id: string;
  bundleId: string;
  creator: { id: string };
  name: string;
  descriptionCid: string;
  contentCids: string[];
  contributorCount: number;
  cidCount: number;
  createdAt: string;
  isActive: boolean;
  bundleType?: string | null;
  tags?: string[];
  summary?: string | null;
  domain?: string | null;
  bundleMetadata?: Record<string, unknown> | null;
  citationCount?: number;
  bundleScore?: number;
  contributors?: Array<{
    id: string;
    contributor: { id: string };
    weightBps: number;
  }>;
}

/** Gateway GET /v1/bundles response */
interface GatewayBundlesResult {
  bundles: SubgraphBundle[];
  first: number;
  skip: number;
}

/**
 * List bundles — gateway-first (benefits from 72h stale cache).
 */
export function useBundles(page = 0, pageSize = 20, sort?: string) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));
  if (sort) params.set("sort", sort);

  const result = useGatewayQuery<GatewayBundlesResult>(
    ["bundles", String(page), sort ?? "newest"],
    `/v1/bundles?${params}`,
    { staleTime: 300_000, placeholderData: keepPreviousData },
  );

  return {
    bundles: result.data?.bundles ?? [],
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

/**
 * Fetch the single highest-scored bundle (server-side composite scoring).
 */
export function useTopBundle() {
  const result = useGatewayQuery<GatewayBundlesResult>(
    ["bundles", "top"],
    "/v1/bundles?sort=score&first=1",
    { staleTime: 300_000 },
  );

  return {
    topBundle: result.data?.bundles?.[0] ?? undefined,
    isLoading: result.isLoading,
  };
}

/**
 * Single bundle detail — gateway-first.
 */
export function useBundle(bundleId: string | undefined) {
  const result = useGatewayQuery<SubgraphBundle | null>(
    ["bundle", bundleId ?? ""],
    `/v1/bundles/${bundleId}`,
    { enabled: !!bundleId, staleTime: 300_000 },
  );

  return {
    bundle: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/**
 * Bundles by creator — now uses the gateway index endpoint.
 */

/** Shape returned by GET /v1/index/bundles/creator/:addr */
interface IndexBundlesByCreatorResponse {
  bundles: Array<{
    id: string;
    bundle_id: string;
    creator_id: string;
    name: string;
    cid_count: number;
    contributor_count: number;
    created_at: string;
    is_active: boolean;
  }>;
}

export function useBundlesByCreator(address: string | undefined) {
  const result = useGatewayQuery<IndexBundlesByCreatorResponse>(
    ["bundles-by-creator", address ?? ""],
    `/v1/index/bundles/creator/${address?.toLowerCase()}`,
    { enabled: !!address, staleTime: 300_000 },
  );

  const bundles: SubgraphBundle[] = (result.data?.bundles ?? []).map((b) => ({
    id: b.id,
    bundleId: b.bundle_id,
    creator: { id: b.creator_id },
    name: b.name,
    descriptionCid: "",
    contentCids: [],
    contributorCount: b.contributor_count,
    cidCount: b.cid_count,
    createdAt: b.created_at,
    isActive: b.is_active,
  }));

  return {
    bundles,
    isLoading: result.isLoading,
  };
}
