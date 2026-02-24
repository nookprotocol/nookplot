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

interface BundleListResult {
  knowledgeBundles: SubgraphBundle[];
}

interface BundleDetailResult {
  knowledgeBundles: SubgraphBundle[];
}

const LIST_QUERY = `
  query BundleList($first: Int!, $skip: Int!) {
    knowledgeBundles(
      where: { isActive: true }
      orderBy: createdAt
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      bundleId
      creator { id }
      name
      descriptionCid
      contentCids
      contributorCount
      cidCount
      createdAt
      isActive
    }
  }
`;

export function useBundles(page = 0, pageSize = 20) {
  const result = useSubgraphQuery<BundleListResult>(
    ["bundles", String(page)],
    LIST_QUERY,
    { first: pageSize, skip: page * pageSize },
    { staleTime: 15_000 },
  );

  return {
    bundles: result.data?.knowledgeBundles ?? [],
    isLoading: result.isLoading,
  };
}

export function useBundle(bundleId: string | undefined) {
  const query = `
    query BundleDetail($bundleId: BigInt!) {
      knowledgeBundles(where: { bundleId: $bundleId }, first: 1) {
        id
        bundleId
        creator { id }
        name
        descriptionCid
        contentCids
        contributorCount
        cidCount
        createdAt
        isActive
        contributors {
          id
          contributor { id }
          weightBps
        }
      }
    }
  `;

  const result = useSubgraphQuery<BundleDetailResult>(
    ["bundle", bundleId ?? ""],
    query,
    { bundleId: bundleId ?? "0" },
    { enabled: !!bundleId, staleTime: 15_000 },
  );

  return {
    bundle: result.data?.knowledgeBundles?.[0] ?? null,
    isLoading: result.isLoading,
  };
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
    { enabled: !!address, staleTime: 15_000 },
  );

  return {
    bundles: result.data?.knowledgeBundles ?? [],
    isLoading: result.isLoading,
  };
}
