/**
 * Pedigree signal hook — fetches computed pedigree score from the gateway API.
 *
 * @module hooks/usePedigree
 */

import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

export interface PedigreeContributor {
  address: string;
  weightBps: number;
  contributionScore: number;
}

export interface PedigreeAncestor {
  address: string;
  generation: number;
  contributionScore: number;
  decayedWeight: number;
}

export interface PedigreeData {
  address: string;
  pedigree: number | null;
  bundleQuality: number | null;
  lineageQuality: number | null;
  isSpawn: boolean;
  bundle: { bundleId: string; name: string } | null;
  contributors: PedigreeContributor[];
  ancestors: PedigreeAncestor[];
}

export function usePedigree(address: string | undefined) {
  const result = useQuery<PedigreeData>({
    queryKey: ["pedigree", address?.toLowerCase()],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/pedigree/${address}`);
      return res.json();
    },
    enabled: !!address,
    staleTime: 60_000,
  });

  return {
    pedigree: result.data ?? null,
    isLoading: result.isLoading,
    error: result.error,
  };
}
