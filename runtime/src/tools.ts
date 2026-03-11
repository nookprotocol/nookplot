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
import { TOOL_MAP, type ToolContext } from "@nookplot/mcp/tools";
import { gatewayRequestWithRetry, isGatewayError } from "@nookplot/mcp/gateway";
import { prepareSignRelay } from "@nookplot/mcp/signing";

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

  // ============================================================
  //  Direct Tool Context (mirrors mcp-server/src/server.ts)
  // ============================================================

  /**
   * Build a ToolContext for direct MCP tool handler execution.
   * Same pattern as mcp-server's makeContext() — HTTP helpers + signing.
   */
  private makeToolContext(): ToolContext {
    const gatewayUrl = this.connection.gatewayUrl;
    const apiKey = this.connection.apiKey;
    const privateKey = this.connection.privateKey ?? "";
    const address = this.connection.address ?? "";

    const get = async (path: string) => {
      const result = await gatewayRequestWithRetry(gatewayUrl, "GET", path, { apiKey });
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    };
    const post = async (path: string, body: unknown, opts?: { timeoutMs?: number }) => {
      const result = await gatewayRequestWithRetry(gatewayUrl, "POST", path, { apiKey, body, timeoutMs: opts?.timeoutMs });
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    };
    const put = async (path: string, body: unknown) => {
      const result = await gatewayRequestWithRetry(gatewayUrl, "PUT", path, { apiKey, body });
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    };
    const patch = async (path: string, body: unknown) => {
      const result = await gatewayRequestWithRetry(gatewayUrl, "PATCH", path, { apiKey, body });
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    };
    const del = async (path: string) => {
      const result = await gatewayRequestWithRetry(gatewayUrl, "DELETE", path, { apiKey });
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    };
    const psr = async (preparePath: string, body: Record<string, unknown>) =>
      prepareSignRelay(gatewayUrl, apiKey, privateKey, preparePath, body);

    return {
      address, apiKey, gatewayUrl, get, post, put, patch, delete: del,
      prepareSignRelay: psr, privateKey,
      rpcUrl: process.env.NOOKPLOT_RPC_URL,
    };
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
   * Execute a Nookplot tool by calling its handler directly.
   *
   * Looks up the tool in the MCP TOOL_MAP and calls the handler with a
   * locally-built ToolContext (HTTP helpers + EIP-712 signing). This is the
   * same execution path as the standalone MCP server — no gateway middleman.
   *
   * Falls back to the gateway REST endpoint for non-MCP tools.
   *
   * @param name - Tool name (e.g. "nookplot_autoresearch_strategies" or "autoresearch_strategies").
   * @param args - Tool-specific arguments.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    // Normalize: ensure nookplot_ prefix for TOOL_MAP lookup
    const toolName = name.startsWith("nookplot_") ? name : `nookplot_${name}`;
    const tool = TOOL_MAP.get(toolName);

    if (!tool) {
      // Fallback: gateway REST path for non-MCP tools (execute_tool, http_request aliases, etc.)
      const result = await this.connection.request<{ data: unknown }>("POST", "/v1/mcp/tools/call", {
        name,
        arguments: args,
      });
      return {
        success: true,
        output: ((result as Record<string, unknown>).data ?? result) as Record<string, unknown>,
        creditsUsed: 0,
      };
    }

    // Direct execution: build context and call handler locally
    const ctx = this.makeToolContext();
    const result = await tool.handler(args, ctx);
    return {
      success: true,
      output: (result ?? {}) as Record<string, unknown>,
      creditsUsed: 0,
    };
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

  /**
   * Execute code in a sandboxed E2B container.
   * Supports Node.js, Python, and Deno runtimes.
   *
   * @param command - Shell command to run (e.g., "npm test", "python main.py").
   * @param image - Runtime image (e.g., "node:20-slim", "python:3.12-slim").
   * @param opts - Optional files, timeout, and project association.
   */
  async execCode(
    command: string,
    image: string,
    opts?: {
      files?: Record<string, string>;
      timeout?: number;
      projectId?: string;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    creditsCharged: number;
  }> {
    // Normalize files — handle case where files arrives as a JSON string
    // (some callers may serialize the object before passing it).
    let files: Record<string, string> | undefined = opts?.files;
    if (typeof files === "string") {
      try {
        files = JSON.parse(files as unknown as string);
      } catch {
        try {
          // Escape control characters that break JSON parsing
          // eslint-disable-next-line no-control-regex
          const normalized = (files as unknown as string).replace(
            /[\x00-\x1f\x7f]/g,
            (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
          );
          files = JSON.parse(normalized);
        } catch {
          throw new Error("Invalid files: must be a JSON object mapping filenames to content");
        }
      }
    }

    return this.connection.request("POST", "/v1/exec", {
      command,
      image,
      files,
      timeout: opts?.timeout,
      projectId: opts?.projectId,
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

  // ============================================================
  //  Webhook Management
  // ============================================================

  /**
   * Register a webhook source so external services can push events.
   *
   * @param source - Webhook source identifier (e.g., "github", "stripe").
   * @param config - Optional configuration (secret, signature header, event mapping).
   * @returns Registration details including the webhook URL.
   */
  async registerWebhook(
    source: string,
    config?: {
      secret?: string;
      signatureHeader?: string;
      timestampHeader?: string;
      maxAgeSeconds?: number;
      eventMapping?: Record<string, string>;
    },
  ): Promise<{ source: string; webhookUrl: string; [key: string]: unknown }> {
    const result = await this.connection.request<{
      data: { source: string; webhookUrl: string; [key: string]: unknown };
    }>("POST", "/v1/agents/me/webhooks", { source, config: config ?? {} });
    return result.data;
  }

  /**
   * List registered webhook sources.
   */
  async listWebhooks(): Promise<Array<{ source: string; webhookUrl: string; [key: string]: unknown }>> {
    const result = await this.connection.request<{
      data: Array<{ source: string; webhookUrl: string; [key: string]: unknown }>;
    }>("GET", "/v1/agents/me/webhooks");
    return result.data;
  }

  /**
   * Remove a webhook registration.
   *
   * @param source - Webhook source identifier to remove.
   */
  async removeWebhook(source: string): Promise<void> {
    await this.connection.request("DELETE", `/v1/agents/me/webhooks/${encodeURIComponent(source)}`);
  }

  /**
   * Get webhook event log (recent deliveries).
   *
   * @param page - Page number (0-indexed).
   */
  async getWebhookLog(page?: number): Promise<Array<Record<string, unknown>>> {
    const qs = page !== undefined ? `?page=${page}` : "";
    const result = await this.connection.request<{
      data: Array<Record<string, unknown>>;
    }>("GET", `/v1/agents/me/webhooks/log${qs}`);
    return result.data;
  }

  // ============================================================
  //  Egress Allowlist Management
  // ============================================================

  /**
   * Get the egress allowlist (domains this agent is allowed to call).
   */
  async getEgressAllowlist(): Promise<Array<{ id: number; domain: string; max_requests_per_hour: number; created_at: string }>> {
    const result = await this.connection.request<{
      allowlist: Array<{ id: number; domain: string; max_requests_per_hour: number; created_at: string }>;
    }>("GET", "/v1/agents/me/egress");
    return result.allowlist;
  }

  /**
   * Add or update a domain on the egress allowlist.
   *
   * @param domain - Domain to allow (e.g., "api.github.com").
   * @param maxRequestsPerHour - Optional rate limit.
   */
  async addEgressDomain(
    domain: string,
    maxRequestsPerHour?: number,
  ): Promise<Record<string, unknown>> {
    return this.connection.request("PUT", "/v1/agents/me/egress", {
      domain,
      maxRequestsPerHour,
    });
  }

  /**
   * Remove a domain from the egress allowlist.
   *
   * @param domain - Domain to remove.
   */
  async removeEgressDomain(domain: string): Promise<void> {
    await this.connection.request("PUT", "/v1/agents/me/egress", {
      domain,
      remove: true,
    });
  }

  // ============================================================
  //  Credential Management
  // ============================================================

  /**
   * Store an encrypted API credential for use with egress requests.
   *
   * @param service - Service name (e.g., "openai", "github").
   * @param apiKey - The API key/credential to store.
   */
  async storeCredential(service: string, apiKey: string): Promise<void> {
    await this.connection.request("POST", "/v1/agents/me/credentials", {
      service,
      apiKey,
    });
  }

  /**
   * List stored credential services (names only — keys are never exposed).
   */
  async listCredentials(): Promise<Array<{ service: string; createdAt: string }>> {
    const result = await this.connection.request<{
      credentials: Array<{ service: string; createdAt: string }>;
    }>("GET", "/v1/agents/me/credentials");
    return result.credentials;
  }

  /**
   * Remove a stored credential.
   *
   * @param service - Service name to remove.
   */
  async removeCredential(service: string): Promise<void> {
    await this.connection.request("DELETE", `/v1/agents/me/credentials/${encodeURIComponent(service)}`);
  }
}
