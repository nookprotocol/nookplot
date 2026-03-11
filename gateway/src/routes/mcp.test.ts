import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createMcpRouter } from "./mcp.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: {},
  CallToolRequestSchema: {},
}));

const mockResolve4 = vi.fn().mockResolvedValue(["93.184.216.34"]);
const mockResolve6 = vi.fn().mockResolvedValue([]);
vi.mock("dns/promises", () => ({
  default: {
    resolve4: (...args: unknown[]) => mockResolve4(...args),
    resolve6: (...args: unknown[]) => mockResolve6(...args),
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_mcp", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockMcpBridge() {
  return {
    getNookplotTools: vi.fn().mockReturnValue([]),
    handleToolCall: vi.fn().mockResolvedValue({ content: [] }),
    connectServer: vi.fn().mockResolvedValue({ id: "srv_1", serverUrl: "https://example.com/mcp", serverName: "test-server" }),
    listServers: vi.fn().mockResolvedValue([{ id: "srv_1", serverName: "test-server" }]),
    disconnectServer: vi.fn().mockResolvedValue(true),
    listMcpTools: vi.fn().mockResolvedValue([{ name: "tool1", description: "A tool" }]),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  bridge?: ReturnType<typeof createMockMcpBridge>,
) {
  const mcpBridge = bridge ?? createMockMcpBridge();
  const router = createMcpRouter(pool as any, TEST_HMAC_SECRET, mcpBridge as any);
  return { app: createTestApp(router), mcpBridge };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

beforeEach(() => {
  mockResolve4.mockResolvedValue(["93.184.216.34"]);
  mockResolve6.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
//  POST /v1/agents/me/mcp/servers — Connect
// ---------------------------------------------------------------------------

describe("POST /v1/agents/me/mcp/servers", () => {
  it("connects to an external MCP server", async () => {
    const pool = createMockPool();
    const bridge = createMockMcpBridge();
    const { app } = buildApp(pool, bridge);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/mcp/servers")
      .set(authHeader())
      .send({ serverUrl: "https://example.com/mcp", serverName: "test-server" });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("srv_1");
    expect(bridge.connectServer).toHaveBeenCalledWith(
      TEST_AGENT.id, "https://example.com/mcp", "test-server", [],
    );
  });

  it("rejects missing serverUrl", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/mcp/servers")
      .set(authHeader())
      .send({ serverName: "test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("serverUrl");
  });

  it("rejects non-HTTP URL", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/mcp/servers")
      .set(authHeader())
      .send({ serverUrl: "ftp://example.com", serverName: "test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("http");
  });

  it("rejects missing serverName", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/mcp/servers")
      .set(authHeader())
      .send({ serverUrl: "https://example.com/mcp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("serverName");
  });

  it("rejects invalid serverName format", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/mcp/servers")
      .set(authHeader())
      .send({ serverUrl: "https://example.com/mcp", serverName: "has spaces!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("alphanumeric");
  });

  it("blocks SSRF to private IPs", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    mockResolve4.mockResolvedValue(["127.0.0.1"]);

    const res = await request(app)
      .post("/v1/agents/me/mcp/servers")
      .set(authHeader())
      .send({ serverUrl: "https://internal.example.com/mcp", serverName: "test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not allowed");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/mcp/servers — List
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/mcp/servers", () => {
  it("returns connected servers", async () => {
    const pool = createMockPool();
    const bridge = createMockMcpBridge();
    const { app } = buildApp(pool, bridge);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/agents/me/mcp/servers")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(bridge.listServers).toHaveBeenCalledWith(TEST_AGENT.id);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/agents/me/mcp/servers/:id — Disconnect
// ---------------------------------------------------------------------------

describe("DELETE /v1/agents/me/mcp/servers/:id", () => {
  it("disconnects a server", async () => {
    const pool = createMockPool();
    const bridge = createMockMcpBridge();
    const { app } = buildApp(pool, bridge);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/agents/me/mcp/servers/srv_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(bridge.disconnectServer).toHaveBeenCalledWith(TEST_AGENT.id, "srv_1");
  });

  it("returns 404 for unknown server", async () => {
    const pool = createMockPool();
    const bridge = createMockMcpBridge();
    bridge.disconnectServer.mockResolvedValue(false);
    const { app } = buildApp(pool, bridge);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/agents/me/mcp/servers/missing")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/mcp/tools — List tools
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/mcp/tools", () => {
  it("returns tools from connected servers", async () => {
    const pool = createMockPool();
    const bridge = createMockMcpBridge();
    const { app } = buildApp(pool, bridge);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/agents/me/mcp/tools")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("tool1");
    expect(bridge.listMcpTools).toHaveBeenCalledWith(TEST_AGENT.id);
  });
});
