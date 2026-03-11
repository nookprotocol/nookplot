import { useGatewayQuery } from "./useGatewayQuery";

/**
 * API availability record from the gateway.
 *
 * Fields mirror the `api_availability` table with tiered disclosure:
 * - Public:        listing_id, status, last_heartbeat, uptime
 * - Authenticated: + provider_address, latency, active_agreements
 */
export interface ApiAvailability {
  listing_id: number;
  provider_address: string;
  status: "online" | "degraded" | "offline";
  last_heartbeat: string;
  uptime_checks: number;
  uptime_passes: number;
  last_latency_ms: number | null;
  active_agreements: number;
  created_at: string;
  updated_at: string;
}

/** Usage summary for an API agreement. */
export interface ApiUsageSummary {
  total_requests: number;
  success_count: number;
  error_count: number;
  avg_latency_ms: number;
  total_bytes: number;
  first_request: string | null;
  last_request: string | null;
}

/** Individual usage log entry. */
export interface ApiUsageLog {
  id: string;
  agreement_id: number;
  request_method: string;
  request_path: string;
  response_status: number;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  buyer_address: string;
  created_at: string;
}

interface ApiAvailabilityListResponse {
  apis: ApiAvailability[];
  limit: number;
  offset: number;
}

interface ApiUsageResponse {
  summary: ApiUsageSummary;
  logs: ApiUsageLog[];
  limit: number;
  offset: number;
}

/**
 * Fetch available API services with optional filters.
 */
export function useApiListings(filters: {
  status?: "online" | "degraded" | "any";
  minUptime?: number;
  limit?: number;
  offset?: number;
} = {}, authenticated = false) {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== "any") params.set("status", filters.status);
  if (filters.minUptime !== undefined) params.set("minUptime", String(filters.minUptime));
  params.set("limit", String(filters.limit ?? 20));
  if (filters.offset) params.set("offset", String(filters.offset));

  const result = useGatewayQuery<ApiAvailabilityListResponse>(
    ["apiListings", filters.status ?? "", String(filters.minUptime ?? ""), String(filters.offset ?? 0), String(authenticated)],
    `/v1/api/availability?${params}`,
    { staleTime: 30_000 },
    authenticated,
  );

  return {
    apis: result.data?.apis ?? [],
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

/**
 * Fetch a single API listing's availability.
 */
export function useApiAvailability(listingId: number | undefined, authenticated = false) {
  const result = useGatewayQuery<{ availability: ApiAvailability }>(
    ["apiAvailability", String(listingId ?? ""), String(authenticated)],
    `/v1/api/availability/${listingId}`,
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
 * Fetch usage stats for an API agreement.
 */
export function useApiUsage(agreementId: number | undefined, limit = 50, offset = 0) {
  return useGatewayQuery<ApiUsageResponse>(
    ["apiUsage", String(agreementId ?? ""), String(limit), String(offset)],
    `/v1/api/usage/${agreementId}?limit=${limit}&offset=${offset}`,
    { enabled: !!agreementId, staleTime: 30_000 },
    true, // usage requires auth
  );
}
