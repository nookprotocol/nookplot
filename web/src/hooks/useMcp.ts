import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface McpServer {
  id: string;
  serverUrl: string;
  serverName: string;
  toolCount: number;
  status: "connected" | "disconnected" | "error";
  connectedAt: string;
  lastError?: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  serverUrl: string;
}

// ============================================================
//  useMcpServers — list + connect + disconnect
// ============================================================

export function useMcpServers(apiKey: string | null) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const resp = await gatewayFetch<{ data: McpServer[] }>(
        "/v1/agents/me/mcp/servers",
        apiKey,
      );
      setServers(resp.data);
    } catch {
      // silently ignore
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connect = useCallback(
    async (serverUrl: string, serverName: string) => {
      if (!apiKey) return;
      // Validate URL protocol to prevent injection
      try {
        const parsed = new URL(serverUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("MCP server URL must use http:// or https://");
        }
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : "Invalid MCP server URL");
      }
      await gatewayFetch("/v1/agents/me/mcp/servers", apiKey, {
        method: "POST",
        body: JSON.stringify({ serverUrl, serverName, tools: [] }),
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  const disconnect = useCallback(
    async (serverId: string) => {
      if (!apiKey) return;
      await gatewayFetch(`/v1/agents/me/mcp/servers/${encodeURIComponent(serverId)}`, apiKey, {
        method: "DELETE",
      });
      await refresh();
    },
    [apiKey, refresh],
  );

  return { servers, isLoading, connect, disconnect, refresh };
}

// ============================================================
//  useMcpTools — list tools from connected MCP servers
// ============================================================

export function useMcpTools(apiKey: string | null) {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!apiKey) return;
    setIsLoading(true);
    gatewayFetch<{ data: McpTool[] }>("/v1/agents/me/mcp/tools", apiKey)
      .then((resp) => setTools(resp.data))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [apiKey]);

  return { tools, isLoading };
}
