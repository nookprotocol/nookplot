import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createFilesRouter } from "./files.js";
import { hashApiKey } from "../auth.js";
import { createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";
import express from "express";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const mockAgent = createMockAgent({ api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  // Auth middleware: 1) agent lookup, 2) credit balance
  pool.query.mockResolvedValueOnce({ rows: [mockAgent], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

function createMockFileManager(overrides?: Record<string, unknown>) {
  return {
    listFiles: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(null),
    commitFiles: vi.fn().mockResolvedValue({
      commitId: "commit-001",
      message: "test commit",
      filesChanged: 1,
      linesAdded: 10,
      linesRemoved: 0,
    }),
    getAccessLevel: vi.fn().mockResolvedValue(3), // owner by default
    canCommit: vi.fn().mockResolvedValue({ allowed: true }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getCommitHistory: vi.fn().mockResolvedValue([]),
    getCommitDetail: vi.fn().mockResolvedValue(null),
    submitReview: vi.fn().mockResolvedValue({
      id: "rev-001",
      commitId: "commit-001",
      verdict: "approve",
      reviewerName: "Test Agent",
    }),
    getReviews: vi.fn().mockResolvedValue([]),
    consumeLinkedTasks: vi.fn().mockReturnValue([]),
    getProjectActivity: vi.fn().mockResolvedValue([]),
    getGlobalActivity: vi.fn().mockResolvedValue([]),
    exportToGithub: vi.fn().mockResolvedValue({ exported: true, repoUrl: "https://github.com/test/repo" }),
    ...overrides,
  };
}

function createMockGithubClient() {
  return {
    decryptPAT: vi.fn().mockReturnValue("ghp_decrypted"),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  opts?: {
    fileManager?: ReturnType<typeof createMockFileManager>;
    githubClient?: ReturnType<typeof createMockGithubClient>;
  },
) {
  const app = express();
  app.use(express.json());
  const fm = opts?.fileManager ?? createMockFileManager();
  const ghClient = opts?.githubClient ?? createMockGithubClient();
  const router = createFilesRouter(
    pool as any,
    {} as any, // sdkConfig — unused
    ghClient as any,
    TEST_HMAC_SECRET,
    fm as any,
  );
  app.use("/v1", router);
  return { app, fileManager: fm };
}

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/gateway-files — List files
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/gateway-files", () => {
  it("lists files for a project", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      listFiles: vi.fn().mockResolvedValue([
        { path: "README.md", size: 100 },
        { path: "src/index.ts", size: 200 },
      ]),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/gateway-files")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(fileManager.listFiles).toHaveBeenCalledWith("proj-1");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/gateway-files/* — Read file
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/gateway-files/*", () => {
  it("reads a file", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      readFile: vi.fn().mockResolvedValue({ path: "src/main.ts", content: "console.log('hello');" }),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/gateway-files/src/main.ts")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("console.log('hello');");
    expect(fileManager.readFile).toHaveBeenCalledWith("proj-1", "src/main.ts");
  });

  it("returns 404 when file not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/gateway-files/nonexistent.txt")
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/gateway-commit — Commit files
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/gateway-commit", () => {
  it("commits files successfully", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);
    // broadcastToProjectMembers query (after commit) + projDesc query
    pool.query.mockResolvedValueOnce({ rows: [{ description: "test project" }] });
    pool.query.mockResolvedValueOnce({ rows: [] }); // broadcastToProjectMembers

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({
        files: [{ path: "index.ts", content: "export default {}" }],
        message: "Initial commit",
      });

    expect(res.status).toBe(201);
    expect(res.body.commitId).toBe("commit-001");
    expect(fileManager.commitFiles).toHaveBeenCalled();
  });

  it("rejects empty files array", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({ files: [], message: "empty" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("files array");
  });

  it("rejects missing message", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({ files: [{ path: "a.txt", content: "x" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("message");
  });

  it("rejects viewer access (level 0)", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      canCommit: vi.fn().mockResolvedValue({ allowed: false, reason: "Viewers cannot commit files" }),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({
        files: [{ path: "a.txt", content: "x" }],
        message: "try commit",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Viewers");
  });

  it("returns 404 for project not found (access -1)", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      canCommit: vi.fn().mockResolvedValue({ allowed: false, reason: "Project not found" }),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({
        files: [{ path: "a.txt", content: "x" }],
        message: "try commit",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 400 for secret detected in commit", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      commitFiles: vi.fn().mockRejectedValue(new Error("Secret detected: AWS key found")),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({
        files: [{ path: "config.ts", content: "AKIA..." }],
        message: "add config",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Secret detected");
  });

  it("rejects file with non-string content", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/gateway-commit")
      .set(authHeader())
      .send({
        files: [{ path: "a.txt", content: 123 }],
        message: "bad content",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content must be a string");
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/projects/:id/gateway-files/*
// ---------------------------------------------------------------------------

describe("DELETE /v1/projects/:id/gateway-files/*", () => {
  it("deletes a file", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/projects/proj-1/gateway-files/old-file.txt")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.path).toBe("old-file.txt");
  });

  it("rejects insufficient access", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getAccessLevel: vi.fn().mockResolvedValue(0),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/projects/proj-1/gateway-files/file.txt")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Insufficient access");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/commits — Commit history
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/commits", () => {
  it("returns commit history", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getCommitHistory: vi.fn().mockResolvedValue([
        { id: "c1", message: "first", author: "0x1111", createdAt: "2025-01-01" },
      ]),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/commits")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.commits).toHaveLength(1);
    expect(fileManager.getCommitHistory).toHaveBeenCalledWith("proj-1", 20, 0);
  });

  it("respects limit and offset query params", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    await request(app)
      .get("/v1/projects/proj-1/commits?limit=5&offset=10")
      .set(authHeader());

    expect(fileManager.getCommitHistory).toHaveBeenCalledWith("proj-1", 5, 10);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/commits/:commitId — Commit detail
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/commits/:commitId", () => {
  it("returns commit detail", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getCommitDetail: vi.fn().mockResolvedValue({
        id: "commit-001",
        message: "test",
        files: [{ path: "a.ts", diff: "+line" }],
      }),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/commits/commit-001")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("commit-001");
  });

  it("returns 404 for unknown commit", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/commits/unknown-commit")
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/commits/:commitId/review — Submit review
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/commits/:commitId/review", () => {
  it("submits a review", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/review")
      .set(authHeader())
      .send({ verdict: "approve", body: "Looks good!" });

    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe("approve");
    expect(fileManager.submitReview).toHaveBeenCalledWith(
      "commit-001",
      mockAgent.id,
      mockAgent.address,
      "approve",
      "Looks good!",
    );
  });

  it("rejects missing verdict", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/review")
      .set(authHeader())
      .send({ body: "no verdict" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("verdict");
  });

  it("returns 400 when review errors with known message", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      submitReview: vi.fn().mockRejectedValue(new Error("Commit not found")),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/review")
      .set(authHeader())
      .send({ verdict: "approve" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/commits/:commitId/reviews — List reviews
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/commits/:commitId/reviews", () => {
  it("lists reviews for a commit", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getReviews: vi.fn().mockResolvedValue([
        { id: "rev-1", verdict: "approve", reviewer: "0x1111" },
      ]),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/commits/commit-001/reviews")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/commits/:cid/comments — List comments
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/commits/:cid/comments", () => {
  it("lists review comments grouped by file", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    // Comments query
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "cmt-1",
          file_path: "src/main.ts",
          line_start: 10,
          line_end: 12,
          body: "Fix this",
          suggestion: "const x = 1;",
          suggestion_applied: false,
          resolved: false,
          created_at: new Date("2025-06-01"),
          author_address: "0x1111",
          author_name: "Agent A",
          review_id: "rev-1",
          resolved_by_name: null,
        },
        {
          id: "cmt-2",
          file_path: "src/main.ts",
          line_start: 20,
          line_end: null,
          body: "Nice work",
          suggestion: null,
          suggestion_applied: false,
          resolved: false,
          created_at: new Date("2025-06-02"),
          author_address: "0x2222",
          author_name: "Agent B",
          review_id: "rev-1",
          resolved_by_name: null,
        },
      ],
      rowCount: 2,
    });

    const res = await request(app)
      .get("/v1/projects/proj-1/commits/commit-001/comments")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.byFile["src/main.ts"]).toHaveLength(2);
    expect(res.body.comments[0].filePath).toBe("src/main.ts");
    expect(res.body.comments[0].suggestion).toBe("const x = 1;");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/commits/:cid/comments — Add comment
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/commits/:cid/comments", () => {
  it("adds a review comment", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);
    // INSERT comment
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "cmt-new", created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });
    // Notification queries (non-fatal, can fail)
    pool.query.mockResolvedValueOnce({ rows: [{ author_id: "agt_other", project_id: "proj-1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ name: "Test Project" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/comments")
      .set(authHeader())
      .send({
        filePath: "src/main.ts",
        lineStart: 5,
        lineEnd: 7,
        body: "Consider refactoring this",
        suggestion: "const result = compute();",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("cmt-new");
    expect(res.body.filePath).toBe("src/main.ts");
    expect(res.body.body).toBe("Consider refactoring this");
    expect(res.body.suggestion).toBe("const result = compute();");
  });

  it("rejects missing filePath", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/comments")
      .set(authHeader())
      .send({ body: "No file path" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("filePath");
  });

  it("rejects missing body", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/comments")
      .set(authHeader())
      .send({ filePath: "test.ts" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("body");
  });
});

// ---------------------------------------------------------------------------
//  PATCH /v1/projects/:id/commits/:cid/comments/:rid — Resolve
// ---------------------------------------------------------------------------

describe("PATCH /v1/projects/:id/commits/:cid/comments/:rid", () => {
  it("resolves a comment by author", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);
    // SELECT comment author
    pool.query.mockResolvedValueOnce({
      rows: [{ author_id: mockAgent.id }],
      rowCount: 1,
    });
    // UPDATE resolved
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "cmt-1", resolved: true }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/v1/projects/proj-1/commits/commit-001/comments/cmt-1")
      .set(authHeader())
      .send({ resolved: true });

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
  });

  it("returns 404 for comment not found", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);
    // SELECT returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/v1/projects/proj-1/commits/commit-001/comments/missing")
      .set(authHeader())
      .send({ resolved: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("rejects non-author with insufficient access", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getAccessLevel: vi.fn().mockResolvedValue(1), // editor, not admin
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);
    // Comment belongs to different author
    pool.query.mockResolvedValueOnce({
      rows: [{ author_id: "agt_other" }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/v1/projects/proj-1/commits/commit-001/comments/cmt-1")
      .set(authHeader())
      .send({ resolved: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only comment author");
  });

  it("rejects missing resolved boolean", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .patch("/v1/projects/proj-1/commits/commit-001/comments/cmt-1")
      .set(authHeader())
      .send({ resolved: "yes" }); // not a boolean

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("resolved");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/commits/:cid/apply-suggestion
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/commits/:cid/apply-suggestion", () => {
  it("applies a suggestion successfully", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      readFile: vi.fn().mockResolvedValue({ path: "src/main.ts", content: "line1\nline2\nline3" }),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);
    // SELECT comment with suggestion
    pool.query.mockResolvedValueOnce({
      rows: [{
        file_path: "src/main.ts",
        line_start: 2,
        line_end: 2,
        suggestion: "newline2",
      }],
      rowCount: 1,
    });
    // UPDATE suggestion_applied
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // broadcastToProjectMembers query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/apply-suggestion")
      .set(authHeader())
      .send({ commentId: "cmt-1" });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.commitId).toBe("commit-001");
  });

  it("rejects missing commentId", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/apply-suggestion")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("commentId");
  });

  it("rejects insufficient access (viewer)", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getAccessLevel: vi.fn().mockResolvedValue(0),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/commits/commit-001/apply-suggestion")
      .set(authHeader())
      .send({ commentId: "cmt-1" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Editor role");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/activity — Project activity
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/activity", () => {
  it("returns project activity feed", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getProjectActivity: vi.fn().mockResolvedValue([
        { eventType: "files_committed", actorAddress: "0x1111" },
      ]),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/activity")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/export-github
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/export-github", () => {
  it("exports project to GitHub", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);
    // broadcastToProjectMembers
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/export-github")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.exported).toBe(true);
  });

  it("returns 403 when not connected", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      exportToGithub: vi.fn().mockRejectedValue(new Error("GitHub not connected")),
    });
    const { app } = buildApp(pool, { fileManager });

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/export-github")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("not connected");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/activity — Global activity (public endpoint)
// ---------------------------------------------------------------------------

describe("GET /v1/activity", () => {
  it("returns global activity without auth", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager({
      getGlobalActivity: vi.fn().mockResolvedValue([
        { eventType: "files_committed", projectId: "proj-1" },
        { eventType: "review_submitted", projectId: "proj-2" },
      ]),
    });
    const { app } = buildApp(pool, { fileManager });

    // No auth needed — public endpoint
    const res = await request(app).get("/v1/activity");

    expect(res.status).toBe(200);
    expect(res.body.activity).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(fileManager.getGlobalActivity).toHaveBeenCalledWith(20);
  });

  it("respects limit query param", async () => {
    const pool = createMockPool();
    const fileManager = createMockFileManager();
    const { app } = buildApp(pool, { fileManager });

    await request(app).get("/v1/activity?limit=5");

    expect(fileManager.getGlobalActivity).toHaveBeenCalledWith(5);
  });
});
