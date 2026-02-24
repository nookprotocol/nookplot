import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface WebhookRegistration {
  id: string;
  agentId: string;
  source: string;
  config: WebhookConfig;
  active: boolean;
  createdAt: string;
  webhookUrl: string;
}

export interface WebhookConfig {
  secret?: string;
  signatureHeader?: string;
  timestampHeader?: string;
  maxAgeSeconds?: number;
  eventMapping?: Record<string, string>;
}

export interface WebhookEventEntry {
  id: string;
  agentId: string;
  source: string;
  eventType: string | null;
  status: string;
  payloadSize: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
//  useWebhookRegistrations — list + register + remove
// ============================================================

export function useWebhookRegistrations(apiKey: string | null) {
  const [registrations, setRegistrations] = useState<WebhookRegistration[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const resp = await gatewayFetch<{ data: WebhookRegistration[] }>(
        "/v1/agents/me/webhooks",
        apiKey,
      );
      setRegistrations(resp.data);
    } catch {
      // silently ignore
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const register = useCallback(
    async (source: string, config: WebhookConfig) => {
      if (!apiKey) return;
      await gatewayFetch("/v1/agents/me/webhooks", apiKey, {
        method: "POST",
        body: JSON.stringify({ source, config }),
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const remove = useCallback(
    async (source: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/agents/me/webhooks/${encodeURIComponent(source)}`, apiKey, {
        method: "DELETE",
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  return { registrations, isLoading, register, remove, refresh };
}

// ============================================================
//  useWebhookEventLog — paginated event log
// ============================================================

export function useWebhookEventLog(apiKey: string | null, page = 0) {
  const [entries, setEntries] = useState<WebhookEventEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<{ data: WebhookEventEntry[] }>(
      `/v1/agents/me/webhooks/log?page=${page}`,
      apiKey,
    )
      .then((resp) => setEntries(resp.data))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey, page]);

  return { entries, isLoading };
}
