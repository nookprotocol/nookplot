import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createActionsRouter } from "./actions.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../secretManager.js", () => ({
  encryptSecret: vi.fn().mockReturnValue({
    encryptedKey: "enc_key",
    iv: "iv_123",
    authTag: "tag_123",
  }),
}));

vi.mock("dns", () => ({
  promises: {
    resolveTxt: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_act", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });
const ADMIN_ADDRESS = TEST_AGENT.address;
const SECRET_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

function createMockRegistry() {
  return {
    list: vi.fn().mockReturnValue([{ name: "search", category: "web" }]),
    get: vi.fn().mockReturnValue({
      name: "search",
      category: "web",
      cost: 25,
      handler: vi.fn(),
    }),
  };
}

function createMockExecutor() {
  return {
    executeDirectly: vi.fn().mockResolvedValue({
      requiresApproval: false,
      result: { success: true, data: "ok" },
    }),
    getExecutionLog: vi.fn().mockResolvedValue([]),
  };
}

function createMockEgressProxy() {
  return {
    execute: vi.fn().mockResolvedValue({ status: 200, body: "ok" }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  opts?: {
    registry?: ReturnType<typeof createMockRegistry>;
    executor?: ReturnType<typeof createMockExecutor>;
    egressProxy?: ReturnType<typeof createMockEgressProxy> | null;
  },
) {
  const registry = opts?.registry ?? createMockRegistry();
  const executor = opts?.executor ?? createMockExecutor();
  const egressProxy = opts && "egressProxy" in opts ? opts.egressProxy : createMockEgressProxy();
  const router = createActionsRouter(
    pool as any,
    registry as any,
    executor as any,
    TEST_HMAC_SECRET,
    egressProxy as any,
    SECRET_ENCRYPTION_KEY,
    ADMIN_ADDRESS,
  );
  return { app: createTestApp(router), registry, executor, egressProxy };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

function ownerHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    "X-Wallet-Address": TEST_AGENT.address,
  };
}

// ---------------------------------------------------------------------------
//  GET /v1/actions/tools
// ---------------------------------------------------------------------------

describe("GET /v1/actions/tools", () => {
  it("lists all tools", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const { app } = buildApp(pool, { registry });
    setupAuth(pool);

    const res = await request(app).get("/v1/actions/tools").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(registry.list).toHaveBeenCalledWith(undefined);
  });

  it("filters by category", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const { app } = buildApp(pool, { registry });
    setupAuth(pool);

    await request(app).get("/v1/actions/tools?category=web").set(authHeader());

    expect(registry.list).toHaveBeenCalledWith("web");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/actions/tools/:name
// ---------------------------------------------------------------------------

describe("GET /v1/actions/tools/:name", () => {
  it("returns tool detail with agent config", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Agent config lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ enabled: true, cost_override: 30, autonomy_override: null, rate_limit_override: null }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/actions/tools/search").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.tool.name).toBe("search");
    expect(res.body.tool.handler).toBeUndefined(); // handler stripped
    expect(res.body.agentConfig).not.toBeNull();
  });

  it("returns 404 for unknown tool", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue(null);
    const { app } = buildApp(pool, { registry });
    setupAuth(pool);

    const res = await request(app).get("/v1/actions/tools/unknown").set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  PUT /v1/actions/tools/:name/config
// ---------------------------------------------------------------------------

describe("PUT /v1/actions/tools/:name/config", () => {
  it("updates tool config", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // UPSERT result
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "cfg_1", agent_id: TEST_AGENT.id, tool_name: "search", enabled: true }],
      rowCount: 1,
    });

    const res = await request(app)
      .put("/v1/actions/tools/search/config")
      .set(ownerHeaders())
      .send({ enabled: true, autonomyOverride: "autonomous" });

    expect(res.status).toBe(200);
    expect(res.body.config).toBeDefined();
  });

  it("returns 404 for unknown tool", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue(null);
    const { app } = buildApp(pool, { registry });
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/actions/tools/unknown/config")
      .set(ownerHeaders())
      .send({ enabled: true });

    expect(res.status).toBe(404);
  });

  it("rejects invalid autonomy override", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/actions/tools/search/config")
      .set(ownerHeaders())
      .send({ autonomyOverride: "god-mode" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("autonomyOverride");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/actions/execute
// ---------------------------------------------------------------------------

describe("POST /v1/actions/execute", () => {
  it("executes a tool", async () => {
    const pool = createMockPool();
    const executor = createMockExecutor();
    const { app } = buildApp(pool, { executor });
    setupAuth(pool);
    // Autonomy level lookup
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/actions/execute")
      .set(ownerHeaders())
      .send({ toolName: "search", payload: { q: "test" } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
  });

  it("returns 202 when requires approval", async () => {
    const pool = createMockPool();
    const executor = createMockExecutor();
    executor.executeDirectly.mockResolvedValue({
      requiresApproval: true,
      actionId: "action_1",
    });
    const { app } = buildApp(pool, { executor });
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/actions/execute")
      .set(ownerHeaders())
      .send({ toolName: "dangerous_tool", payload: {} });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.actionId).toBe("action_1");
  });

  it("normalizes toolName without nookplot_ prefix", async () => {
    const pool = createMockPool();
    const executor = createMockExecutor();
    const { app } = buildApp(pool, { executor });
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/actions/execute")
      .set(ownerHeaders())
      .send({ toolName: "read_feed", payload: { limit: 1 } });

    expect(res.status).toBe(200);
    // The executor should receive the normalized name
    expect(executor.executeDirectly).toHaveBeenCalledWith(
      expect.anything(),
      "nookplot_read_feed",
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes through toolName with nookplot_ prefix unchanged", async () => {
    const pool = createMockPool();
    const executor = createMockExecutor();
    const { app } = buildApp(pool, { executor });
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/actions/execute")
      .set(ownerHeaders())
      .send({ toolName: "nookplot_send_message", payload: { to: "0x1" } });

    expect(res.status).toBe(200);
    expect(executor.executeDirectly).toHaveBeenCalledWith(
      expect.anything(),
      "nookplot_send_message",
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects missing toolName", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/actions/execute")
      .set(ownerHeaders())
      .send({ payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("toolName");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/actions/log
// ---------------------------------------------------------------------------

describe("GET /v1/actions/log", () => {
  it("returns execution log", async () => {
    const pool = createMockPool();
    const executor = createMockExecutor();
    executor.getExecutionLog.mockResolvedValue([{ id: "log_1" }]);
    const { app } = buildApp(pool, { executor });
    setupAuth(pool);

    const res = await request(app).get("/v1/actions/log").set(ownerHeaders());

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(executor.getExecutionLog).toHaveBeenCalledWith(TEST_AGENT.id, 50, 0);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agents/me/domains
// ---------------------------------------------------------------------------

describe("POST /v1/agents/me/domains", () => {
  it("registers a domain", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Domain count
    pool.query.mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1 });
    // INSERT domain
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "dom_1",
        agent_id: TEST_AGENT.id,
        domain: "example.com",
        verified: false,
        verification_token: "tok123",
        verified_at: null,
        created_at: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/agents/me/domains")
      .set(ownerHeaders())
      .send({ domain: "example.com" });

    expect(res.status).toBe(201);
    expect(res.body.domain.domain).toBe("example.com");
    expect(res.body.verificationInstructions.type).toBe("DNS_TXT");
  });

  it("rejects invalid domain format", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/domains")
      .set(ownerHeaders())
      .send({ domain: "not a domain!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid domain");
  });

  it("rejects when max 5 domains reached", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Domain count = 5
    pool.query.mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/agents/me/domains")
      .set(ownerHeaders())
      .send({ domain: "example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("5 domains");
  });

  it("returns 409 on duplicate domain", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    pool.query.mockRejectedValueOnce(new Error("unique constraint violation"));

    const res = await request(app)
      .post("/v1/agents/me/domains")
      .set(ownerHeaders())
      .send({ domain: "example.com" });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/domains
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/domains", () => {
  it("lists domains", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "dom_1", domain: "example.com", verified: true, verified_at: "2025-06-01", created_at: "2025-06-01" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/agents/me/domains").set(ownerHeaders());

    expect(res.status).toBe(200);
    expect(res.body.domains).toHaveLength(1);
    expect(res.body.domains[0].domain).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/agents/me/domains/:id
// ---------------------------------------------------------------------------

describe("DELETE /v1/agents/me/domains/:id", () => {
  it("deletes a domain", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [{ id: "dom_1" }], rowCount: 1 });

    const res = await request(app).delete("/v1/agents/me/domains/dom_1").set(ownerHeaders());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/v1/agents/me/domains/dom_missing").set(ownerHeaders());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agents/me/domains/:id/verify
// ---------------------------------------------------------------------------

describe("POST /v1/agents/me/domains/:id/verify", () => {
  it("verifies domain via DNS TXT", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Domain lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "dom_1", domain: "example.com", verification_token: "tok123", verified: false }],
      rowCount: 1,
    });
    // DNS lookup
    const { promises: dnsPromises } = await import("dns");
    vi.mocked(dnsPromises.resolveTxt).mockResolvedValue([["nookplot-verification=tok123"]]);
    // Update verified
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/agents/me/domains/dom_1/verify")
      .set(ownerHeaders());

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  it("returns 404 for unknown domain", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/agents/me/domains/dom_missing/verify")
      .set(ownerHeaders());

    expect(res.status).toBe(404);
  });

  it("returns already-verified status", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "dom_1", domain: "example.com", verification_token: "tok123", verified: true }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/agents/me/domains/dom_1/verify")
      .set(ownerHeaders());

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.message).toContain("already verified");
  });

  it("returns 422 on DNS lookup failure", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "dom_1", domain: "example.com", verification_token: "tok123", verified: false }],
      rowCount: 1,
    });
    const { promises: dnsPromises } = await import("dns");
    vi.mocked(dnsPromises.resolveTxt).mockRejectedValue(new Error("ENOTFOUND"));

    const res = await request(app)
      .post("/v1/agents/me/domains/dom_1/verify")
      .set(ownerHeaders());

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("DNS lookup failed");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/actions/http — Egress proxy
// ---------------------------------------------------------------------------

describe("POST /v1/actions/http", () => {
  it("executes egress request", async () => {
    const pool = createMockPool();
    const egressProxy = createMockEgressProxy();
    const { app } = buildApp(pool, { egressProxy });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/actions/http")
      .set(ownerHeaders())
      .send({ url: "https://api.example.com/data", method: "GET" });

    expect(res.status).toBe(200);
    expect(egressProxy.execute).toHaveBeenCalledWith(TEST_AGENT.id, expect.objectContaining({
      url: "https://api.example.com/data",
      method: "GET",
    }));
  });

  it("returns 503 when egress not configured", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool, { egressProxy: null });
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/actions/http")
      .set(ownerHeaders())
      .send({ url: "https://api.example.com", method: "GET" });

    expect(res.status).toBe(503);
  });

  it("rejects invalid method", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/actions/http")
      .set(ownerHeaders())
      .send({ url: "https://api.example.com", method: "HACK" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("method");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agents/me/credentials
// ---------------------------------------------------------------------------

describe("POST /v1/agents/me/credentials", () => {
  it("stores a credential", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/agents/me/credentials")
      .set(ownerHeaders())
      .send({ service: "openai", apiKey: "sk-test123" });

    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(true);
    expect(res.body.service).toBe("openai");
  });

  it("rejects missing service", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/credentials")
      .set(ownerHeaders())
      .send({ apiKey: "sk-test123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("service");
  });

  it("rejects invalid service name format", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/agents/me/credentials")
      .set(ownerHeaders())
      .send({ service: "invalid service name!!", apiKey: "sk-test" });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/credentials
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/credentials", () => {
  it("lists stored services", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ service: "openai", created_at: "2025-06-01" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/agents/me/credentials").set(ownerHeaders());

    expect(res.status).toBe(200);
    expect(res.body.credentials).toHaveLength(1);
    expect(res.body.credentials[0].service).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/admin/egress-denylist — Admin only
// ---------------------------------------------------------------------------

describe("GET /v1/admin/egress-denylist", () => {
  it("returns denylist for admin", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "1", domain: "evil.com", reason: "malware", added_by: ADMIN_ADDRESS, created_at: "2025-06-01" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/admin/egress-denylist").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.denylist).toHaveLength(1);
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const nonAdminAgent = createMockAgent({
      id: "agt_nonadmin",
      api_key_hash: TEST_KEY_HASH,
      address: "0x2222222222222222222222222222222222222222",
    });
    // Build with admin address that doesn't match non-admin agent
    const registry = createMockRegistry();
    const executor = createMockExecutor();
    const router = createActionsRouter(
      pool as any, registry as any, executor as any,
      TEST_HMAC_SECRET, null, SECRET_ENCRYPTION_KEY, ADMIN_ADDRESS,
    );
    const app = createTestApp(router);
    // Auth returns non-admin agent
    pool.query.mockResolvedValueOnce({ rows: [nonAdminAgent], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });

    const res = await request(app).get("/v1/admin/egress-denylist").set(authHeader());

    expect(res.status).toBe(403);
  });
});
