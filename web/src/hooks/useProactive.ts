/**
 * Hooks for the proactive agent loop (gateway REST, not subgraph).
 *
 * All proactive data lives in PostgreSQL, so we call gateway endpoints
 * using the same gatewayFetch pattern as useCredits.ts.
 */

import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface ProactiveSettings {
  agentId: string;
  enabled: boolean;
  scanIntervalMinutes: number;
  maxCreditsPerCycle: number;
  maxActionsPerDay: number;
  pausedUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProactiveAction {
  id: string;
  agentId: string;
  actionType: string;
  status: string;
  inferenceCost: number;
  result: Record<string, unknown> | null;
  ownerDecision: string | null;
  ownerDecidedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  opportunity: {
    type: string;
    title: string;
    sourceId: string;
    alignmentScore: number;
  } | null;
}

export interface ProactiveStats {
  actionsToday: number;
  actionsPending: number;
  actionsCompletedTotal: number;
  creditsSpentToday: number;
  successRate: number;
  lastScanAt: string | null;
}

export interface ScanLogEntry {
  id: string;
  agentId: string;
  opportunitiesFound: number;
  actionsProposed: number;
  actionsAutoExecuted: number;
  creditsSpent: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
//  Hooks
// ============================================================

/**
 * Get and update proactive settings for the authenticated agent.
 */
export function useProactiveSettings(apiKey: string | null) {
  const [settings, setSettings] = useState<ProactiveSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<ProactiveSettings>("/v1/proactive/settings", apiKey);
      setSettings(data);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateSettings = useCallback(
    async (updates: Partial<ProactiveSettings>) => {
      if (!apiKey) return;
      try {
        const data = await gatewayFetch<ProactiveSettings>("/v1/proactive/settings", apiKey, {
          method: "PUT",
          body: JSON.stringify(updates),
        });
        setSettings(data);
        return data;
      } catch (err) {
        throw err;
      }
    },
    [apiKey],
  );

  return { settings, isLoading, updateSettings, refresh };
}

/**
 * Paginated activity feed of proactive actions.
 */
export function useProactiveActivity(apiKey: string | null, page = 0) {
  const [actions, setActions] = useState<ProactiveAction[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ actions: ProactiveAction[] }>(
        `/v1/proactive/activity?limit=20&offset=${page * 20}`,
        apiKey,
      );
      setActions(data.actions);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, page]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { actions, isLoading, refresh };
}

/**
 * Pending approval actions for the authenticated agent.
 */
export function useProactiveApprovals(apiKey: string | null) {
  const [approvals, setApprovals] = useState<ProactiveAction[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ approvals: ProactiveAction[]; count: number }>(
        "/v1/proactive/approvals",
        apiKey,
      );
      setApprovals(data.approvals);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const approve = useCallback(
    async (actionId: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/proactive/approvals/${actionId}/approve`, apiKey, {
        method: "POST",
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const reject = useCallback(
    async (actionId: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/proactive/approvals/${actionId}/reject`, apiKey, {
        method: "POST",
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  return { approvals, isLoading, approve, reject, refresh };
}

/**
 * Summary stats for an agent's proactive activity.
 */
export function useProactiveStats(apiKey: string | null) {
  const [stats, setStats] = useState<ProactiveStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<ProactiveStats>("/v1/proactive/stats", apiKey);
      setStats(data);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { stats, isLoading, refresh };
}

/**
 * Scan history for diagnostics.
 */
export function useProactiveScanHistory(apiKey: string | null, limit = 20) {
  const [scans, setScans] = useState<ScanLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<{ scans: ScanLogEntry[] }>(`/v1/proactive/scans?limit=${limit}`, apiKey)
      .then((data) => setScans(data.scans))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey, limit]);

  return { scans, isLoading };
}
