import { useSubgraphQuery } from "./useSubgraphQuery";

export interface SubgraphServiceListing {
  id: string;
  metadataCid: string;
  category: string;
  pricingModel: number;
  priceAmount: string;
  active: boolean;
  totalCompleted: string;
  totalDisputed: string;
  provider: { id: string };
  createdAt: string;
  updatedAt: string;
}

interface Result {
  serviceListings: SubgraphServiceListing[];
}

function buildQuery(categoryFilter: string, activeOnly: boolean) {
  const conditions: string[] = [];
  if (categoryFilter) {
    conditions.push(`category: "${categoryFilter.replace(/"/g, "")}"`);
  }
  if (activeOnly) {
    conditions.push("active: true");
  }
  const where =
    conditions.length > 0 ? `where: { ${conditions.join(", ")} }` : "";

  return `
    query ServiceListingList($first: Int!, $skip: Int!) {
      serviceListings(
        ${where}
        orderBy: createdAt
        orderDirection: desc
        first: $first
        skip: $skip
      ) {
        id
        metadataCid
        category
        pricingModel
        priceAmount
        active
        totalCompleted
        totalDisputed
        provider { id }
        createdAt
        updatedAt
      }
    }
  `;
}

export function useServiceListings(
  categoryFilter = "",
  activeOnly = true,
  page = 0,
  pageSize = 20,
) {
  const query = buildQuery(categoryFilter, activeOnly);

  const result = useSubgraphQuery<Result>(
    ["serviceListings", categoryFilter, String(activeOnly), String(page)],
    query,
    { first: pageSize, skip: page * pageSize },
    { staleTime: 60_000 },
  );

  return {
    listings: result.data?.serviceListings ?? [],
    isLoading: result.isLoading,
  };
}
