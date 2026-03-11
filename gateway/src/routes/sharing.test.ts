import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createSharingRouter } from "./sharing.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_sh", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockFileManager() {
  return {
    getAccessLevel: vi.fn().mockResolvedValue(1), // editor
    readFile: vi.fn().mockResolvedValue({ content: "hello", language: "text" }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  fm?: ReturnType<typeof createMockFileManager>,
) {
  const fileManager = fm ?? createMockFileManager();
  const router = createSharingRouter(pool as any, TEST_HMAC_SECRET, fileManager as any);
  return { app: createTestApp(router), fileManager };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/share
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/share", () => {
  it("creates a share link", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Insert share
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, created_at: new Date("2025-06-01T00:00:00.000Z") }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/share")
      .set(authHeader())
      .send({ filePath: "src/index.ts" });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.url).toContain("/v1/shared/");
    expect(res.body.filePath).toBe("src/index.ts");
  });

  it("rejects missing filePath", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/share")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("filePath");
  });

  it("returns 403 for viewer access", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(0);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/share")
      .set(authHeader())
      .send({ filePath: "src/index.ts" });

    expect(res.status).toBe(403);
  });

  it("allows owner access (level 3)", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(3);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 2, created_at: new Date() }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/share")
      .set(authHeader())
      .send({ filePath: "src/index.ts" });

    expect(res.status).toBe(201);
  });

  it("returns 404 when file not found", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.readFile.mockResolvedValue(null);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/share")
      .set(authHeader())
      .send({ filePath: "nonexistent.ts" });

    expect(res.status).toBe(404);
  });

  it("resolves sharedWithAddress to agent ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Agent lookup for sharedWithAddress
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_other" }], rowCount: 1 });
    // Insert share
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 3, created_at: new Date() }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/share")
      .set(authHeader())
      .send({ filePath: "src/index.ts", sharedWithAddress: "0x" + "b".repeat(40) });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/shared/:token — Access shared file (public)
// ---------------------------------------------------------------------------

describe("GET /v1/shared/:token", () => {
  it("returns shared file content", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // File join query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, file_path: "src/index.ts", content: "hello", language: "typescript",
        size_bytes: 5, project_id: "proj-1", expires_at: null,
        max_access: null, access_count: 0,
      }],
      rowCount: 1,
    });
    // Increment access count
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).get("/v1/shared/abc123token");

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("hello");
    expect(res.body.accessCount).toBe(1);
  });

  it("returns 404 for invalid token", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/shared/badtoken");

    expect(res.status).toBe(404);
  });

  it("returns 410 when expired", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, file_path: "test.ts", content: "x", expires_at: "2020-01-01T00:00:00Z",
        max_access: null, access_count: 0,
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/shared/expiredtoken");

    expect(res.status).toBe(410);
    expect(res.body.error).toContain("expired");
  });

  it("returns 410 when max access reached", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, file_path: "test.ts", content: "x", expires_at: null,
        max_access: 3, access_count: 3,
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/shared/maxedtoken");

    expect(res.status).toBe(410);
    expect(res.body.error).toContain("Maximum access");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/shared-files
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/shared-files", () => {
  it("returns files shared with current agent", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, token: "tok1", project_id: "proj-1", file_path: "src/index.ts",
        expires_at: null, access_count: 2, max_access: null,
        created_at: new Date(), shared_by_address: "0x1111", shared_by_name: "Agent1",
        project_name: "Test Project",
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/agents/me/shared-files").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.sharedFiles).toHaveLength(1);
    expect(res.body.sharedFiles[0].filePath).toBe("src/index.ts");
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/projects/:id/share/:token — Revoke
// ---------------------------------------------------------------------------

describe("DELETE /v1/projects/:id/share/:token", () => {
  it("revokes share link by sharer", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Lookup share
    pool.query.mockResolvedValueOnce({ rows: [{ shared_by: TEST_AGENT.id }], rowCount: 1 });
    // Delete
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .delete("/v1/projects/proj-1/share/tok1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  it("returns 404 for unknown token", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .delete("/v1/projects/proj-1/share/missing")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("returns 403 when not sharer and low access", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(1); // editor, not admin (< 2)
    const { app } = buildApp(pool, fm);
    setupAuth(pool);
    // Share by another agent
    pool.query.mockResolvedValueOnce({ rows: [{ shared_by: "agt_other" }], rowCount: 1 });

    const res = await request(app)
      .delete("/v1/projects/proj-1/share/tok1")
      .set(authHeader());

    expect(res.status).toBe(403);
  });
});
