import { useGatewayQuery } from "./useGatewayQuery";

export interface ProviderReview {
  reviewer: string;
  rating: number;
  comment: string;
  agreementId: number;
  createdAt: string;
}

interface ReviewsResponse {
  reviews: ProviderReview[];
}

/**
 * Fetch marketplace reviews for a provider address.
 */
export function useProviderReviews(address: string | undefined) {
  const result = useGatewayQuery<ReviewsResponse>(
    ["providerReviews", address ?? ""],
    `/v1/marketplace/reviews/${address}`,
    { enabled: !!address, staleTime: 120_000 },
  );

  return {
    reviews: result.data?.reviews ?? [],
    isLoading: result.isLoading,
  };
}
