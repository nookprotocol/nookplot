/**
 * Unified tool dispatcher — imports MCP tool handlers and routes their
 * HTTP calls internally to the gateway's own Express routes.
 *
 * Replaces the 204-entry `registerBuiltInTools()` registration that used
 * `delegatedHandler` (WebSocket pass-through) with real dispatch logic:
 *
 *   MCP tool handler calls ctx.post("/v1/inbox/send", body)
 *     → GatewayToolContext.post() calls http://localhost:PORT/v1/inbox/send
 *     → gateway processes normally (auth, validation, DB, etc.)
 *     → returns result to the tool handler
 *
 * For on-chain tools, ctx.prepareSignRelay() calls the gateway prepare
 * endpoint and returns a { status: "sign_required" } result, since the
 * gateway is non-custodial and can't sign on behalf of agents.
 *
 * @module services/toolDispatcher
 */

import type { ToolContext, ToolDef } from "@nookplot/mcp/tools";
import type { GatewayResponse, GatewayError } from "@nookplot/mcp/gateway";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Result types
// ============================================================

export type DispatchResult =
  | { status: "completed"; result: unknown }
  | { status: "sign_required"; forwardRequest: unknown; domain?: unknown; types?: unknown; preparePath?: string }
  | { status: "client_side_required"; action: string; params: Record<string, unknown> }
  | { status: "error"; error: string };

// ============================================================
//  Tools that cannot be dispatched server-side
// ============================================================

/**
 * Tools that require the agent's private key or local filesystem access.
 * These return { status: "client_side_required" } immediately.
 */
const CLIENT_SIDE_ONLY = new Set([
  "nookplot_approve_token",    // needs agent's private key for ERC-20 approve tx
  "nookplot_install_skill",    // writes to agent's local filesystem
]);

// ============================================================
//  Sentinel for prepare→sign→relay results
// ============================================================

const SIGN_REQUIRED_SENTINEL = "__nookplot_sign_required__";

interface SignRequiredResult {
  [SIGN_REQUIRED_SENTINEL]: true;
  forwardRequest: unknown;
  domain?: unknown;
  types?: unknown;
  preparePath: string;
}

function isSignRequired(val: unknown): val is SignRequiredResult {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as Record<string, unknown>)[SIGN_REQUIRED_SENTINEL] === true
  );
}

// ============================================================
//  GatewayToolContext — routes HTTP calls to localhost
// ============================================================

/**
 * Creates a ToolContext that routes all HTTP calls to the gateway's own
 * Express server at localhost:PORT. This reuses all existing middleware
 * (auth, rate limiting, validation) without needing to inject every
 * service or duplicate validation logic.
 */
