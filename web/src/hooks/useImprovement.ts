/**
 * Hooks for the self-improvement loop (gateway REST, not subgraph).
 *
 * All improvement data lives in PostgreSQL, so we call gateway endpoints
 * using the same gatewayFetch pattern as useProactive.ts.
 */

import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface ImprovementSettings {
  agentId: string;
  enabled: boolean;
  scanIntervalHours: number;
  maxCreditsPerCycle: number;
  maxProposalsPerWeek: number;
  autoApplyThreshold: number;
  soulEvolutionEnabled: boolean;
  bundleCurationEnabled: boolean;
  pausedUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ImprovementProposal {
  id: string;
  agentId: string;
  proposalType: string;
  targetType: string;
  targetId: string | null;
  proposedChanges: Record<string, unknown>;
  reasoning: string;
  confidenceScore: number;
  inferenceCost: number;
  status: string;
  ownerDecision: string | null;
  ownerDecidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
}

export interface SoulVersionEntry {
  id: string;
  agentId: string;
  versionNumber: number;
  soulCid: string;
  previousCid: string | null;
  changeSummary: string | null;
  changeType: string;
  changedFields: string[];
  deploymentId: number | null;
  createdAt: string;
}

export interface PerformanceMetrics {
  metrics: {
    totalActions: number;
    successfulActions: number;
    failedActions: number;
    successRate: number;
    bountiesCompleted: number;
    postsCreated: number;
    avgAlignmentScore: number;
    creditsEarned: number;
    creditsSpent: number;
    periodDays: number;
  };
  trend: {
    direction: "improving" | "stable" | "declining";
    changePercent: number;
    currentRate: number;
    previousRate: number;
    windowDays: number;
  };
}

export interface KnowledgePerformanceItem {
  contentCid: string;
  bundleId: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  avgQuality: number;
  lastUsedAt: string | null;
}

export interface ImprovementCycleEntry {
  id: string;
  agentId: string;
  trigger: string;
  knowledgeItemsAnalyzed: number;
  proposalsGenerated: number;
  proposalsAutoApplied: number;
  proposalsQueued: number;
  creditsSpent: number;
  durationMs: number | null;
  performanceSnapshot: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
}

// ============================================================
//  Hooks
// ============================================================

/**
 * Get and update improvement settings for the authenticated agent.
 */
export function useImprovementSettings(apiKey: string | null) {
  const [settings, setSettings] = useState<ImprovementSettings | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<ImprovementSettings>("/v1/improvement/settings", apiKey);
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
    async (updates: Partial<ImprovementSettings>) => {
      if (!apiKey) return;
      try {
        const data = await gatewayFetch<ImprovementSettings>("/v1/improvement/settings", apiKey, {
          method: "PUT",
          body: JSON.stringify(updates),
        });
        setSettings(data);
      } catch {
        // silently fail
      }
    },
    [apiKey],
  );

  return { settings, isLoading, updateSettings, refresh };
}

/**
 * Get improvement proposals with optional status filter.
 */
export function useImprovementProposals(apiKey: string | null, status?: string) {
  const [proposals, setProposals] = useState<ImprovementProposal[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const data = await gatewayFetch<{ proposals: ImprovementProposal[] }>(
        `/v1/improvement/proposals?${params.toString()}`,
        apiKey,
      );
      setProposals(data.proposals);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, status]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const approve = useCallback(
    async (proposalId: string) => {
      if (!apiKey) return;
      try {
        await gatewayFetch(`/v1/improvement/proposals/${proposalId}/approve`, apiKey, {
          method: "POST",
        });
        await refresh();
      } catch {
        // silently fail
      }
    },
    [apiKey, refresh],
  );

  const reject = useCallback(
    async (proposalId: string) => {
      if (!apiKey) return;
      try {
        await gatewayFetch(`/v1/improvement/proposals/${proposalId}/reject`, apiKey, {
          method: "POST",
        });
        await refresh();
      } catch {
        // silently fail
      }
    },
    [apiKey, refresh],
  );

  return { proposals, isLoading, approve, reject, refresh };
}

/**
 * Get soul version history.
 */
export function useSoulHistory(apiKey: string | null, limit: number = 20) {
  const [versions, setVersions] = useState<SoulVersionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ versions: SoulVersionEntry[] }>(
        `/v1/improvement/soul-history?limit=${limit}`,
        apiKey,
      );
      setVersions(data.versions);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { versions, isLoading, refresh };
}

/**
 * Get agent performance metrics and trend.
 */
export function usePerformanceMetrics(apiKey: string | null) {
  const [data, setData] = useState<PerformanceMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const result = await gatewayFetch<PerformanceMetrics>("/v1/improvement/performance", apiKey);
      setData(result);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, isLoading, refresh };
}

/**
 * Get per-CID knowledge performance items.
 */
export function useKnowledgePerformance(apiKey: string | null, bundleId?: number) {
  const [items, setItems] = useState<KnowledgePerformanceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const params = bundleId !== undefined ? `?bundleId=${bundleId}` : "";
      const data = await gatewayFetch<{ items: KnowledgePerformanceItem[] }>(
        `/v1/improvement/performance/knowledge${params}`,
        apiKey,
      );
      setItems(data.items);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, bundleId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, isLoading, refresh };
}

/**
 * Get improvement cycle history and trigger manual cycles.
 */
export function useImprovementCycles(apiKey: string | null) {
  const [cycles, setCycles] = useState<ImprovementCycleEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ cycles: ImprovementCycleEntry[] }>(
        "/v1/improvement/cycles",
        apiKey,
      );
      setCycles(data.cycles);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const triggerCycle = useCallback(async () => {
    if (!apiKey) return null;
    try {
      const result = await gatewayFetch<Record<string, unknown>>("/v1/improvement/trigger", apiKey, {
        method: "POST",
      });
      await refresh();
      return result;
    } catch {
      return null;
    }
  }, [apiKey, refresh]);

  return { cycles, isLoading, triggerCycle, refresh };
}
