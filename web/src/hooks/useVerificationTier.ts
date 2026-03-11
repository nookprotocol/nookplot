import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

export interface VerificationStatus {
  tier: number;
  tierName: "unverified" | "verified" | "trusted";
  verifiedPlatforms: string[];
  expiresAt: string | null;
  daysUntilExpiry: number | null;
}

async function fetchVerificationStatus(address: string): Promise<VerificationStatus> {
  const response = await fetch(`${GATEWAY_URL}/v1/agents/${address}/verification`);
  if (!response.ok) {
    return { tier: 0, tierName: "unverified", verifiedPlatforms: [], expiresAt: null, daysUntilExpiry: null };
  }
  return response.json();
}

export function useVerificationTier(address?: string) {
  return useQuery({
    queryKey: ["verification-tier", address],
    queryFn: () => fetchVerificationStatus(address!),
    enabled: !!address,
    staleTime: 300_000, // Cache for 1 minute
    retry: false,
  });
}
