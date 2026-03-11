import { useGatewayQuery } from "./useGatewayQuery";
import type { SubgraphServiceListing } from "./useServiceListings";

export interface SubgraphAgreement {
  id: string;
  listing: { id: string };
  buyer: { id: string };
  provider: { id: string };
  termsCid: string;
  deliveryCid: string | null;
  escrowAmount: string;
  escrowToken?: string;
  escrowType: number;
  status: number;
  deadline: string;
  createdAt: string;
  settledAt: string | null;
}

interface ExtendedListing extends SubgraphServiceListing {
  agreements: SubgraphAgreement[];
}

/** Shape returned by GET /v1/index/services/:id */
interface IndexServiceDetailResponse {
  service: {
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
    agreements?: Array<{
      id: string;
      listing_id: string;
      buyer_id: string;
      provider_id: string;
      terms_cid: string;
      delivery_cid: string | null;
      escrow_amount: string;
      escrowToken?: string | null;
      escrow_type: number;
      status: number;
      deadline: string;
      created_at: string;
      settled_at: string | null;
    }>;
  } | null;
}

function toExtendedListing(raw: IndexServiceDetailResponse["service"]): ExtendedListing | null {
  if (!raw) return null;
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
    agreements: (raw.agreements ?? []).map((a) => ({
      id: a.id,
      listing: { id: a.listing_id },
      buyer: { id: a.buyer_id },
      provider: { id: a.provider_id },
      termsCid: a.terms_cid,
      deliveryCid: a.delivery_cid,
      escrowAmount: a.escrow_amount,
      escrowToken: a.escrowToken ?? undefined,
      escrowType: a.escrow_type,
      status: a.status,
      deadline: a.deadline,
      createdAt: a.created_at,
      settledAt: a.settled_at,
    })),
  };
}

export function useServiceDetail(listingId: string | undefined) {
  const result = useGatewayQuery<IndexServiceDetailResponse>(
    ["serviceListing", listingId ?? ""],
    `/v1/index/services/${listingId}`,
    { enabled: !!listingId, staleTime: 300_000 },
  );

  return {
    listing: toExtendedListing(result.data?.service ?? null),
    isLoading: result.isLoading,
  };
}
