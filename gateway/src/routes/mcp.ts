/**
 * MCP routes — Model Context Protocol transport + management endpoints.
 *
 * GET    /v1/mcp/sse         — MCP SSE transport for external agents
 * POST   /v1/mcp/sse         — MCP SSE message handler
 * POST   /v1/agents/me/mcp/servers — Connect to an external MCP server
 * GET    /v1/agents/me/mcp/servers — List connected MCP servers
 * DELETE /v1/agents/me/mcp/servers/:id — Disconnect from MCP server
 * GET    /v1/agents/me/mcp/tools   — List tools from connected MCP servers
 *
 * @module routes/mcp
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpBridge } from "../services/mcpBridge.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import dns from "dns/promises";
import { isIP } from "net";
import { isPrivateIp, BLOCKED_HOSTNAMES } from "../networkGuard.js";

/** Validate a URL is not pointing to private/internal infrastructure. */
async function validateExternalUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    return { valid: false, error: "URL points to internal infrastructure" };
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { valid: false, error: "URL points to a private/reserved IP address" };
    }
    return { valid: true };
  }

  // Resolve DNS and check all resolved IPs
  const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
  const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
  const allAddresses = [...addresses, ...addresses6];

  if (allAddresses.length === 0) {
    return { valid: false, error: `DNS resolution failed for "${hostname}"` };
  }

  for (const addr of allAddresses) {
    if (isPrivateIp(addr)) {
      return { valid: false, error: "URL resolves to a private/reserved IP address" };
    }
  }

  return { valid: true };
}

export function createMcpRouter(
  pool: pg.Pool,
  hmacSecret: string,
  mcpBridge: McpBridge,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // ============================================================
  //  MCP SSE Transport (expose Nookplot as MCP tool server)
  // ============================================================

  /** Active SSE transports keyed by session ID. */
  const transports = new Map<string, SSEServerTransport>();

  /** Map session ID → agent ID for ownership verification. */
  const sessionOwners = new Map<string, string>();

  /**
   * Create and configure a low-level MCP Server with Nookplot tools.
   * Uses the low-level Server API to register tools with raw JSON schemas.
   */
  function createNookplotMcpServer(agentApiKey: string, agentId: string): Server {
    const server = new Server(
      {
        name: "nookplot",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    const nookplotTools = mcpBridge.getNookplotTools();

    // Handle tools/list
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: nookplotTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    });

    // Handle tools/call — charges credits before execution
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await mcpBridge.handleToolCall(
        name,
        (args ?? {}) as Record<string, unknown>,
        agentApiKey,
        agentId,
      );
      return result;
    });

    return server;
  }

  /**
   * GET /v1/mcp/sse — SSE endpoint for MCP clients.
   * Requires Bearer authentication.
   */
  router.get(
    "/mcp/sse",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentApiKey = (req.headers.authorization ?? "").replace("Bearer ", "");

        logSecurityEvent("info", "mcp-sse-connect", {
          agentId: req.agent?.id,
        });

        const transport = new SSEServerTransport("/v1/mcp/sse", res);
        transports.set(transport.sessionId, transport);
        sessionOwners.set(transport.sessionId, req.agent!.id);

        const server = createNookplotMcpServer(agentApiKey, req.agent!.id);
        await server.connect(transport);

        // Clean up on disconnect
        transport.onclose = () => {
          transports.delete(transport.sessionId);
          sessionOwners.delete(transport.sessionId);
          server.close().catch(() => {});
        };

        await transport.start();
      } catch (error) {
        logSecurityEvent("warn", "mcp-sse-error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "MCP SSE connection failed" });
        }
      }
    },
  );

  /**
   * POST /v1/mcp/sse — Handle incoming MCP messages from SSE clients.
   * Requires Bearer authentication and session ownership verification.
   */
  router.post(
    "/mcp/sse",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sessionId = String(req.query.sessionId ?? "");
        const transport = transports.get(sessionId);

        if (!transport) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // Verify the caller owns this session
        const ownerId = sessionOwners.get(sessionId);
        if (ownerId !== req.agent?.id) {
          logSecurityEvent("warn", "mcp-sse-session-hijack-attempt", {
            sessionId,
            requestAgentId: req.agent?.id,
            ownerAgentId: ownerId,
          });
          res.status(403).json({ error: "Session not owned by this agent" });
          return;
        }

        await transport.handlePostMessage(req, res);
      } catch (error) {
        logSecurityEvent("warn", "mcp-sse-message-error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "MCP message handling failed" });
        }
      }
    },
  );

  // ============================================================
  //  MCP Client Management (Nookplot agents connecting to external servers)
  // ============================================================

  /**
   * POST /v1/agents/me/mcp/servers — Connect to an external MCP server.
   */
  router.post(
    "/agents/me/mcp/servers",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const { serverUrl, serverName, tools } = req.body;

        if (!serverUrl || typeof serverUrl !== "string") {
          res.status(400).json({ error: "serverUrl is required (string)" });
          return;
        }
        // Validate URL format (must be http:// or https://)
        try {
          const parsed = new URL(serverUrl);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            res.status(400).json({ error: "serverUrl must be an http:// or https:// URL" });
            return;
          }
        } catch {
          res.status(400).json({ error: "serverUrl is not a valid URL" });
          return;
        }

        // SSRF protection: block private IPs and internal hostnames
        try {
          const ssrfCheck = await validateExternalUrl(serverUrl);
          if (!ssrfCheck.valid) {
            logSecurityEvent("warn", "mcp-ssrf-blocked", {
              agentId,
              serverUrl: serverUrl.slice(0, 200),
              reason: ssrfCheck.error,
            });
            res.status(400).json({ error: "serverUrl is not allowed: " + ssrfCheck.error });
            return;
          }
        } catch {
          res.status(400).json({ error: "Failed to validate serverUrl" });
          return;
        }

        if (!serverName || typeof serverName !== "string") {
          res.status(400).json({ error: "serverName is required (string)" });
          return;
        }
        // Validate serverName format (alphanumeric + hyphens/underscores, max 64 chars)
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serverName)) {
          res.status(400).json({ error: "serverName must be alphanumeric with hyphens/underscores (max 64 chars)" });
          return;
        }

        const connection = await mcpBridge.connectServer(
          agentId,
          serverUrl,
          serverName,
          tools ?? [],
        );

        res.status(201).json({ data: connection });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "Failed to connect to MCP server",
        });
      }
    },
  );

  /**
   * GET /v1/agents/me/mcp/servers — List connected MCP servers.
   */
  router.get(
    "/agents/me/mcp/servers",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const servers = await mcpBridge.listServers(agentId);
        res.json({ data: servers });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to list MCP servers",
        });
      }
    },
  );

  /**
   * DELETE /v1/agents/me/mcp/servers/:id — Disconnect from an MCP server.
   */
  router.delete(
    "/agents/me/mcp/servers/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const serverId = String(req.params.id);

        const removed = await mcpBridge.disconnectServer(agentId, serverId);
        if (!removed) {
          res.status(404).json({ error: "MCP server connection not found" });
          return;
        }

        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to disconnect MCP server",
        });
      }
    },
  );

  /**
   * GET /v1/agents/me/mcp/tools — List tools from connected MCP servers.
   */
  router.get(
    "/agents/me/mcp/tools",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const tools = await mcpBridge.listMcpTools(agentId);
        res.json({ data: tools });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to list MCP tools",
        });
      }
    },
  );

  return router;
}
