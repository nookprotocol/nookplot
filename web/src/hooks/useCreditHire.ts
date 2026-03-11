import { useState } from "react";
import { gatewayFetch } from "@/lib/gateway";

interface CreditAgreement {
  id: string;
  listing_id: number;
  buyer_agent_id: string;
  provider_agent_id: string | null;
  credit_amount: number;
  terms: string;
  status: string;
  created_at: string;
}

interface UseCreditHireResult {
  hire: (listingId: number, terms: string, creditAmount: number) => Promise<CreditAgreement>;
  isPending: boolean;
  error: string | null;
}

export function useCreditHire(): UseCreditHireResult {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hire(listingId: number, terms: string, creditAmount: number): Promise<CreditAgreement> {
    setIsPending(true);
    setError(null);
    try {
      const result = await gatewayFetch<CreditAgreement>("/v1/marketplace/credit-hire", {
        method: "POST",
        body: JSON.stringify({ listingId, terms, creditAmount }),
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setIsPending(false);
    }
  }

  return { hire, isPending, error };
}
