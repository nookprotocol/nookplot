import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpBridge } from "./mcpBridge.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("./contentScanner.js", () => ({
  shouldQuarantine: vi.fn().mockReturnValue(false),
}));

vi.mock("../config.js", () => ({
  gatewayConfig: { maxMcpToolResponseSize: 65536 },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockRegistry() {
  return {
    get: vi.fn().mockReturnValue(null),
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  };
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue(undefined),
  };
}

function createBridge(
  pool?: ReturnType<typeof createMockPool>,
  registry?: ReturnType<typeof createMockRegistry>,
  creditManager?: ReturnType<typeof createMockCreditManager>,
) {
  const p = pool ?? createMockPool();
  const r = registry ?? createMockRegistry();
  const cm = creditManager ?? createMockCreditManager();
  const bridge = new McpBridge(p as any, r as any, cm as any);
  return { bridge, pool: p, registry: r, creditManager: cm };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  getNookplotTools
// ---------------------------------------------------------------------------

describe("McpBridge.getNookplotTools", () => {
  it("returns array of tool definitions", () => {
    const { bridge } = createBridge();
    const tools = bridge.getNookplotTools();

    expect(tools.length).toBeGreaterThan(5);
    expect(tools[0].name).toBe("nookplot_search_knowledge");
    expect(tools[0].inputSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
//  validateToolArgs (private — via reflection)
// ---------------------------------------------------------------------------

describe("McpBridge — validateToolArgs", () => {
  it("accepts valid args for known tool", () => {
    const { bridge } = createBridge();
    const result = (bridge as any).validateToolArgs("nookplot_search_knowledge", {
      query: "test query",
    });
    expect(result.valid).toBe(true);
    expect(result.sanitized.query).toBe("test query");
  });

  it("rejects unknown tool", () => {
    const { bridge } = createBridge();
    const result = (bridge as any).validateToolArgs("nookplot_nonexistent", {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("rejects missing required argument", () => {
    const { bridge } = createBridge();
    const result = (bridge as any).validateToolArgs("nookplot_search_knowledge", {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing required argument");
    expect(result.error).toContain("query");
  });

  it("drops unknown args silently", () => {
    const { bridge } = createBridge();
    const result = (bridge as any).validateToolArgs("nookplot_search_knowledge", {
      query: "test",
      unknownField: "dropped",
    });
    expect(result.valid).toBe(true);
    expect(result.sanitized.query).toBe("test");
    expect(result.sanitized.unknownField).toBeUndefined();
  });

  it("coerces string numbers to numbers", () => {
    const { bridge } = createBridge();
    const result = (bridge as any).validateToolArgs("nookplot_search_knowledge", {
      query: "test",
      limit: "25",
    });
    expect(result.valid).toBe(true);
    expect(result.sanitized.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
//  sanitizeMcpContent (static)
// ---------------------------------------------------------------------------

describe("McpBridge.sanitizeMcpContent", () => {
  it("strips Unicode control characters", () => {
    const input = "Hello\u200BWorld\u202Etest\uFEFF";
    const result = McpBridge.sanitizeMcpContent(input);
    expect(result).toBe("HelloWorldtest");
  });

  it("truncates to 4096 chars", () => {
    const input = "a".repeat(5000);
    const result = McpBridge.sanitizeMcpContent(input);
    expect(result.length).toBe(4096);
  });

  it("passes through clean content unchanged", () => {
    const input = "This is normal text with no special chars.";
    expect(McpBridge.sanitizeMcpContent(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
//  handleToolCall
// ---------------------------------------------------------------------------

describe("McpBridge.handleToolCall", () => {
  it("returns error for invalid tool args", async () => {
    const { bridge } = createBridge();

    const result = await bridge.handleToolCall(
      "nookplot_search_knowledge",
      {}, // missing required 'query'
      "sk-test",
      "agt_test",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid arguments");
  });

  it("deducts credits before execution", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { bridge } = createBridge(pool, undefined, creditManager);

    // Mock the DB query for search_knowledge route
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await bridge.handleToolCall(
      "nookplot_search_knowledge",
      { query: "test" },
      "sk-test",
      "agt_test",
    );

    expect(creditManager.deductCredits).toHaveBeenCalledWith(
      "agt_test",
      25, // MCP_TOOL_COST
      expect.stringContaining("mcp:nookplot_search_knowledge:"),
    );
  });

  it("returns credit error when deduction fails", async () => {
    const creditManager = createMockCreditManager();
    creditManager.deductCredits.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));
    const { bridge } = createBridge(undefined, undefined, creditManager);

    const result = await bridge.handleToolCall(
      "nookplot_search_knowledge",
      { query: "test" },
      "sk-test",
      "agt_test",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Credit error");
  });

  it("skips credit deduction when no agentId", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { bridge } = createBridge(pool, undefined, creditManager);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await bridge.handleToolCall(
      "nookplot_search_knowledge",
      { query: "test" },
      "sk-test",
      undefined, // no agentId
    );

    expect(creditManager.deductCredits).not.toHaveBeenCalled();
  });

  it("returns result for successful tool call", async () => {
    const pool = createMockPool();
    const { bridge } = createBridge(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ content_cid: "cid1", author_address: "0x1", community: "ai", score: 10, created_at: "2025-01-01" }],
      rowCount: 1,
    });

    const result = await bridge.handleToolCall(
      "nookplot_search_knowledge",
      { query: "test" },
      "sk-test",
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].content_cid).toBe("cid1");
  });

  it("catches and returns errors from route execution", async () => {
    const pool = createMockPool();
    const { bridge } = createBridge(pool);

    pool.query.mockRejectedValueOnce(new Error("DB connection failed"));

    const result = await bridge.handleToolCall(
      "nookplot_search_knowledge",
      { query: "test" },
      "sk-test",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DB connection failed");
  });
});

// ---------------------------------------------------------------------------
//  connectServer
// ---------------------------------------------------------------------------

describe("McpBridge.connectServer", () => {
  it("stores connection and registers tools", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const { bridge } = createBridge(pool, registry);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT

    const tools = [
      { name: "read_file", description: "Read a file", inputSchema: {}, serverName: "filesystem", serverUrl: "http://localhost:3000" },
    ];

    const connection = await bridge.connectServer("agt_test", "http://localhost:3000", "filesystem", tools);

    expect(connection.agentId).toBe("agt_test");
    expect(connection.serverName).toBe("filesystem");
    expect(connection.toolCount).toBe(1);
    expect(connection.status).toBe("connected");

    // Verify DB insert
    expect(pool.query).toHaveBeenCalledOnce();
    const insertCall = pool.query.mock.calls[0];
    expect(insertCall[0]).toContain("INSERT INTO mcp_server_connections");

    // Verify tool registration
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mcp:filesystem:read_file",
        category: "mcp",
      }),
    );
  });

  it("skips tool registration when tool already exists", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue({ name: "mcp:filesystem:read_file" }); // already registered
    const { bridge } = createBridge(pool, registry);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const tools = [
      { name: "read_file", description: "Read a file", inputSchema: {}, serverName: "filesystem", serverUrl: "http://localhost:3000" },
    ];

    await bridge.connectServer("agt_test", "http://localhost:3000", "filesystem", tools);

    expect(registry.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  listServers / disconnectServer
// ---------------------------------------------------------------------------

describe("McpBridge.listServers", () => {
  it("returns formatted server list", async () => {
    const pool = createMockPool();
    const { bridge } = createBridge(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "srv-1",
        agent_id: "agt_test",
        server_url: "http://localhost:3000",
        server_name: "filesystem",
        tool_count: 3,
        status: "connected",
        created_at: "2025-06-01T00:00:00Z",
        last_error: null,
      }],
      rowCount: 1,
    });

    const servers = await bridge.listServers("agt_test");

    expect(servers).toHaveLength(1);
    expect(servers[0].serverName).toBe("filesystem");
    expect(servers[0].toolCount).toBe(3);
    expect(servers[0].lastError).toBeUndefined();
  });
});

describe("McpBridge.disconnectServer", () => {
  it("returns true when server deleted", async () => {
    const pool = createMockPool();
    const { bridge } = createBridge(pool);

    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await bridge.disconnectServer("agt_test", "srv-1");
    expect(result).toBe(true);
  });

  it("returns false when server not found", async () => {
    const pool = createMockPool();
    const { bridge } = createBridge(pool);

    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const result = await bridge.disconnectServer("agt_test", "unknown");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  capString (private — via reflection)
// ---------------------------------------------------------------------------

describe("McpBridge — capString", () => {
  it("truncates strings beyond max length", () => {
    const { bridge } = createBridge();
    const long = "a".repeat(2000);
    const result = (bridge as any).capString(long, 100);
    expect(result.length).toBe(100);
  });

  it("returns full string when under max", () => {
    const { bridge } = createBridge();
    expect((bridge as any).capString("hello")).toBe("hello");
  });

  it("handles null/undefined", () => {
    const { bridge } = createBridge();
    expect((bridge as any).capString(null)).toBe("");
    expect((bridge as any).capString(undefined)).toBe("");
  });
});
