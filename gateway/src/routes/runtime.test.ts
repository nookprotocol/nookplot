import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createRuntimeRouter } from "./runtime.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_rt", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockSessionManager() {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "sess_1",
      connectedAt: new Date("2025-06-01T00:00:00.000Z"),
    }),
    disconnect: vi.fn().mockResolvedValue(true),
    disconnectAgent: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(true),
    getPresence: vi.fn().mockResolvedValue([]),
    getActiveCount: vi.fn().mockResolvedValue(0),
  };
}

const TEST_CLIENT_VERSION_POLICY = {
  minRuntime: "0.0.0",
  latestRuntime: "0.0.0",
  minRuntimePy: "0.0.0",
  latestRuntimePy: "0.0.0",
  minCli: "0.0.0",
  latestCli: "0.0.0",
};

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  mgr?: ReturnType<typeof createMockSessionManager>,
) {
  const sessionManager = mgr ?? createMockSessionManager();
  const router = createRuntimeRouter(pool as any, TEST_HMAC_SECRET, sessionManager as any, "0.4.0", TEST_CLIENT_VERSION_POLICY);
  return { app: createTestApp(router), sessionManager };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/runtime/connect
// ---------------------------------------------------------------------------

describe("POST /v1/runtime/connect", () => {
  it("creates a runtime session", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/runtime/connect")
      .set(authHeader())
      .send({ metadata: { version: "1.0" } });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe("sess_1");
    expect(res.body.agentId).toBe(TEST_AGENT.id);
    expect(mgr.createSession).toHaveBeenCalledWith(TEST_AGENT.id, { version: "1.0" });
  });

  it("rejects oversized metadata", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const bigMetadata: Record<string, string> = {};
    for (let i = 0; i < 200; i++) bigMetadata[`key${i}`] = "x".repeat(50);

    const res = await request(app)
      .post("/v1/runtime/connect")
      .set(authHeader())
      .send({ metadata: bigMetadata });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("8KB");
  });

  it("returns 500 on service error", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    mgr.createSession.mockRejectedValue(new Error("DB fail"));
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/runtime/connect")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(500);
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).post("/v1/runtime/connect").send({});

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/runtime/disconnect
// ---------------------------------------------------------------------------

describe("POST /v1/runtime/disconnect", () => {
  it("disconnects specific session", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/runtime/disconnect")
      .set(authHeader())
      .send({ sessionId: "sess_1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mgr.disconnect).toHaveBeenCalledWith("sess_1", TEST_AGENT.id);
  });

  it("disconnects all sessions when no sessionId", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/runtime/disconnect")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(mgr.disconnectAgent).toHaveBeenCalledWith(TEST_AGENT.id);
  });

  it("returns 404 for unknown session", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    mgr.disconnect.mockResolvedValue(false);
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/runtime/disconnect")
      .set(authHeader())
      .send({ sessionId: "sess_unknown" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/runtime/status
// ---------------------------------------------------------------------------

describe("GET /v1/runtime/status", () => {
  it("returns status with active session", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    mgr.getActiveSession.mockResolvedValue({
      sessionId: "sess_1",
      connectedAt: new Date("2025-06-01T00:00:00.000Z"),
      lastHeartbeat: new Date("2025-06-01T00:01:00.000Z"),
    });
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app).get("/v1/runtime/status").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(TEST_AGENT.id);
    expect(res.body.session).not.toBeNull();
    expect(res.body.session.sessionId).toBe("sess_1");
  });

  it("returns status with no session", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).get("/v1/runtime/status").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/runtime/heartbeat
// ---------------------------------------------------------------------------

describe("POST /v1/runtime/heartbeat", () => {
  it("sends heartbeat successfully", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    mgr.getActiveSession.mockResolvedValue({
      sessionId: "sess_1",
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
    });
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app).post("/v1/runtime/heartbeat").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mgr.heartbeat).toHaveBeenCalledWith("sess_1");
  });

  it("returns 404 when no active session", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app).post("/v1/runtime/heartbeat").set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("No active session");
  });

  it("returns 404 when session expired", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    mgr.getActiveSession.mockResolvedValue({
      sessionId: "sess_expired",
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
    });
    mgr.heartbeat.mockResolvedValue(false);
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app).post("/v1/runtime/heartbeat").set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("expired");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/runtime/presence
// ---------------------------------------------------------------------------

describe("GET /v1/runtime/presence", () => {
  it("returns presence list", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    mgr.getPresence.mockResolvedValue([{ agentId: "agt_1", address: "0x1" }]);
    mgr.getActiveCount.mockResolvedValue(1);
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    const res = await request(app).get("/v1/runtime/presence").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(mgr.getPresence).toHaveBeenCalledWith(50, 0);
  });

  it("respects limit and offset", async () => {
    const pool = createMockPool();
    const mgr = createMockSessionManager();
    const { app } = buildApp(pool, mgr);
    setupAuth(pool);

    await request(app).get("/v1/runtime/presence?limit=10&offset=5").set(authHeader());

    expect(mgr.getPresence).toHaveBeenCalledWith(10, 5);
  });
});
