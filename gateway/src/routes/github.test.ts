import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createGithubRouter } from "./github.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_gh", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} } as any;

function createMockGithubClient() {
  return {
    validatePAT: vi.fn().mockResolvedValue({ valid: true, username: "testuser", scopes: ["repo"] }),
    encryptPAT: vi.fn().mockReturnValue({ encryptedKey: "enc", iv: "iv", authTag: "tag" }),
    decryptPAT: vi.fn().mockReturnValue("ghp_decryptedtoken"),
    listFiles: vi.fn().mockResolvedValue([{ name: "README.md", type: "file" }]),
    readFile: vi.fn().mockResolvedValue({ name: "README.md", content: "# Hello" }),
    commitAndPush: vi.fn().mockResolvedValue({
      sha: "abc123",
      message: "test commit",
      url: "https://github.com/owner/repo/commit/abc123",
      filesChanged: 1,
    }),
    validateFilePath: vi.fn().mockReturnValue({ valid: true }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  ghClient?: ReturnType<typeof createMockGithubClient>,
) {
  const client = ghClient ?? createMockGithubClient();
  const router = createGithubRouter(pool as any, SDK_CONFIG, client as any, TEST_HMAC_SECRET);
  return { app: createTestApp(router), githubClient: client };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/github/connect
// ---------------------------------------------------------------------------

describe("POST /v1/github/connect", () => {
  it("connects GitHub with valid PAT", async () => {
    const pool = createMockPool();
    const ghClient = createMockGithubClient();
    const { app } = buildApp(pool, ghClient);
    setupAuth(pool);
    // Upsert query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/github/connect")
      .set(authHeader())
      .send({ pat: "ghp_" + "x".repeat(36) });

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.username).toBe("testuser");
    expect(ghClient.validatePAT).toHaveBeenCalled();
    expect(ghClient.encryptPAT).toHaveBeenCalled();
  });

  it("rejects invalid PAT", async () => {
    const pool = createMockPool();
    const ghClient = createMockGithubClient();
    ghClient.validatePAT.mockResolvedValue({ valid: false, username: null });
    const { app } = buildApp(pool, ghClient);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/github/connect")
      .set(authHeader())
      .send({ pat: "ghp_" + "x".repeat(36) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid GitHub PAT");
  });

  it("rejects missing pat field", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/github/connect")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
  });

  it("rejects pat too short", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/github/connect")
      .set(authHeader())
      .send({ pat: "short" });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/github/status
// ---------------------------------------------------------------------------

describe("GET /v1/github/status", () => {
  it("returns connected status", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Status query
    pool.query.mockResolvedValueOnce({
      rows: [{ github_username: "testuser", scopes: ["repo"], created_at: "2025-06-01", updated_at: "2025-06-01" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/github/status").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.username).toBe("testuser");
  });

  it("returns not connected", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/github/status").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/github/disconnect
// ---------------------------------------------------------------------------

describe("DELETE /v1/github/disconnect", () => {
  it("disconnects successfully", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/v1/github/disconnect").set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
  });

  it("returns 404 when not connected", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/v1/github/disconnect").set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/files
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/files", () => {
  it("lists files for a project", async () => {
    const pool = createMockPool();
    const ghClient = createMockGithubClient();
    const { app } = buildApp(pool, ghClient);
    setupAuth(pool);
    // getDecryptedPAT: credential lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag", github_username: "testuser" }],
      rowCount: 1,
    });
    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ repo_url: "https://github.com/owner/repo", default_branch: "main" }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/my-project/files")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(ghClient.listFiles).toHaveBeenCalledWith("ghp_decryptedtoken", "owner", "repo", "", "main");
  });

  it("returns 403 when GitHub not connected", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // No credentials
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/my-project/files")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("GitHub not connected");
  });

  it("returns 404 when project not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    // Credentials found
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag", github_username: "testuser" }],
      rowCount: 1,
    });
    // Project not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/missing-project/files")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("returns 400 when project has no repo", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag", github_username: "testuser" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ repo_url: null, default_branch: "main" }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/my-project/files")
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no linked GitHub");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/commit
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/commit", () => {
  it("commits and pushes files", async () => {
    const pool = createMockPool();
    const ghClient = createMockGithubClient();
    const { app } = buildApp(pool, ghClient);
    setupAuth(pool);
    // getDecryptedPAT
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag", github_username: "testuser" }],
      rowCount: 1,
    });
    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ repo_url: "https://github.com/owner/repo", default_branch: "main" }],
      rowCount: 1,
    });
    // commit_log insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/my-project/commit")
      .set(authHeader())
      .send({
        files: [{ path: "src/index.ts", content: "console.log('hello')" }],
        message: "test commit",
      });

    expect(res.status).toBe(201);
    expect(res.body.sha).toBe("abc123");
    expect(res.body.filesChanged).toBe(1);
    expect(ghClient.commitAndPush).toHaveBeenCalled();
  });

  it("returns 403 when GitHub not connected", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/my-project/commit")
      .set(authHeader())
      .send({
        files: [{ path: "test.txt", content: "hello" }],
        message: "commit",
      });

    expect(res.status).toBe(403);
  });

  it("returns 400 when secret detected in files", async () => {
    const pool = createMockPool();
    const ghClient = createMockGithubClient();
    ghClient.commitAndPush.mockRejectedValue(new Error("Secret detected in file: test.txt"));
    const { app } = buildApp(pool, ghClient);
    setupAuth(pool);
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_pat: "enc", pat_iv: "iv", pat_auth_tag: "tag", github_username: "testuser" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ repo_url: "https://github.com/owner/repo", default_branch: "main" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/my-project/commit")
      .set(authHeader())
      .send({
        files: [{ path: "test.txt", content: "AKIA1234567890ABCDEF" }],
        message: "commit",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Secret detected");
  });

  it("rejects missing files array", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/my-project/commit")
      .set(authHeader())
      .send({ message: "commit" });

    expect(res.status).toBe(400);
  });

  it("rejects empty files array", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/my-project/commit")
      .set(authHeader())
      .send({ files: [], message: "commit" });

    expect(res.status).toBe(400);
  });
});
