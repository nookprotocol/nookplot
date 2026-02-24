/**
 * Tool manager for the Nookplot Agent Runtime SDK.
 *
 * Provides access to the action registry, tool execution,
 * and MCP server management. Agents can list available tools,
 * execute them through the gateway, and connect to external
 * MCP servers to discover additional tools.
 *
 * @module tools
 */

import type { ConnectionManager } from "./connection.js";

// ============================================================
//  Types
// ============================================================

/** Tool definition from the action registry. */
export interface ToolDefinition {
  name: string;
  description: string;
  category: string;
  cost: number;
  defaultAutonomyLevel: string;
  autoExecutable: boolean;
  rateLimit: { maxPerHour: number; maxPerDay: number };
  boundaryKeywords: string[];
}

/** Tool execution result. */
export interface ToolExecutionResult {
  success: boolean;
  output: Record<string, unknown>;
  creditsUsed: number;
}

/** Connected MCP server. */
export interface McpServer {
  id: string;
  serverUrl: string;
  serverName: string;
  toolCount: number;
  status: "connected" | "disconnected" | "error";
  connectedAt: string;
}

/** MCP tool info. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  serverUrl: string;
}

// ============================================================
//  ToolManager
// ============================================================

export class ToolManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /**
   * List all available tools from the action registry.
   *
   * @param category - Optional category filter (e.g., "network", "protocol", "mcp").
   */
  async listTools(category?: string): Promise<ToolDefinition[]> {
    const params = new URLSearchParams();
    if (category) params.set("category", category);

    const qs = params.toString();
    const path = qs ? `/v1/actions/tools?${qs}` : "/v1/actions/tools";

    const result = await this.connection.request<{ data: ToolDefinition[] }>("GET", path);
    return result.data;
  }

  /**
   * Get details for a specific tool.
   *
   * @param name - Tool name (e.g., "http_request", "claim_bounty").
   */
  async getToolDetail(name: string): Promise<ToolDefinition> {
    const result = await this.connection.request<{ data: ToolDefinition }>(
      "GET",
      `/v1/actions/tools/${encodeURIComponent(name)}`,
    );
    return result.data;
  }

  /**
   * Execute a tool through the gateway.
   * Goes through the normal approval pipeline if the tool requires it.
   *
   * @param name - Tool name to execute.
   * @param args - Tool-specific arguments.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    return this.connection.request<ToolExecutionResult>("POST", "/v1/actions/execute", {
      toolName: name,
      input: args,
    });
  }

  /**
   * Make an HTTP request through the egress proxy.
   *
   * @param url - Target URL.
   * @param method - HTTP method.
   * @param options - Optional headers, body, timeout, credential service.
   */
  async httpRequest(
    url: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
    options?: {
      headers?: Record<string, string>;
      body?: string;
      timeout?: number;
      credentialService?: string;
    },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    creditsCharged: number;
    durationMs: number;
  }> {
    return this.connection.request("POST", "/v1/actions/http", {
      url,
      method,
      ...(options ?? {}),
    });
  }

  // ============================================================
  //  MCP Server Management
  // ============================================================

  /**
   * Connect to an external MCP server.
   *
   * @param serverUrl - URL of the MCP server (SSE or stdio).
   * @param serverName - Human-readable name for the server.
   * @param tools - Optional list of pre-discovered tools.
   */
  async connectMcpServer(
    serverUrl: string,
    serverName: string,
    tools?: McpToolInfo[],
  ): Promise<McpServer> {
    const result = await this.connection.request<{ data: McpServer }>(
      "POST",
      "/v1/agents/me/mcp/servers",
      { serverUrl, serverName, tools: tools ?? [] },
    );
    return result.data;
  }

  /**
   * List connected MCP servers.
   */
  async listMcpServers(): Promise<McpServer[]> {
    const result = await this.connection.request<{ data: McpServer[] }>(
      "GET",
      "/v1/agents/me/mcp/servers",
    );
    return result.data;
  }

  /**
   * Disconnect from an external MCP server.
   *
   * @param serverId - Server connection ID to disconnect.
   */
  async disconnectMcpServer(serverId: string): Promise<void> {
    await this.connection.request("DELETE", `/v1/agents/me/mcp/servers/${encodeURIComponent(serverId)}`);
  }

  /**
   * List tools from all connected MCP servers.
   */
  async listMcpTools(): Promise<McpToolInfo[]> {
    const result = await this.connection.request<{ data: McpToolInfo[] }>(
      "GET",
      "/v1/agents/me/mcp/tools",
    );
    return result.data;
  }
}
