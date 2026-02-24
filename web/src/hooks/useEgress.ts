import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface EgressAllowlistEntry {
  id: string;
  domain: string;
  max_requests_per_hour: number;
  created_at: string;
}

export interface StoredCredential {
  service: string;
  createdAt: string;
}

export interface EgressLogEntry {
  id: string;
  domain: string;
  method: string;
  path: string;
  status_code: number | null;
  request_size: number;
  response_size: number;
  credits_charged: number;
  duration_ms: number;
  error_message: string | null;
  created_at: string;
}

// ============================================================
//  Hooks
// ============================================================

export function useEgressAllowlist(apiKey: string | null) {
  const [allowlist, setAllowlist] = useState<EgressAllowlistEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ allowlist: EgressAllowlistEntry[] }>(
        "/v1/agents/me/egress",
        apiKey,
      );
      setAllowlist(data.allowlist);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { refresh(); }, [refresh]);

  const addDomain = useCallback(async (domain: string, maxRequestsPerHour = 60) => {
    if (!apiKey) return;
    await gatewayFetch("/v1/agents/me/egress", apiKey, {
      method: "PUT",
      body: JSON.stringify({ domain, maxRequestsPerHour }),
    });
    refresh();
  }, [apiKey, refresh]);

  const removeDomain = useCallback(async (domain: string) => {
    if (!apiKey) return;
    await gatewayFetch("/v1/agents/me/egress", apiKey, {
      method: "PUT",
      body: JSON.stringify({ domain, remove: true }),
    });
    refresh();
  }, [apiKey, refresh]);

  return { allowlist, isLoading, refresh, addDomain, removeDomain };
}

export function useStoredCredentials(apiKey: string | null) {
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ credentials: StoredCredential[] }>(
        "/v1/agents/me/credentials",
        apiKey,
      );
      setCredentials(data.credentials);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => { refresh(); }, [refresh]);

  const store = useCallback(async (service: string, credentialKey: string) => {
    if (!apiKey) return;
    await gatewayFetch("/v1/agents/me/credentials", apiKey, {
      method: "POST",
      body: JSON.stringify({ service, apiKey: credentialKey }),
    });
    refresh();
  }, [apiKey, refresh]);

  const remove = useCallback(async (service: string) => {
    if (!apiKey) return;
    await gatewayFetch(`/v1/agents/me/credentials/${encodeURIComponent(service)}`, apiKey, {
      method: "DELETE",
    });
    refresh();
  }, [apiKey, refresh]);

  return { credentials, isLoading, refresh, store, remove };
}

export function useEgressLog(apiKey: string | null, page = 0) {
  const [entries, setEntries] = useState<EgressLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<{ entries: EgressLogEntry[] }>(
      `/v1/actions/egress/log?limit=20&offset=${page * 20}`,
      apiKey,
    )
      .then((data) => setEntries(data.entries))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey, page]);

  return { entries, isLoading };
}
