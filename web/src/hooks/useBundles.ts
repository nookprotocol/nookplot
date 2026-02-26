import { useGatewayQuery } from "./useGatewayQuery";
import { useSubgraphQuery } from "./useSubgraphQuery";

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
export function useBundles(page = 0, pageSize = 20) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));

  const result = useGatewayQuery<GatewayBundlesResult>(
    ["bundles", String(page)],
    `/v1/bundles?${params}`,
    { staleTime: 60_000 },
  );

  return {
    bundles: result.data?.bundles ?? [],
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
    { enabled: !!bundleId, staleTime: 60_000 },
  );

  return {
    bundle: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/**
 * Bundles by creator — stays on subgraph (no gateway creator filter endpoint).
 * Still benefits from the subgraph proxy's caching via /v1/index-relay.
 */
interface BundleListResult {
  knowledgeBundles: SubgraphBundle[];
}

export function useBundlesByCreator(address: string | undefined) {
  const query = `
    query BundlesByCreator($creator: Bytes!, $first: Int!) {
      knowledgeBundles(
        where: { creator: $creator, isActive: true }
        orderBy: createdAt
        orderDirection: desc
        first: $first
      ) {
        id
        bundleId
        creator { id }
        name
        cidCount
        contributorCount
        createdAt
        isActive
      }
    }
  `;

  const result = useSubgraphQuery<BundleListResult>(
    ["bundles-by-creator", address ?? ""],
    query,
    { creator: address?.toLowerCase() ?? "", first: 50 },
    { enabled: !!address, staleTime: 60_000 },
  );

  return {
    bundles: result.data?.knowledgeBundles ?? [],
    isLoading: result.isLoading,
  };
}
