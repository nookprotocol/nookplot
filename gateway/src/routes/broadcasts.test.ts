import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createBroadcastsRouter } from "./broadcasts.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_bc", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockFileManager() {
  return {
    getAccessLevel: vi.fn().mockResolvedValue(1), // editor by default
  };
}

function createMockBroadcaster() {
  return {
    broadcast: vi.fn(),
  };
}

function createMockProactiveScheduler() {
  return {
    handleReactiveSignal: vi.fn().mockResolvedValue(undefined),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  fm?: ReturnType<typeof createMockFileManager>,
  broadcaster?: ReturnType<typeof createMockBroadcaster>,
  scheduler?: ReturnType<typeof createMockProactiveScheduler>,
) {
  const fileManager = fm ?? createMockFileManager();
  const b = broadcaster ?? createMockBroadcaster();
  const s = scheduler ?? createMockProactiveScheduler();
  const router = createBroadcastsRouter(pool as any, TEST_HMAC_SECRET, fileManager as any, b as any, s as any);
  return { app: createTestApp(router), fileManager, broadcaster: b, scheduler: s };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/broadcasts
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/broadcasts", () => {
  it("creates a broadcast", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Insert broadcast
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, created_at: new Date("2025-06-01T00:00:00.000Z") }],
      rowCount: 1,
    });
    // broadcastToProjectMembers query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Activity log: project name query
    pool.query.mockResolvedValueOnce({ rows: [{ name: "Test Project" }], rowCount: 1 });
    // Activity log insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/broadcasts")
      .set(authHeader())
      .send({ body: "Hello world", type: "update" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(res.body.body).toBe("Hello world");
    expect(res.body.type).toBe("update");
  });

  it("rejects missing body", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/broadcasts")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("body");
  });

  it("rejects body exceeding 2000 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/broadcasts")
      .set(authHeader())
      .send({ body: "x".repeat(2001) });

    expect(res.status).toBe(400);
  });

  it("returns 403 for viewer (access < 1)", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(0); // viewer
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/broadcasts")
      .set(authHeader())
      .send({ body: "Hello" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Editor");
  });

  it("allows owner (access = 3)", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(3); // owner
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 2, created_at: new Date() }],
      rowCount: 1,
    });
    // broadcastToProjectMembers
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [{ name: "P" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/broadcasts")
      .set(authHeader())
      .send({ body: "Owner broadcast" });

    expect(res.status).toBe(201);
  });

  it("parses @mentions from body", async () => {
    const pool = createMockPool();
    const scheduler = createMockProactiveScheduler();
    const { app } = buildApp(pool, undefined, undefined, scheduler);
    setupAuth(pool);
    // Insert broadcast
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 3, created_at: new Date() }],
      rowCount: 1,
    });
    // broadcastToProjectMembers
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // getProjectMemberIds
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Agent lookup for mention
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_mentioned" }],
      rowCount: 1,
    });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [{ name: "P" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mentionAddr = "0x" + "a".repeat(40);
    const res = await request(app)
      .post("/v1/projects/proj-1/broadcasts")
      .set(authHeader())
      .send({ body: `Hey @${mentionAddr} check this out` });

    expect(res.status).toBe(201);
    expect(res.body.mentions).toContain(mentionAddr.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/broadcasts
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/broadcasts", () => {
  it("returns broadcasts list", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Project existence check
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, type: "update", body: "Hello", mentions: null, metadata: null,
        author_address: "0x1", author_name: "Agent1", created_at: new Date(),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj-1/broadcasts")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.broadcasts).toHaveLength(1);
    expect(res.body.broadcasts[0].body).toBe("Hello");
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Project does not exist
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj-1/broadcasts")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("respects limit and offset", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Project existence check
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj-1/broadcasts?limit=10&offset=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  PUT /v1/projects/:id/status
// ---------------------------------------------------------------------------

describe("PUT /v1/projects/:id/status", () => {
  it("sets working status", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(0); // any collaborator
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Upsert status
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // broadcastToProjectMembers
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Proactive scheduler member query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .put("/v1/projects/proj-1/status")
      .set(authHeader())
      .send({ status: "Working on feature X" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.status).toBe("Working on feature X");
  });

  it("rejects missing status", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/projects/proj-1/status")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("rejects status exceeding 200 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/projects/proj-1/status")
      .set(authHeader())
      .send({ status: "x".repeat(201) });

    expect(res.status).toBe(400);
  });

  it("returns 403 for non-collaborator", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(-1); // no access
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .put("/v1/projects/proj-1/status")
      .set(authHeader())
      .send({ status: "Working" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/status
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/status", () => {
  it("returns collaborator statuses", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Project existence check
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{
        status: "Working", updated_at: new Date(),
        address: "0x1111", display_name: "Agent 1",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj-1/status")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.statuses).toHaveLength(1);
    expect(res.body.statuses[0].status).toBe("Working");
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Project does not exist
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj-1/status")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/mentions
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/mentions", () => {
  it("returns mentions for current agent", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, project_id: "proj-1", body: "Hey @you",
        type: "update", created_at: new Date(),
        author_address: "0x2222", author_name: "Agent 2",
        project_name: "Test Project",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/agents/me/mentions")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.mentions).toHaveLength(1);
    expect(res.body.mentions[0].projectId).toBe("proj-1");
  });

  it("respects limit param", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/agents/me/mentions?limit=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    // Check the query used the limit
    const lastCall = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastCall[1]).toContain(5);
  });
});
