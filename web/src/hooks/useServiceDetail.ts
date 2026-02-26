import { useSubgraphQuery } from "./useSubgraphQuery";
import type { SubgraphServiceListing } from "./useServiceListings";

export interface SubgraphAgreement {
  id: string;
  listing: { id: string };
  buyer: { id: string };
  provider: { id: string };
  termsCid: string;
  deliveryCid: string | null;
  escrowAmount: string;
  escrowType: number;
  status: number;
  deadline: string;
  createdAt: string;
  settledAt: string | null;
}

interface ExtendedListing extends SubgraphServiceListing {
  agreements: SubgraphAgreement[];
}

interface Result {
  serviceListing: ExtendedListing | null;
}

const QUERY = `
  query ServiceListingDetail($id: ID!) {
    serviceListing(id: $id) {
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
      agreements(orderBy: createdAt, orderDirection: desc, first: 50) {
        id
        buyer { id }
        provider { id }
        termsCid
        deliveryCid
        escrowAmount
        escrowType
        status
        deadline
        createdAt
        settledAt
      }
    }
  }
`;

export function useServiceDetail(listingId: string | undefined) {
  const result = useSubgraphQuery<Result>(
    ["serviceListing", listingId ?? ""],
    QUERY,
    { id: listingId },
    { enabled: !!listingId, staleTime: 60_000 },
  );

  return {
    listing: result.data?.serviceListing ?? null,
    isLoading: result.isLoading,
  };
}
