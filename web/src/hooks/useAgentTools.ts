import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  cost: number;
  defaultAutonomyLevel: string;
  autoExecutable: boolean;
  rateLimit: { maxPerHour: number; maxPerDay: number };
  boundaryKeywords: string[];
}

export interface ToolConfig {
  id: string;
  agent_id: string;
  tool_name: string;
  enabled: boolean;
  cost_override: number | null;
  autonomy_override: string | null;
  rate_limit_override: Record<string, unknown> | null;
  created_at: string;
}

export interface ExecutionLogEntry {
  id: string;
  agentId: string;
  toolName: string;
  status: string;
  creditsCharged: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ============================================================
//  Hooks
// ============================================================

/**
 * Fetch the list of available tools from the action registry.
 */
export function useToolList(apiKey: string | null, category?: string) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const params = category ? `?category=${encodeURIComponent(category)}` : "";
      const data = await gatewayFetch<{ tools: ToolInfo[]; total: number }>(
        `/v1/actions/tools${params}`,
        apiKey,
      );
      setTools(data.tools);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, category]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tools, isLoading, refresh };
}

/**
 * Fetch a single tool's detail + per-agent config.
 */
export function useToolDetail(apiKey: string | null, toolName: string | null) {
  const [tool, setTool] = useState<ToolInfo | null>(null);
  const [config, setConfig] = useState<ToolConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey || !toolName) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ tool: ToolInfo; agentConfig: ToolConfig | null }>(
        `/v1/actions/tools/${encodeURIComponent(toolName)}`,
        apiKey,
      );
      setTool(data.tool);
      setConfig(data.agentConfig);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, toolName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tool, config, isLoading, refresh };
}

/**
 * Update per-agent tool configuration.
 */
export function useUpdateToolConfig(apiKey: string | null) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateConfig = useCallback(
    async (toolName: string, config: {
      enabled?: boolean;
      costOverride?: number;
      autonomyOverride?: string;
      rateLimitOverride?: Record<string, unknown>;
    }) => {
      if (!apiKey) return null;
      setIsUpdating(true);
      setError(null);
      try {
        const data = await gatewayFetch<{ config: ToolConfig }>(
          `/v1/actions/tools/${encodeURIComponent(toolName)}/config`,
          apiKey,
          { method: "PUT", body: JSON.stringify(config) },
        );
        return data.config;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return null;
      } finally {
        setIsUpdating(false);
      }
    },
    [apiKey],
  );

  return { updateConfig, isUpdating, error };
}

/**
 * Execute a tool directly.
 */
export function useExecuteTool(apiKey: string | null) {
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(
    async (toolName: string, payload: Record<string, unknown> = {}) => {
      if (!apiKey) return null;
      setIsExecuting(true);
      setError(null);
      try {
        const data = await gatewayFetch<{
          status: string;
          result?: { success: boolean; output: Record<string, unknown>; creditsUsed: number; error?: string };
          actionId?: string;
          message?: string;
        }>("/v1/actions/execute", apiKey, {
          method: "POST",
          body: JSON.stringify({ toolName, payload }),
        });
        return data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return null;
      } finally {
        setIsExecuting(false);
      }
    },
    [apiKey],
  );

  return { execute, isExecuting, error };
}

/**
 * Fetch execution log entries.
 */
export function useExecutionLog(apiKey: string | null, page = 0) {
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ entries: ExecutionLogEntry[] }>(
        `/v1/actions/log?limit=20&offset=${page * 20}`,
        apiKey,
      );
      setEntries(data.entries);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, page]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { entries, isLoading, refresh };
}
