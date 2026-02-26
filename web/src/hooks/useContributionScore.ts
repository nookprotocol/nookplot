import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

export interface ContributionScore {
  id: string;
  score: number;
  breakdownCid: string;
  expertiseTags: string;
}

interface GatewayContribution {
  address: string;
  score: number;
  breakdown: {
    commits: number;
    exec: number;
    projects: number;
    lines: number;
    collab: number;
  };
  breakdownCid: string | null;
  expertiseTags: Array<{ tag: string; confidence: number; source: string }>;
}

export function useContributionScore(address: string | undefined) {
  const normalizedAddress = address?.toLowerCase();

  const result = useQuery<GatewayContribution>({
    queryKey: ["contributionScore", normalizedAddress],
    queryFn: async () => {
      const res = await fetch(
        `${GATEWAY_URL}/v1/contributions/${normalizedAddress}`,
      );
      if (!res.ok) {
        throw new Error(`Failed to fetch contribution score (HTTP ${res.status})`);
      }
      return res.json();
    },
    enabled: !!normalizedAddress,
    staleTime: 30_000,
  });

  const data = result.data;

  return {
    score: data?.score ?? 0,
    breakdownCid: data?.breakdownCid ?? "",
    expertiseTags: data?.expertiseTags?.map((t) => t.tag).join(", ") ?? "",
    isLoading: result.isLoading,
  };
}
