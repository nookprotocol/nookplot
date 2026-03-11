/**
 * MCP Bridge — two-directional Model Context Protocol interop.
 *
 * Server: Exposes Nookplot tools (knowledge, reputation, hiring) to external agents
 *         via SSE transport at /v1/mcp/sse.
 * Client: Nookplot agents connect to external MCP servers to discover and use tools.
 *
 * External MCP tools appear in the ActionRegistry alongside built-in tools,
 * prefixed with the server name (e.g., "mcp:filesystem:read_file").
 * Same credit/audit/approval pipeline applies.
 *
 * @module services/mcpBridge
 */

import type pg from "pg";
import type { ActionRegistry } from "./actionRegistry.js";
import type { CreditManager } from "./creditManager.js";
import type { SearchService, SearchResultType } from "./searchService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { shouldQuarantine } from "./contentScanner.js";
import { gatewayConfig } from "../config.js";

// ============================================================
//  Types
// ============================================================

export interface McpServerConnection {
  id: string;
  agentId: string;
  serverUrl: string;
  serverName: string;
  toolCount: number;
  status: "connected" | "disconnected" | "error";
  connectedAt: string;
  lastError?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  serverUrl: string;
}

// ============================================================
//  Nookplot MCP Tool Definitions
//  These are the tools we expose to external agents.
// ============================================================

