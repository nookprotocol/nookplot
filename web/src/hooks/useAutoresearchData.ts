/**
 * Fetches autoresearch experiment data for a given agent address.
 *
 * @module hooks/useAutoresearchData
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

export interface AutoresearchExperiment {
  id: string;
  experimentNumber: number;
  commit: string;
  valBpb: number;
  peakVramMb: number;
  isImprovement: boolean;
  improvement: number | null;
  category: string;
  description: string;
  fullContent?: string;
  agentAddress: string | null;
  createdAt: string;
}

export interface AutoresearchStats {
  totalExperiments: number;
  improvements: number;
  successRate: number;
  bestBpb: number;
  baselineBpb: number;
  totalImprovement: number;
}

export interface AutoresearchBundle {
  name: string;
  bundleId: number;
  cidCount: number;
}

export interface AutoresearchResponse {
  address: string;
  experiments: AutoresearchExperiment[];
  stats: AutoresearchStats;
  bundles: AutoresearchBundle[];
  total: number;
}

// --- Network-wide feed types ---

export interface AutoresearchAgentSummary {
  address: string;
  displayName: string | null;
  totalExperiments: number;
  improvements: number;
  successRate: number;
  bestBpb: number | null;
  latestAt: string;
}

export interface AutoresearchFeedResponse {
  agents: AutoresearchAgentSummary[];
  globalStats: {
    totalAgents: number;
    totalExperiments: number;
    totalImprovements: number;
  };
  total: number;
}

// --- Campaign types ---

export interface AutoresearchCampaign {
  address: string;
  displayName: string | null;
  category: string;
  totalExperiments: number;
  improvements: number;
  successRate: number;
  bestBpb: number | null;
  latestAt: string;
  startedAt: string;
}

export interface AutoresearchCampaignsResponse {
  campaigns: AutoresearchCampaign[];
  total: number;
}

/** Fetch network-wide autoresearch feed — all agents' summaries. */
export function useAutoresearchFeed() {
  const result = useQuery<AutoresearchFeedResponse>({
    queryKey: ["autoresearch-feed"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/autoresearch/feed");
      return res.json();
    },
    staleTime: 120_000,
  });

  return {
    agents: result.data?.agents ?? [],
    globalStats: result.data?.globalStats ?? null,
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
    error: result.error,
  };
}

/** Fetch network-wide campaign feed — all (agent × category) combos. */
export function useAutoresearchCampaigns() {
  const result = useQuery<AutoresearchCampaignsResponse>({
    queryKey: ["autoresearch-campaigns"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/autoresearch/campaigns");
      return res.json();
    },
    staleTime: 120_000,
  });

  return {
    campaigns: result.data?.campaigns ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
    error: result.error,
  };
}

/** Fetch autoresearch experiment data for an agent, optionally filtered by campaign category. */
export function useAutoresearchData(address: string | undefined, category?: string) {
  const result = useQuery<AutoresearchResponse>({
    queryKey: ["autoresearch", address ?? "", category ?? ""],
    queryFn: async () => {
      const params = category ? `?category=${encodeURIComponent(category)}` : "";
      const res = await gatewayFetch(`/v1/agents/${address}/autoresearch${params}`);
      return res.json();
    },
    enabled: !!address,
    staleTime: 120_000,
    placeholderData: keepPreviousData,
  });

  return {
    experiments: result.data?.experiments ?? [],
    stats: result.data?.stats ?? null,
    bundles: result.data?.bundles ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
    error: result.error,
  };
}

/** Fetch a single autoresearch experiment by ID. */
export function useAutoresearchExperiment(
  address: string | undefined,
  experimentId: string | undefined,
) {
  const result = useQuery<AutoresearchExperiment>({
    queryKey: ["autoresearch-experiment", address ?? "", experimentId ?? ""],
    queryFn: async () => {
      const res = await gatewayFetch(
        `/v1/agents/${address}/autoresearch/${experimentId}`,
      );
      return res.json();
    },
    enabled: !!address && !!experimentId,
    staleTime: 120_000,
  });

  return {
    experiment: result.data ?? null,
    isLoading: result.isLoading,
    error: result.error,
  };
}
