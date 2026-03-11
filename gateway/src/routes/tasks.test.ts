import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createTasksRouter } from "./tasks.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_tasks", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

/** Valid UUIDs for route params (route validates UUID format) */
const MS_ID = "a0000000-0000-4000-8000-000000000001";
const MS_MISSING = "a0000000-0000-4000-8000-ffffffffffff";
const TASK_ID = "b0000000-0000-4000-8000-000000000001";
const TASK_MISSING = "b0000000-0000-4000-8000-ffffffffffff";

function createMockFileManager() {
  return {
    getAccessLevel: vi.fn().mockResolvedValue(3), // owner by default
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  fm?: ReturnType<typeof createMockFileManager>,
) {
  const fileManager = fm ?? createMockFileManager();
  const router = createTasksRouter(pool as any, TEST_HMAC_SECRET, fileManager as any);
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
//  POST /v1/projects/:id/milestones — Create milestone
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/milestones", () => {
  it("creates a milestone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // INSERT milestone
    pool.query.mockResolvedValueOnce({
      rows: [{ id: MS_ID, status: "open", created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj_1/milestones")
      .set(authHeader())
      .send({ title: "v1.0 Release", description: "First release" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(MS_ID);
    expect(res.body.title).toBe("v1.0 Release");
    expect(res.body.status).toBe("open");
  });

  it("rejects missing title", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj_1/milestones")
      .set(authHeader())
      .send({ description: "No title" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("title");
  });

  it("rejects title exceeding 200 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj_1/milestones")
      .set(authHeader())
      .send({ title: "x".repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("title");
  });

  it("rejects insufficient access (viewer)", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(1); // editor, not admin
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj_1/milestones")
      .set(authHeader())
      .send({ title: "Milestone" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/milestones — List milestones
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/milestones", () => {
  it("returns milestones with progress", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: MS_ID, title: "v1.0", description: null, due_date: null,
        status: "open", completed_at: null, created_at: new Date("2025-06-01"),
        updated_at: new Date("2025-06-01"), total_tasks: "3", completed_tasks: "1",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj_1/milestones");

    expect(res.status).toBe(200);
    expect(res.body.milestones).toHaveLength(1);
    expect(res.body.milestones[0].totalTasks).toBe(3);
    expect(res.body.milestones[0].completedTasks).toBe(1);
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project does not exist (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj_1/milestones");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  PATCH /v1/projects/:id/milestones/:mid — Update milestone
// ---------------------------------------------------------------------------

describe("PATCH /v1/projects/:id/milestones/:mid", () => {
  it("updates milestone title", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: MS_ID, title: "Updated", description: null, due_date: null,
        status: "open", completed_at: null, updated_at: new Date("2025-06-02"),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch(`/v1/projects/proj_1/milestones/${MS_ID}`)
      .set(authHeader())
      .send({ title: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Updated");
  });

  it("returns 400 for empty update", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .patch(`/v1/projects/proj_1/milestones/${MS_ID}`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Nothing to update");
  });

  it("returns 404 for nonexistent milestone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch(`/v1/projects/proj_1/milestones/${MS_MISSING}`)
      .set(authHeader())
      .send({ title: "Updated" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/projects/:id/milestones/:mid — Delete milestone
// ---------------------------------------------------------------------------

describe("DELETE /v1/projects/:id/milestones/:mid", () => {
  it("deletes a milestone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .delete(`/v1/projects/proj_1/milestones/${MS_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 for nonexistent milestone", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .delete(`/v1/projects/proj_1/milestones/${MS_MISSING}`)
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("rejects insufficient access", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .delete(`/v1/projects/proj_1/milestones/${MS_ID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/tasks — Create task
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/tasks", () => {
  it("creates a task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // INSERT task
    pool.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, status: "open", created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });
    // getProjectName
    pool.query.mockResolvedValueOnce({ rows: [{ name: "MyProject" }], rowCount: 1 });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj_1/tasks")
      .set(authHeader())
      .send({ title: "Fix bug", priority: "high" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(TASK_ID);
    expect(res.body.priority).toBe("high");
  });

  it("defaults priority to medium", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, status: "open", created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [{ name: "Proj" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj_1/tasks")
      .set(authHeader())
      .send({ title: "Some task" });

    expect(res.status).toBe(201);
    expect(res.body.priority).toBe("medium");
  });

  it("rejects missing title", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj_1/tasks")
      .set(authHeader())
      .send({ priority: "low" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("title");
  });

  it("rejects title exceeding 300 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj_1/tasks")
      .set(authHeader())
      .send({ title: "t".repeat(301) });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/tasks — List tasks
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/tasks", () => {
  it("returns tasks list", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: TASK_ID, title: "Fix bug", description: null, status: "open",
        priority: "high", milestone_id: null, milestone_title: null,
        assigned_address: null, assignee_name: null, creator_address: "0x1111111111111111111111111111111111111111",
        creator_name: "Agent", linked_commit_id: null, labels: ["bug"],
        completed_at: null, created_at: new Date("2025-06-01"), updated_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj_1/tasks");

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].priority).toBe("high");
    expect(res.body.limit).toBe(50);
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project does not exist (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj_1/tasks");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/tasks/:tid — Task detail
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/tasks/:tid", () => {
  it("returns task with comments", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    // Task query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: TASK_ID, title: "Fix bug", description: "desc", status: "open",
        priority: "high", milestone_id: null, milestone_title: null,
        assigned_address: null, assignee_name: null, creator_address: "0x1111111111111111111111111111111111111111",
        creator_name: "Agent", linked_commit_id: null, labels: [],
        completed_at: null, created_at: new Date("2025-06-01"), updated_at: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });
    // Comments query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "c1", body: "Great work", author_address: "0x2222222222222222222222222222222222222222", author_name: "Bob", created_at: new Date() }],
      rowCount: 1,
    });

    const res = await request(app)
      .get(`/v1/projects/proj_1/tasks/${TASK_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Fix bug");
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].body).toBe("Great work");
  });

  it("returns 404 for nonexistent task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    // Task query returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get(`/v1/projects/proj_1/tasks/${TASK_MISSING}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  PATCH /v1/projects/:id/tasks/:tid — Update task
// ---------------------------------------------------------------------------

describe("PATCH /v1/projects/:id/tasks/:tid", () => {
  it("updates task status", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Task existence check
    pool.query.mockResolvedValueOnce({
      rows: [{ assigned_to: null, milestone_id: null }],
      rowCount: 1,
    });
    // UPDATE query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: TASK_ID, title: "Fix bug", status: "in_progress",
        priority: "high", milestone_id: null, completed_at: null,
        updated_at: new Date("2025-06-02"),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch(`/v1/projects/proj_1/tasks/${TASK_ID}`)
      .set(authHeader())
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("returns 400 for empty update", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Task existence check
    pool.query.mockResolvedValueOnce({
      rows: [{ assigned_to: null, milestone_id: null }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch(`/v1/projects/proj_1/tasks/${TASK_ID}`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch(`/v1/projects/proj_1/tasks/${TASK_MISSING}`)
      .set(authHeader())
      .send({ title: "Updated" });

    expect(res.status).toBe(404);
  });

  it("rejects insufficient access (non-assignee viewer)", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(0); // viewer
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    // Task check: assigned to different agent
    pool.query.mockResolvedValueOnce({
      rows: [{ assigned_to: "agt_other", milestone_id: null }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch(`/v1/projects/proj_1/tasks/${TASK_ID}`)
      .set(authHeader())
      .send({ status: "completed" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/projects/:id/tasks/:tid — Delete task
// ---------------------------------------------------------------------------

describe("DELETE /v1/projects/:id/tasks/:tid", () => {
  it("deletes a task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .delete(`/v1/projects/proj_1/tasks/${TASK_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 for nonexistent task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .delete(`/v1/projects/proj_1/tasks/${TASK_MISSING}`)
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("rejects insufficient access", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .delete(`/v1/projects/proj_1/tasks/${TASK_ID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/tasks/:tid/assign — Assign task
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/tasks/:tid/assign", () => {
  it("assigns a task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Resolve assignee address
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_assignee" }], rowCount: 1 });
    // UPDATE
    pool.query.mockResolvedValueOnce({
      rows: [{ id: TASK_ID, title: "Fix bug" }],
      rowCount: 1,
    });
    // getProjectName (for activity log)
    pool.query.mockResolvedValueOnce({ rows: [{ name: "MyProject" }], rowCount: 1 });
    // Activity log INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/assign`)
      .set(authHeader())
      .send({ assigneeAddress: "0x2222222222222222222222222222222222222222" });

    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(true);
    expect(res.body.title).toBe("Fix bug");
  });

  it("rejects missing assigneeAddress", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/assign`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("assigneeAddress");
  });

  it("rejects insufficient access", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(0); // viewer — below editor threshold (< 1)
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/assign`)
      .set(authHeader())
      .send({ assigneeAddress: "0x2222222222222222222222222222222222222222" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/tasks/:tid/comments — Add comment
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/tasks/:tid/comments", () => {
  it("adds a comment", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Task existence check
    pool.query.mockResolvedValueOnce({ rows: [{ id: TASK_ID }], rowCount: 1 });
    // INSERT comment
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "c_1", created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/comments`)
      .set(authHeader())
      .send({ body: "Looks good!" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("c_1");
    expect(res.body.body).toBe("Looks good!");
  });

  it("rejects missing body", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/comments`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("body");
  });

  it("rejects body exceeding 5000 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/comments`)
      .set(authHeader())
      .send({ body: "x".repeat(5001) });

    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent task", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_MISSING}/comments`)
      .set(authHeader())
      .send({ body: "Comment" });

    expect(res.status).toBe(404);
  });

  it("rejects no project access", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager();
    fm.getAccessLevel.mockResolvedValue(-1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post(`/v1/projects/proj_1/tasks/${TASK_ID}/comments`)
      .set(authHeader())
      .send({ body: "Comment" });

    expect(res.status).toBe(403);
  });
});
