import { useGatewayQuery } from "./useGatewayQuery";

/**
 * GPU availability — tiered disclosure.
 *
 * Public:        listing_id, status, vram_tier, last_heartbeat
 * Authenticated: + provider_address, gpu_model, vram_gb
 * Agreement:     + gpu_temp_c, gpu_utilization, vram_used_gb
 *
 * All fields optional to handle each tier gracefully.
 */
export interface GpuAvailability {
  listing_id: number;
  status: "online" | "degraded" | "offline";
  last_heartbeat: string;
  current_agreement_id?: number | null;
  // Public tier
  vram_tier?: string;
  // Authenticated tier
  provider_address?: string;
  gpu_model?: string;
  vram_gb?: number;
  // Agreement tier
  gpu_temp_c?: number;
  gpu_utilization?: number;
  vram_used_gb?: number;
}

/** GPU challenge stats for a provider (always public). */
export interface GpuChallengeStats {
  totalChallenges: number;
  completedChallenges: number;
  failedChallenges: number;
  passRate: number;
  lastChallengeAt: string | null;
  avgTflops?: number | null;
}

/** Redacted challenge record (authenticated view). */
export interface GpuChallengeRedacted {
  challenge_id: string;
  listing_id: number;
  status: "pending" | "running" | "completed" | "failed" | "expired";
  created_at: string;
  completed_at: string | null;
}

/** Provider GPU profile from marketplace endpoint (public tier). */
export interface GpuProviderProfile {
  address: string;
  agentId: string;
  stats: Record<string, unknown>;
  listings: unknown[];
  gpu: {
    hasAttestation: boolean;
    attestedAt: string | null;
    challengeStats: {
      total_challenges: number;
      passed: number;
      failed: number;
      last_challenge_at: string | null;
    } | null;
    availability: {
      status: string;
      vramTier: string | null;
      lastHeartbeat: string;
    } | null;
  } | null;
}

interface GpuAvailabilityResponse {
  gpus: GpuAvailability[];
  limit: number;
  offset: number;
}

interface GpuProviderChallengesResponse {
  stats: GpuChallengeStats;
  challenges?: GpuChallengeRedacted[];
  limit: number;
  offset: number;
}

/**
 * Fetch available GPUs with optional filters.
 * Pass authenticated=true to get full specs (requires session cookie).
 */
export function useGpuListings(filters: {
  gpuModel?: string;
  minVram?: number;
  status?: "online" | "degraded" | "any";
  limit?: number;
  offset?: number;
} = {}, authenticated = false) {
  const params = new URLSearchParams();
  if (filters.gpuModel) params.set("gpuModel", filters.gpuModel);
  if (filters.minVram !== undefined) params.set("minVram", String(filters.minVram));
  if (filters.status && filters.status !== "any") params.set("status", filters.status);
  params.set("limit", String(filters.limit ?? 20));
  if (filters.offset) params.set("offset", String(filters.offset));

  const result = useGatewayQuery<GpuAvailabilityResponse>(
    ["gpuListings", filters.gpuModel ?? "", String(filters.minVram ?? ""), filters.status ?? "", String(filters.offset ?? 0), String(authenticated)],
    `/v1/gpu/availability?${params}`,
    { staleTime: 30_000 },
    authenticated,
  );

  return {
    gpus: result.data?.gpus ?? [],
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

/**
 * Fetch a single GPU listing's availability.
 */
export function useGpuAvailability(listingId: number | undefined, authenticated = false) {
  const result = useGatewayQuery<{ availability: GpuAvailability }>(
    ["gpuAvailability", String(listingId ?? ""), String(authenticated)],
    `/v1/gpu/availability/${listingId}`,
    { enabled: !!listingId, staleTime: 15_000 },
    authenticated,
  );
  return {
    data: result.data?.availability,
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

/**
 * Fetch a provider's challenge stats (+ redacted history if authenticated).
 */
export function useGpuProviderChallenges(address: string | undefined, authenticated = false) {
  return useGatewayQuery<GpuProviderChallengesResponse>(
    ["gpuProviderChallenges", address ?? "", String(authenticated)],
    `/v1/gpu/providers/${address}/challenges?limit=20&offset=0`,
    { enabled: !!address, staleTime: 60_000 },
    authenticated,
  );
}

/**
 * Fetch a provider's marketplace profile with GPU data (public tier).
 */
export function useGpuProviderProfile(address: string | undefined) {
  return useGatewayQuery<GpuProviderProfile>(
    ["gpuProviderProfile", address ?? ""],
    `/v1/marketplace/provider/${address}`,
    { enabled: !!address, staleTime: 60_000 },
  );
}

/** Research stats for a GPU provider. */
export interface GpuResearchStats {
  totalExperiments: number;
  improvements: number;
  bundlesProduced: number;
  successRate: number;
}

/**
 * Fetch research stats for a GPU provider (experiments hosted on their hardware).
 */
export function useGpuResearchStats(address: string | undefined) {
  return useGatewayQuery<GpuResearchStats>(
    ["gpuResearchStats", address ?? ""],
    `/v1/gpu/providers/${address}/research-stats`,
    { enabled: !!address, staleTime: 120_000 },
  );
}
