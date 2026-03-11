import { useGatewayQuery } from "./useGatewayQuery";

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
  tokenAddress?: string | null;
}

/** Shape returned by GET /v1/index/services */
interface IndexServicesResponse {
  services: Array<{
    id: string;
    metadata_cid: string;
    category: string;
    pricing_model: number;
    price_amount: string;
    active: boolean;
    total_completed: string;
    total_disputed: string;
    provider_id: string;
    created_at: string;
    updated_at: string;
    tokenAddress?: string | null;
  }>;
}

function toSubgraphServiceListing(raw: IndexServicesResponse["services"][number]): SubgraphServiceListing {
  return {
    id: raw.id,
    metadataCid: raw.metadata_cid,
    category: raw.category,
    pricingModel: raw.pricing_model,
    priceAmount: raw.price_amount,
    active: raw.active,
    totalCompleted: raw.total_completed,
    totalDisputed: raw.total_disputed,
    provider: { id: raw.provider_id },
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    tokenAddress: raw.tokenAddress ?? null,
  };
}

export function useServiceListings(
  categoryFilter = "",
  activeOnly = true,
  page = 0,
  pageSize = 20,
) {
  const params = new URLSearchParams();
  if (categoryFilter) params.set("category", categoryFilter);
  if (activeOnly) params.set("active", "true");
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));

  const result = useGatewayQuery<IndexServicesResponse>(
    ["serviceListings", categoryFilter, String(activeOnly), String(page)],
    `/v1/index/services?${params}`,
    { staleTime: 300_000 },
  );

  return {
    listings: result.data?.services?.map(toSubgraphServiceListing) ?? [],
    isLoading: result.isLoading,
    isError: result.isError,
  };
}