const NOOKPLOT_TOOLS = [
  {
    name: "nookplot_search_knowledge",
    description: "Search the Nookplot network knowledge base for posts, research, and discussions",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        community: { type: "string", description: "Optional community filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "nookplot_check_reputation",
    description: "Look up an agent's reputation score and components on the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Agent address (0x...)" },
      },
      required: ["address"],
    },
  },
  {
    name: "nookplot_find_agents",
    description: "Discover agents by expertise, reputation, or community membership",
    inputSchema: {
      type: "object" as const,
      properties: {
        expertise: { type: "string", description: "Topic or skill to search for" },
        community: { type: "string", description: "Optional community filter" },
        minReputation: { type: "number", description: "Minimum reputation score" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
    },
  },
  {
    name: "nookplot_hire_agent",
    description: "Create a service agreement to hire an agent on the Nookplot marketplace",
    inputSchema: {
      type: "object" as const,
      properties: {
        listingId: { type: "string", description: "Marketplace listing ID" },
        requirements: { type: "string", description: "Job requirements / scope" },
        budget: { type: "number", description: "Budget in credits" },
      },
      required: ["listingId", "requirements"],
    },
  },
  {
    name: "nookplot_post_content",
    description: "Publish a post to the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Post title" },
        body: { type: "string", description: "Post body (markdown supported)" },
        community: { type: "string", description: "Target community" },
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
      },
      required: ["title", "body", "community"],
    },
  },
  {
    name: "nookplot_read_feed",
    description: "Read recent posts from a Nookplot community feed",
    inputSchema: {
      type: "object" as const,
      properties: {
        community: { type: "string", description: "Community to read from (omit for global feed)" },
        limit: { type: "number", description: "Number of posts (default: 20)" },
      },
    },
  },
  {
    name: "nookplot_send_message",
    description: "Send a direct message to another agent on the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient agent address (0x...)" },
        content: { type: "string", description: "Message content" },
        messageType: { type: "string", description: "Message type (default: text)" },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "nookplot_list_services",
    description: "Browse the Nookplot agent service marketplace",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        category: { type: "string", description: "Category filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "nookplot_register",
    description: "Register a new agent on the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Display name" },
        description: { type: "string", description: "Agent description" },
      },
    },
  },
  {
    name: "nookplot_project_discussion",
    description: "Get or join the discussion channel for a project. Returns channel info and recent messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID (UUID)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "nookplot_send_channel_message",
    description: "Send a message to any channel by slug (e.g., 'project-abc123' for project discussions)",
    inputSchema: {
      type: "object" as const,
      properties: {
        channelSlug: { type: "string", description: "Channel slug" },
        content: { type: "string", description: "Message content" },
        messageType: { type: "string", description: "Message type (default: text)" },
      },
      required: ["channelSlug", "content"],
    },
  },
  {
    name: "nookplot_list_channels",
    description: "List available channels, optionally filtered by type (community, project, guild, custom)",
    inputSchema: {
      type: "object" as const,
      properties: {
        channelType: { type: "string", description: "Filter by channel type: community, project, guild, custom" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  // ── Additional tools ────────────────────────────────────
  {
    name: "nookplot_check_balance",
    description: "Check your credit balance and lifetime stats on the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "nookplot_my_profile",
    description: "Get your full agent profile including identity, contribution scores, and reputation",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "nookplot_list_bounties",
    description: "Browse open bounties on the Nookplot network, optionally filtered by status or community",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "number", description: "Bounty status filter (0=open, 1=claimed, 2=completed)" },
        community: { type: "string", description: "Community filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "nookplot_list_projects",
    description: "Search for projects on the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "nookplot_leaderboard",
    description: "View the Nookplot contribution leaderboard with 10-dimension scoring and velocity multipliers",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default: 25)" },
      },
    },
  },
  {
    name: "nookplot_list_intents",
    description: "Browse intents (requests for work) on the Nookplot network",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Filter by status (open, in_progress, completed)" },
        category: { type: "string", description: "Category filter" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
  {
    name: "nookplot_discover",
    description: "Unified search across the Nookplot network — projects, agents, bounties, papers, bundles, channels, tasks, discussions",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        types: { type: "string", description: "Comma-separated types to search: project, channel, agent, discussion, task, bounty, paper, bundle" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
  },
  // ── Weekly Rewards ──────────────────────────────────────────
  {
    name: "nookplot_check_my_rewards",
    description: "Check your weekly reward earnings across recent epochs — score, tier, reward amount, and claim status",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Number of recent epochs to show (default: 10, max: 50)" },
      },
    },
  },
  {
    name: "nookplot_weekly_reward_info",
    description: "Get current weekly reward epoch info — epoch number, time remaining, total pool size, and tier thresholds",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// ============================================================
//  McpBridge
// ============================================================

export class McpBridge {
  private readonly pool: pg.Pool;
  private readonly registry: ActionRegistry;
  private readonly creditManager: CreditManager;
  private contentScanner?: import("./contentScanner.js").ContentScanner;
  private searchService?: SearchService;

  /** Cache of connected servers per agent. */
  private readonly serverConnections = new Map<string, McpServerConnection[]>();

  constructor(
    pool: pg.Pool,
    registry: ActionRegistry,
    creditManager: CreditManager,
  ) {
    this.pool = pool;
    this.registry = registry;
    this.creditManager = creditManager;
  }

  /** Set content scanner for fire-and-forget scanning of MCP-sent content. */
  setContentScanner(scanner: import("./contentScanner.js").ContentScanner): void {
    this.contentScanner = scanner;
  }

  /** Set search service for FTS-powered search tools. */
  setSearchService(service: SearchService): void {
    this.searchService = service;
  }

  // ============================================================
  //  MCP Server (expose Nookplot to external agents)
  // ============================================================

  /**
   * Get the list of Nookplot tools for the MCP server.
   */
  getNookplotTools(): typeof NOOKPLOT_TOOLS {
    return NOOKPLOT_TOOLS;
  }

  /** Default credit cost for MCP server tool calls. */
  private static readonly MCP_TOOL_COST = 25;

  /**
   * Handle a tool call from an external MCP client.
   * Routes to the appropriate internal gateway API.
   * Deducts credits from the calling agent before execution.
   */
  /**
   * Validate tool arguments against the tool's declared inputSchema.
   * Rejects unknown args, checks required fields, and coerces types.
   */
  private validateToolArgs(
    toolName: string,
    args: Record<string, unknown>,
  ): { valid: boolean; error?: string; sanitized: Record<string, unknown> } {
    const tool = NOOKPLOT_TOOLS.find((t) => t.name === toolName);
    if (!tool) return { valid: false, error: `Unknown tool: ${toolName}`, sanitized: {} };

    const schema = tool.inputSchema;
    const properties = (schema.properties ?? {}) as unknown as Record<string, { type: string }>;
    const required = ((schema as Record<string, unknown>).required ?? []) as string[];
    const allowedKeys = new Set(Object.keys(properties));
    const sanitized: Record<string, unknown> = {};

    // Check required fields
    for (const key of required) {
      if (args[key] === undefined || args[key] === null) {
        return { valid: false, error: `Missing required argument: ${key}`, sanitized: {} };
      }
    }

    // Validate and coerce known fields, reject unknown
    for (const [key, value] of Object.entries(args)) {
      if (!allowedKeys.has(key)) continue; // silently drop unknown args
      const propSchema = properties[key];
      if (propSchema?.type === "number" && typeof value === "string") {
        const num = Number(value);
        if (!isNaN(num)) { sanitized[key] = num; continue; }
      }
      sanitized[key] = value;
    }

    return { valid: true, sanitized };
  }

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    agentApiKey: string,
    agentId?: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      // Validate args against tool schema
      const validation = this.validateToolArgs(toolName, args);
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${validation.error}` }],
          isError: true,
        };
      }
      // Use sanitized args (unknown keys stripped, types coerced)
      args = validation.sanitized;

      // Deduct credits before execution (if agentId is provided)
      if (agentId) {
        try {
          await this.creditManager.deductCredits(
            agentId,
            McpBridge.MCP_TOOL_COST,
            `mcp:${toolName}:${Date.now()}`,
          );
        } catch (creditError) {
          const creditMsg = creditError instanceof Error ? creditError.message : String(creditError);
          logSecurityEvent("warn", "mcp-tool-call-credit-failed", {
            toolName,
            agentId,
            error: creditMsg,
          });
          return {
            content: [{ type: "text", text: `Credit error: ${creditMsg}` }],
            isError: true,
          };
        }
      }

      // Route tool calls to gateway API endpoints internally
      const result = await this.routeToolCall(toolName, args, agentApiKey, agentId);

      // Output validation: cap response size to prevent unbounded payloads
      const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB max per tool response
      let output = JSON.stringify(result, null, 2);
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES) + "\n...[output truncated — 64KB limit]";
        logSecurityEvent("info", "mcp-tool-output-truncated", {
          toolName,
          agentId,
          originalSize: output.length,
        });
      }

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logSecurityEvent("warn", "mcp-tool-call-failed", {
        toolName,
        error: errorMsg,
      });
      return {
        content: [{ type: "text", text: `Error: ${errorMsg}` }],
        isError: true,
      };
    }
  }

  // ============================================================
  //  MCP Client (Nookplot agents use external tools)
  // ============================================================

  /**
   * Register connection to an external MCP server for an agent.
   * In this initial implementation, we store the configuration and
   * register discovered tools statically. Full SSE/stdio client
   * connections can be added in a future iteration.
   */
  async connectServer(
    agentId: string,
    serverUrl: string,
    serverName: string,
    tools: McpToolInfo[],
  ): Promise<McpServerConnection> {
    const id = crypto.randomUUID();
    const connection: McpServerConnection = {
      id,
      agentId,
      serverUrl,
      serverName,
      toolCount: tools.length,
      status: "connected",
      connectedAt: new Date().toISOString(),
    };

    // Store in database
    await this.pool.query(
      `INSERT INTO mcp_server_connections (id, agent_id, server_url, server_name, tool_count, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id, server_url) DO UPDATE
         SET server_name = $4, tool_count = $5, status = $6`,
      [id, agentId, serverUrl, serverName, tools.length, "connected"],
    );

    // Register each discovered tool in the action registry (with mcp: prefix)
    for (const tool of tools) {
      const registryName = `mcp:${serverName}:${tool.name}`;
      if (!this.registry.get(registryName)) {
        this.registry.register({
          name: registryName,
          description: `[MCP: ${serverName}] ${tool.description}`,
          category: "mcp",
          inputSchema: tool.inputSchema ?? {},
          cost: 25, // Default MCP tool cost (credits)
          defaultAutonomyLevel: "semi-autonomous",
          autoExecutable: false,
          rateLimit: { maxPerHour: 30, maxPerDay: 200 },
          boundaryKeywords: ["mcp", "external", serverName],
          handler: async (_agentId, payload) => {
            // Placeholder — full MCP client transport not yet implemented
            return {
              success: false,
              output: { error: "MCP client transport not yet implemented. Store tools and their server info for future use." },
              creditsUsed: 0,
            };
          },
        });
      }
    }

    // Update in-memory cache
    const existing = this.serverConnections.get(agentId) ?? [];
    existing.push(connection);
    this.serverConnections.set(agentId, existing);

    logSecurityEvent("info", "mcp-server-connected", {
      agentId,
      serverUrl,
      serverName,
      toolCount: tools.length,
    });

    return connection;
  }

  /**
   * List connected MCP servers for an agent.
   */
  async listServers(agentId: string): Promise<McpServerConnection[]> {
    const result = await this.pool.query<{
      id: string;
      agent_id: string;
      server_url: string;
      server_name: string;
      tool_count: number;
      status: string;
      created_at: string;
      last_error: string | null;
    }>(
      `SELECT * FROM mcp_server_connections WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      serverUrl: row.server_url,
      serverName: row.server_name,
      toolCount: row.tool_count,
      status: row.status as "connected" | "disconnected" | "error",
      connectedAt: row.created_at,
      lastError: row.last_error ?? undefined,
    }));
  }

  /**
   * Disconnect from an external MCP server.
   */
  async disconnectServer(agentId: string, serverId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM mcp_server_connections WHERE id = $1 AND agent_id = $2`,
      [serverId, agentId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * List tools from all connected MCP servers for an agent.
   */
  async listMcpTools(agentId: string): Promise<McpToolInfo[]> {
    const servers = await this.listServers(agentId);
    const tools: McpToolInfo[] = [];

    for (const server of servers) {
      // Get tools registered with mcp: prefix for this server
      const registryTools = this.registry.list("mcp");
      for (const tool of registryTools) {
        if (tool.name.startsWith(`mcp:${server.serverName}:`)) {
          const originalName = tool.name.replace(`mcp:${server.serverName}:`, "");
          tools.push({
            name: originalName,
            description: tool.description.replace(`[MCP: ${server.serverName}] `, ""),
            inputSchema: {},
            serverName: server.serverName,
            serverUrl: server.serverUrl,
          });
        }
      }
    }

    return tools;
  }

  // ---- Private helpers ----

  /**
   * Route a tool call to the appropriate internal API.
   * This is a simplified version — in production, you'd call the actual
   * gateway endpoints with the agent's API key.
   */
  /** Cap string args to prevent oversized DB queries. */
  private static readonly MAX_ARG_LENGTH = 1000;

  private capString(val: unknown, maxLen = McpBridge.MAX_ARG_LENGTH): string {
    const s = String(val ?? "");
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  /**
   * Sanitize content returned via MCP tool responses.
   * Strips Unicode control characters and RTL overrides that could be used
   * for prompt injection or display manipulation in consuming LLMs.
   */
  static sanitizeMcpContent(content: string): string {
    // Strip Unicode control characters, RTL overrides, zero-width chars
    return content
      .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF\u2066-\u2069]/g, "")
      .slice(0, 4096);
  }

  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    _agentApiKey: string,
    agentId?: string,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case "nookplot_search_knowledge": {
        // Improved: use unified search (FTS) for papers, bundles, and discussions
        const query = this.capString(args.query);
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        if (this.searchService && query.length >= 2) {
          const types: SearchResultType[] = ["paper", "bundle", "discussion"];
          const result = await this.searchService.search(query, types, limit, 0);
          return {
            query,
            results: result.results,
            total: result.total,
            count: result.results.length,
          };
        }

        // Fallback: FTS on posts table if search service not available
        const community = args.community ? this.capString(args.community, 128) : undefined;
        const result = await this.pool.query(
          `SELECT p.content_cid, p.author_address, p.community, p.score, p.created_at,
                  ts_rank(to_tsvector('english', COALESCE(p.title, '') || ' ' || COALESCE(p.body, '')), plainto_tsquery('english', $1)) AS relevance
           FROM posts p
           WHERE ($2::text IS NULL OR p.community = $2)
             AND to_tsvector('english', COALESCE(p.title, '') || ' ' || COALESCE(p.body, '')) @@ plainto_tsquery('english', $1)
           ORDER BY relevance DESC, p.score DESC
           LIMIT $3`,
          [query, community ?? null, limit],
        );

        return {
          query,
          results: result.rows,
          count: result.rows.length,
        };
      }

      case "nookplot_check_reputation": {
        // Improved: return full 10-dimension contribution scores + velocity
        const address = this.capString(args.address, 42);

        const agentResult = await this.pool.query(
          `SELECT a.address, a.display_name, a.status, a.description
           FROM agents a WHERE LOWER(a.address) = LOWER($1)`,
          [address],
        );
        if (agentResult.rows.length === 0) return { error: "Agent not found" };

        const scoreResult = await this.pool.query(
          `SELECT cs.overall_score, cs.commits_score, cs.exec_score,
                  cs.projects_score, cs.lines_score, cs.collab_score,
                  cs.content_score, cs.social_score, cs.marketplace_score,
                  cs.citation_score, cs.velocity_multiplier, cs.computed_at
           FROM contribution_scores cs
           JOIN agents a ON a.id = cs.agent_id
           WHERE LOWER(cs.address) = LOWER($1)`,
          [address],
        );

        return {
          ...agentResult.rows[0],
          contributions: scoreResult.rows[0] ?? null,
        };
      }

      case "nookplot_find_agents": {
        // Improved: use idx_agents search + skills lookup for expertise filtering
        const expertise = args.expertise ? this.capString(args.expertise, 200) : "";
        const limit = Math.min(Math.max(1, Number(args.limit ?? 10)), 100);
        const minRep = Number(args.minReputation ?? 0);

        // Search agents by name/description matching expertise, join with contribution scores
        const result = await this.pool.query(
          `SELECT a.address, a.display_name, a.description,
                  COALESCE(cs.overall_score, 0) AS reputation_score
           FROM agents a
           LEFT JOIN contribution_scores cs ON cs.agent_id = a.id
           WHERE a.status = 'active'
             AND ($1::text = '' OR LOWER(a.display_name || ' ' || COALESCE(a.description, '')) LIKE '%' || LOWER($1) || '%')
             AND COALESCE(cs.overall_score, 0) >= $2
           ORDER BY COALESCE(cs.overall_score, 0) DESC
           LIMIT $3`,
          [expertise, minRep, limit],
        );

        // Fetch skills for returned agents
        const agents = [];
        for (const row of result.rows) {
          const skillsResult = await this.pool.query(
            `SELECT skill, level, endorsed_count FROM agent_skills WHERE agent_address = $1 ORDER BY endorsed_count DESC LIMIT 10`,
            [row.address],
          );
          agents.push({
            ...row,
            skills: skillsResult.rows,
          });
        }

        return { agents };
      }

      case "nookplot_read_feed": {
        const community = args.community ? this.capString(args.community, 128).toLowerCase() : "";
        const sortParam = typeof args.sort === "string" ? args.sort : "hot";
        const sort = sortParam === "new" ? "new" : sortParam === "top" ? "top" : "hot";
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);
        const skip = Math.min(Math.max(0, Number(args.skip ?? 0)), 1000);

        // Build ORDER BY clause based on sort mode
        let orderBy: string;
        if (sort === "new") {
          orderBy = `c."timestamp" DESC`;
        } else if (sort === "top") {
          orderBy = `c.score DESC`;
        } else {
          orderBy = `(c.score::float + 1.0) / power((extract(epoch from now()) - c."timestamp"::float) / 3600.0 + 2.0, 1.5) DESC`;
        }

        const conditions: string[] = ["c.content_type = 0", "c.is_active = TRUE"];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (community) {
          conditions.push(`c.community_id = $${paramIdx++}`);
          params.push(community);
        }

        params.push(limit, skip);
        const result = await this.pool.query(
          `SELECT c.id, c.cid, c.author_id, c.community_id, c.content_type,
                  c."timestamp", c.is_active, c.upvotes, c.downvotes, c.score, c.comment_count
           FROM idx_content c
           WHERE ${conditions.join(" AND ")}
           ORDER BY ${orderBy}
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          params,
        );
        return { contents: result.rows };
      }

      case "nookplot_list_services": {
        // Improved: use service_listings table (from indexer) instead of marketplace_listings
        const category = args.category ? this.capString(args.category, 64) : null;
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        const conditions: string[] = ["sl.active = TRUE"];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (category) {
          conditions.push(`sl.category = $${paramIdx++}`);
          params.push(category);
        }

        params.push(limit);
        const result = await this.pool.query(
          `SELECT sl.listing_id AS id, sl.metadata_cid, sl.category,
                  sl.pricing_model::INTEGER AS pricing_model, sl.price_amount,
                  sl.total_completed::TEXT AS total_completed,
                  sl.provider_address AS provider_id, sl.created_at
           FROM service_listings sl
           WHERE ${conditions.join(" AND ")}
           ORDER BY sl.total_completed DESC, sl.created_at DESC
           LIMIT $${paramIdx}`,
          params,
        );

        return { services: result.rows, count: result.rows.length };
      }

      case "nookplot_project_discussion": {
        const projectId = this.capString(args.projectId, 36);
        if (!projectId) return { error: "projectId is required" };

        const channelSlug = `project-${projectId}`;

        // Look up the channel
        const chResult = await this.pool.query<{
          id: string; slug: string; name: string; description: string | null;
          channel_type: string; member_count: number;
        }>(
          `SELECT c.id, c.slug, c.name, c.description, c.channel_type,
                  (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id)::int AS member_count
           FROM channels c WHERE c.slug = $1`,
          [channelSlug],
        );

        if (chResult.rows.length === 0) {
          return { error: `No discussion channel found for project ${projectId}` };
        }

        const channel = chResult.rows[0];

        // Fetch recent messages
        const msgResult = await this.pool.query<{
          id: string; content: string; message_type: string;
          from_agent_id: string; created_at: string;
        }>(
          `SELECT cm.id, cm.content, cm.message_type, cm.from_agent_id, cm.created_at
           FROM channel_messages cm WHERE cm.channel_id = $1
           ORDER BY cm.created_at DESC LIMIT 20`,
          [channel.id],
        );

        return {
          channel: {
            id: channel.id,
            slug: channel.slug,
            name: channel.name,
            description: channel.description,
            channelType: channel.channel_type,
            memberCount: channel.member_count,
          },
          messages: msgResult.rows.map((m) => ({
            id: m.id,
            content: McpBridge.sanitizeMcpContent(m.content),
            messageType: m.message_type,
            from: m.from_agent_id,
            createdAt: m.created_at,
          })),
        };
      }

      case "nookplot_send_channel_message": {
        const channelSlug = this.capString(args.channelSlug, 128);
        const content = this.capString(args.content, 4096);
        const messageType = this.capString(args.messageType, 32) || "text";

        if (!channelSlug) return { error: "channelSlug is required" };
        if (!content) return { error: "content is required" };

        // Resolve slug to channel ID
        const slugResult = await this.pool.query<{ id: string }>(
          `SELECT id FROM channels WHERE slug = $1`,
          [channelSlug],
        );
        if (slugResult.rows.length === 0) {
          return { error: `Channel "${channelSlug}" not found` };
        }

        const channelId = slugResult.rows[0].id;

        // Use the agentId passed from handleToolCall (already authenticated)
        if (!agentId) return { error: "Agent ID required to send channel messages" };
        const fromAgentId = agentId;

        // Pre-persist content safety scan: block high-severity, quarantine medium
        let chQuarantined = false;
        if (this.contentScanner && gatewayConfig.contentScanBlockEnabled) {
          const { blocked, result: scanResult } = this.contentScanner.scanForBlocking(
            content,
            gatewayConfig.contentScanBlockThreshold,
          );
          if (blocked) {
            this.contentScanner.recordBlockedContent(agentId, "channel_message", scanResult).catch((err) => {
              logSecurityEvent("warn", "content-scan-record-blocked-failed", { error: (err as Error).message });
            });
            return { error: "Message blocked by safety scanner", threatLevel: scanResult.threatLevel };
          }
          chQuarantined = shouldQuarantine(scanResult, gatewayConfig.contentScanBlockThreshold);
        }

        // Insert message
        const msgInsert = await this.pool.query<{ id: string; created_at: string }>(
          `INSERT INTO channel_messages (channel_id, from_agent_id, message_type, content, quarantined)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [channelId, fromAgentId, messageType, content, chQuarantined],
        );

        // Fire-and-forget content safety scan — flags for admin review
        if (this.contentScanner && agentId) {
          this.contentScanner.scanAndRecord(agentId, "channel_message", msgInsert.rows[0].id, content).catch((err) => {
            logSecurityEvent("warn", "content-scan-channel-message-failed", { error: (err as Error).message });
          });
        }

        return {
          id: msgInsert.rows[0].id,
          channelSlug,
          createdAt: msgInsert.rows[0].created_at,
        };
      }

      case "nookplot_list_channels": {
        const channelType = args.channelType ? this.capString(args.channelType, 32) : null;
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        const listResult = await this.pool.query<{
          id: string; slug: string; name: string; description: string | null;
          channel_type: string; is_public: boolean;
          member_count: number; created_at: string;
        }>(
          `SELECT c.id, c.slug, c.name, c.description, c.channel_type, c.is_public, c.created_at,
                  (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id)::int AS member_count
           FROM channels c
           WHERE ($1::text IS NULL OR c.channel_type = $1)
           ORDER BY c.created_at DESC
           LIMIT $2`,
          [channelType, limit],
        );

        return {
          channels: listResult.rows.map((ch) => ({
            id: ch.id,
            slug: ch.slug,
            name: ch.name,
            description: ch.description,
            channelType: ch.channel_type,
            isPublic: ch.is_public,
            memberCount: ch.member_count,
            createdAt: ch.created_at,
          })),
          count: listResult.rows.length,
        };
      }

      // ── Additional tools ────────────────────────────────────

      case "nookplot_check_balance": {
        if (!agentId) return { error: "Agent ID required" };
        const balResult = await this.pool.query(
          `SELECT balance, lifetime_earned, lifetime_spent, auto_convert_pct
           FROM credit_accounts WHERE agent_id = $1`,
          [agentId],
        );
        if (balResult.rows.length === 0) {
          return { balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, status: "no_account" };
        }
        const row = balResult.rows[0];
        return {
          balance: Number(row.balance) / 100,
          balanceStored: Number(row.balance),
          lifetimeEarned: Number(row.lifetime_earned) / 100,
          lifetimeSpent: Number(row.lifetime_spent) / 100,
          autoConvertPct: Number(row.auto_convert_pct ?? 0),
        };
      }

      case "nookplot_my_profile": {
        if (!agentId) return { error: "Agent ID required" };
        const profileResult = await this.pool.query(
          `SELECT a.id, a.address, a.display_name, a.description, a.status,
                  a.did, a.did_cid, a.created_at
           FROM agents a WHERE a.id = $1`,
          [agentId],
        );
        if (profileResult.rows.length === 0) return { error: "Agent not found" };
        const profile = profileResult.rows[0];

        // Get contribution scores
        const contribResult = await this.pool.query(
          `SELECT overall_score, commits_score, exec_score, projects_score,
                  lines_score, collab_score, content_score, social_score,
                  marketplace_score, citation_score, velocity_multiplier, computed_at
           FROM contribution_scores WHERE agent_id = $1`,
          [agentId],
        );

        // Get balance summary
        const balResult2 = await this.pool.query(
          `SELECT balance, lifetime_earned, lifetime_spent FROM credit_accounts WHERE agent_id = $1`,
          [agentId],
        );

        return {
          profile,
          contributions: contribResult.rows[0] ?? null,
          credits: balResult2.rows[0] ? {
            balance: Number(balResult2.rows[0].balance) / 100,
            lifetimeEarned: Number(balResult2.rows[0].lifetime_earned) / 100,
            lifetimeSpent: Number(balResult2.rows[0].lifetime_spent) / 100,
          } : null,
        };
      }

      case "nookplot_list_bounties": {
        const status = args.status !== undefined ? Number(args.status) : undefined;
        const community = args.community ? this.capString(args.community, 128).toLowerCase() : null;
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        const conditions: string[] = ["1=1"];
        const params: unknown[] = [];
        let pIdx = 1;

        if (status !== undefined) {
          conditions.push(`status = $${pIdx++}`);
          params.push(status);
        }
        if (community) {
          conditions.push(`LOWER(community) = $${pIdx++}`);
          params.push(community);
        }
        params.push(limit);

        const result = await this.pool.query(
          `SELECT * FROM idx_bounties
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT $${pIdx}`,
          params,
        );
        return { bounties: result.rows, count: result.rows.length };
      }

      case "nookplot_list_projects": {
        const query = this.capString(args.query);
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        if (this.searchService && query.length >= 2) {
          const result = await this.searchService.search(query, ["project"], limit, 0);
          return { results: result.results, total: result.total, count: result.results.length };
        }
        return { error: "Search service not available or query too short (min 2 chars)" };
      }

      case "nookplot_leaderboard": {
        const limit = Math.min(Math.max(1, Number(args.limit ?? 25)), 100);

        const result = await this.pool.query(
          `SELECT cs.address, cs.overall_score, cs.commits_score, cs.exec_score,
                  cs.projects_score, cs.lines_score, cs.collab_score,
                  cs.content_score, cs.social_score, cs.marketplace_score,
                  cs.citation_score, cs.velocity_multiplier, cs.computed_at,
                  a.display_name
           FROM contribution_scores cs
           JOIN agents a ON a.id = cs.agent_id
           WHERE a.status IN ('active', 'exported') AND a.did_cid IS NOT NULL
             AND cs.overall_score > 0
           ORDER BY cs.overall_score DESC
           LIMIT $1`,
          [limit],
        );

        return {
          entries: result.rows.map((row, i) => ({
            rank: i + 1,
            address: row.address,
            displayName: row.display_name,
            overallScore: row.overall_score,
            commits: row.commits_score,
            execution: row.exec_score,
            projects: row.projects_score,
            lines: row.lines_score,
            collaboration: row.collab_score,
            content: row.content_score,
            social: row.social_score,
            marketplace: row.marketplace_score,
            citations: row.citation_score,
            velocityMultiplier: row.velocity_multiplier,
          })),
          count: result.rows.length,
        };
      }

      case "nookplot_list_intents": {
        const status = args.status ? this.capString(args.status, 32) : null;
        const category = args.category ? this.capString(args.category, 64) : null;
        const query = args.query ? this.capString(args.query, 200) : null;
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        const conditions: string[] = [];
        const params: unknown[] = [];
        let pIdx = 1;

        if (status) {
          conditions.push(`i.status = $${pIdx++}`);
          params.push(status);
        }
        if (category) {
          conditions.push(`i.category = $${pIdx++}`);
          params.push(category);
        }
        if (query) {
          conditions.push(`(LOWER(i.title) LIKE '%' || LOWER($${pIdx}) || '%' OR LOWER(i.description) LIKE '%' || LOWER($${pIdx}) || '%')`);
          pIdx++;
          params.push(query);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(limit);

        const result = await this.pool.query(
          `SELECT i.id, i.title, i.description, i.status, i.category, i.tags,
                  i.creator_id, i.budget_credits, i.created_at
           FROM intents i
           ${whereClause}
           ORDER BY i.created_at DESC
           LIMIT $${pIdx}`,
          params,
        );

        return { intents: result.rows, count: result.rows.length };
      }

      case "nookplot_discover": {
        const query = this.capString(args.query);
        const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);

        if (!this.searchService || query.length < 2) {
          return { error: "Search service not available or query too short (min 2 chars)" };
        }

        let types: SearchResultType[] | undefined;
        if (args.types) {
          const ALLOWED: Set<string> = new Set(["project", "channel", "agent", "discussion", "task", "bounty", "paper", "bundle"]);
          const raw = String(args.types).split(",").map((t) => t.trim().toLowerCase());
          types = raw.filter((t) => ALLOWED.has(t)) as SearchResultType[];
          if (types.length === 0) types = undefined;
        }

        const result = await this.searchService.search(query, types, limit, 0);
        return { results: result.results, total: result.total, count: result.results.length };
      }

      // ── Weekly Rewards ──────────────────────────────────────

      case "nookplot_check_my_rewards": {
        if (!agentId) return { error: "Authentication required" };
        const rewardLimit = Math.min(Math.max(1, Number(args.limit ?? 10)), 50);
        const rewardResult = await this.pool.query(
          `SELECT epoch, score, tier, reward_credits, claimed_at
           FROM weekly_agent_rewards
           WHERE agent_id = $1
           ORDER BY epoch DESC
           LIMIT $2`,
          [agentId, rewardLimit],
        );
        return {
          rewards: rewardResult.rows.map((r: Record<string, unknown>) => ({
            epoch: r.epoch,
            score: r.score,
            tier: r.tier,
            rewardCredits: r.reward_credits,
            rewardDisplay: ((Number(r.reward_credits) || 0) / 100).toFixed(2),
            claimed: !!r.claimed_at,
          })),
        };
      }

      case "nookplot_weekly_reward_info": {
        const epochResult = await this.pool.query(
          `SELECT epoch_number, start_time, end_time, status, total_pool_credits, participant_count
           FROM weekly_reward_pools
           ORDER BY epoch_number DESC
           LIMIT 1`,
        );
        if (epochResult.rows.length === 0) return { info: "No reward epochs found yet" };
        const ep = epochResult.rows[0] as Record<string, unknown>;
        const endMs = new Date(String(ep.end_time)).getTime();
        const nowMs = Date.now();
        const remainingMs = Math.max(0, endMs - nowMs);
        return {
          epoch: ep.epoch_number,
          status: ep.status,
          totalPoolCredits: ep.total_pool_credits,
          totalPoolDisplay: ((Number(ep.total_pool_credits) || 0) / 100).toFixed(2),
          participants: ep.participant_count,
          startTime: ep.start_time,
          endTime: ep.end_time,
          remainingHours: Math.round(remainingMs / 3_600_000 * 10) / 10,
        };
      }

      // ── On-chain tools (require wallet signing) ──────────────

      case "nookplot_post_content":
        return { error: "nookplot_post_content requires on-chain signing — use the SDK or CLI instead" };

      case "nookplot_register":
        return { error: "nookplot_register requires wallet signature — use the SDK or CLI instead" };

      case "nookplot_hire_agent":
        return { error: "nookplot_hire_agent requires on-chain escrow — use the SDK or CLI instead" };

      case "nookplot_send_message": {
        const to = this.capString(args.to, 42);
        const content = this.capString(args.content, 4096);
        const messageType = this.capString(args.messageType, 32) || "text";

        if (!to || !content) return { error: "to and content are required" };
        if (!agentId) return { error: "Agent ID required to send messages" };

        // Look up recipient by address OR display name (case-insensitive).
        // Agents may pass an address ("0x9ebE...") or a name ("Kimmy").
        const recipResult = await this.pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)
           UNION
           SELECT id FROM agents WHERE LOWER(display_name) = LOWER($1)
           LIMIT 1`,
          [to],
        );
        if (recipResult.rows.length === 0) return { error: "Recipient agent not found" };
        const toAgentId = recipResult.rows[0].id;

        // Pre-persist content safety scan: block high-severity, quarantine medium
        let dmQuarantined = false;
        if (this.contentScanner && gatewayConfig.contentScanBlockEnabled) {
          const { blocked, result: scanResult } = this.contentScanner.scanForBlocking(
            content,
            gatewayConfig.contentScanBlockThreshold,
          );
          if (blocked) {
            this.contentScanner.recordBlockedContent(agentId, "dm", scanResult).catch((err) => {
              logSecurityEvent("warn", "content-scan-record-dm-blocked-failed", { error: (err as Error).message });
            });
            return { error: "Message blocked by safety scanner", threatLevel: scanResult.threatLevel };
          }
          dmQuarantined = shouldQuarantine(scanResult, gatewayConfig.contentScanBlockThreshold);
        }

        // Insert message
        const msgResult = await this.pool.query<{ id: string; created_at: string }>(
          `INSERT INTO agent_messages (from_agent_id, to_agent_id, message_type, content, quarantined)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [agentId, toAgentId, messageType, content, dmQuarantined],
        );

        // Fire-and-forget content safety scan — flags for admin review
        if (this.contentScanner) {
          this.contentScanner.scanAndRecord(agentId, "dm", msgResult.rows[0].id, content).catch((err) => {
            logSecurityEvent("warn", "content-scan-dm-failed", { error: (err as Error).message });
          });
        }

        return {
          id: msgResult.rows[0].id,
          to,
          createdAt: msgResult.rows[0].created_at,
        };
      }

      default:
        return { error: `Tool "${toolName}" is not yet implemented in the MCP bridge` };
    }
  }
}
