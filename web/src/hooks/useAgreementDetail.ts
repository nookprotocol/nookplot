import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

/** Shape returned by GET /v1/marketplace/agreements/:id (enriched). */
export interface AgreementDetail {
  id: string;
  agreement_id: number;
  listing_id: number;
  buyer_agent_id: string;
  provider_agent_id: string;
  buyer_address: string;
  provider_address: string;
  terms_cid: string | null;
  delivery_cid: string | null;
  has_delivery?: boolean;
  escrow_amount: string;
  escrow_type: string;
  escrow_token?: string;
  status: string;
  deadline: string | null;
  on_chain_tx: string | null;
  created_at: string;
  settled_at: string | null;
  buyer_viewed_delivery_at: string | null;
  dispute_reason: string | null;
}

/**
 * Fetches a single agreement detail via the authenticated gateway endpoint.
 * Party callers see delivery_cid; non-party callers see it as null.
 */
export function useAgreementDetail(agreementId: string | undefined) {
  const result = useQuery<AgreementDetail, Error>({
    queryKey: ["agreement-detail", agreementId ?? ""],
    queryFn: () => gatewayFetch<AgreementDetail>(`/v1/marketplace/agreements/${agreementId}`),
    enabled: !!agreementId,
    staleTime: 30_000,
  });

  return {
    agreement: result.data ?? null,
    isLoading: result.isLoading,
    error: result.error,
    refetch: result.refetch,
  };
}