function createGatewayToolContext(
  agentAddress: string,
  agentApiKey: string,
  gatewayBaseUrl: string,
): ToolContext {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${agentApiKey}`,
  };

  async function request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const url = `${gatewayBaseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle 204 No Content
      if (response.status === 204) return {};

      const text = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const errMsg = typeof data === "object" && data !== null && "error" in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
        throw new Error(errMsg);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out: ${method} ${path}`);
      }
      throw error;
    }
  }

  const ctx: ToolContext = {
    address: agentAddress,
    apiKey: agentApiKey,
    gatewayUrl: gatewayBaseUrl,

    // No private key server-side — the gateway is non-custodial.
    // Tools that need this (approve_token) are caught by CLIENT_SIDE_ONLY set.
    privateKey: undefined,

    // RPC URL for direct on-chain reads (view functions only)
    rpcUrl: process.env.RPC_URL ?? "https://mainnet.base.org",

    get: (path: string) => request("GET", path),
    post: (path: string, body: unknown, opts?: { timeoutMs?: number }) =>
      request("POST", path, body, opts),
    put: (path: string, body: unknown) => request("PUT", path, body),
    patch: (path: string, body: unknown) => request("PATCH", path, body),
    delete: (path: string) => request("DELETE", path),

    /**
     * For on-chain actions: call the prepare endpoint and wrap the result
     * with a sentinel so the dispatcher knows to return sign_required.
     */
    prepareSignRelay: async (
      preparePath: string,
      body: Record<string, unknown>,
    ): Promise<GatewayResponse | GatewayError> => {
      try {
        const data = await request("POST", preparePath, body);

        // Wrap the prepare result with our sentinel so dispatch() can detect it
        const sentinel: SignRequiredResult = {
          [SIGN_REQUIRED_SENTINEL]: true,
          forwardRequest: (data as Record<string, unknown>)?.forwardRequest ?? data,
          domain: (data as Record<string, unknown>)?.domain,
          types: (data as Record<string, unknown>)?.types,
          preparePath,
        };

        // Return as GatewayResponse but with sentinel data
        return { ok: true, status: 200, data: sentinel } as GatewayResponse;
      } catch (error) {
        return {
          ok: false,
          status: 500,
          error: error instanceof Error ? error.message : String(error),
        } as GatewayError;
      }
    },
  };

  return ctx;
}

// ============================================================
//  ToolDispatcher
// ============================================================

export class ToolDispatcher {
  private readonly toolMap: Map<string, ToolDef>;
  private readonly port: number;

  /**
   * @param toolMap  — Map of tool name → ToolDef (from @nookplot/mcp/tools)
   * @param port     — Gateway port for internal HTTP calls
   */
  constructor(toolMap: Map<string, ToolDef>, port: number) {
    this.toolMap = toolMap;
    this.port = port;
  }

  /** Number of tools available for dispatch. */
  get size(): number {
    return this.toolMap.size;
  }

  /** Check if a tool exists. */
  has(name: string): boolean {
    return this.toolMap.has(name);
  }

  /** Get tool definition (for schema/description). */
  getTool(name: string): ToolDef | undefined {
    return this.toolMap.get(name);
  }

  /** List all tool names. */
  getToolNames(): string[] {
    return Array.from(this.toolMap.keys());
  }

  /**
   * List all tools as serializable objects (without handlers).
   * Optionally filtered by category.
   */
  listTools(category?: string): Array<{
    name: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
  }> {
    const tools = Array.from(this.toolMap.values());
    const filtered = category
      ? tools.filter((t) => t.category === category)
      : tools;

    return filtered.map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Dispatch a tool call. Routes the MCP tool handler's HTTP calls
   * to the gateway's own Express routes internally.
   *
   * @param toolName     — MCP tool name (e.g. "nookplot_send_message")
   * @param payload      — Tool arguments
   * @param agentAddress — Agent's Ethereum address
   * @param agentApiKey  — Agent's API key (for internal auth)
   */
  async dispatch(
    toolName: string,
    payload: Record<string, unknown>,
    agentAddress: string,
    agentApiKey: string,
  ): Promise<DispatchResult> {
    // 1. Client-side-only tools
    if (CLIENT_SIDE_ONLY.has(toolName)) {
      return {
        status: "client_side_required",
        action: toolName,
        params: payload,
      };
    }

    // 2. Look up tool
    const tool = this.toolMap.get(toolName);
    if (!tool) {
      return { status: "error", error: `Unknown tool: ${toolName}` };
    }

    // 3. Build context for internal routing
    const gatewayBaseUrl = `http://localhost:${this.port}`;
    const ctx = createGatewayToolContext(agentAddress, agentApiKey, gatewayBaseUrl);

    // 4. Execute the MCP tool handler
    try {
      const result = await tool.handler(payload, ctx);

      // 5. Check if the result is a prepare→sign→relay sentinel
      if (isSignRequired(result)) {
        return {
          status: "sign_required",
          forwardRequest: result.forwardRequest,
          domain: result.domain,
          types: result.types,
          preparePath: result.preparePath,
        };
      }

      // Check if the handler returned a GatewayResponse wrapping a sentinel
      if (
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        (result as GatewayResponse).ok === true
      ) {
        const inner = (result as GatewayResponse).data;
        if (isSignRequired(inner)) {
          return {
            status: "sign_required",
            forwardRequest: inner.forwardRequest,
            domain: inner.domain,
            types: inner.types,
            preparePath: inner.preparePath,
          };
        }
        // Unwrap GatewayResponse for cleaner output
        return { status: "completed", result: inner };
      }

      // Check if it's a GatewayError
      if (
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        (result as GatewayError).ok === false
      ) {
        return {
          status: "error",
          error: (result as GatewayError).error ?? "Tool handler returned error",
        };
      }

      // 6. Regular completed result
      return { status: "completed", result };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logSecurityEvent("warn", "tool-dispatch-error", {
        toolName,
        agentAddress,
        error: errorMsg,
      });
      return { status: "error", error: errorMsg };
    }
  }
}
