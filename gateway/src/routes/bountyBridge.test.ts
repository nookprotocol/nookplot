import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createBountyBridgeRouter } from "./bountyBridge.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ethers mock for any address validation
vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_bounty", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockFileManager(accessLevel = 3) {
  return {
    getAccessLevel: vi.fn().mockResolvedValue(accessLevel),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  fileManager?: ReturnType<typeof createMockFileManager>,
) {
  const fm = fileManager ?? createMockFileManager();
  const router = createBountyBridgeRouter(pool as any, TEST_HMAC_SECRET, fm as any);
  return { app: createTestApp(router), fm };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/bounties — Create bounty
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/bounties", () => {
  it("creates a bounty linked to project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Inherit tags from project (no rawTags in body → SELECT tags FROM projects)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT bounty
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });
    // getProjectName
    pool.query.mockResolvedValueOnce({
      rows: [{ name: "Test Project" }],
      rowCount: 1,
    });
    // Activity log INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties")
      .set(authHeader())
      .send({ title: "Fix bug", onchainBountyId: 7, description: "Fix it" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    expect(res.body.title).toBe("Fix bug");
    expect(res.body.onchainBountyId).toBe(7);
    expect(res.body.status).toBe("open");
  });

  it("rejects missing title", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties")
      .set(authHeader())
      .send({ onchainBountyId: 7 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("title");
  });

  it("rejects missing onchainBountyId", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties")
      .set(authHeader())
      .send({ title: "Test Bounty" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("onchainBountyId");
  });

  it("rejects non-admin users (access < 2)", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(1); // viewer
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties")
      .set(authHeader())
      .send({ title: "Test", onchainBountyId: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Admin");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/bounties — List project bounties
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/bounties", () => {
  it("returns bounties for a project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, project_id: "proj-1", task_id: null, milestone_id: null,
        onchain_bounty_id: 5, title: "Bounty 1", description: "desc",
        creator_address: "0xaaa", creator_name: "Alice",
        claimer_address: null, claimer_name: null,
        status: "open", reward_amount: "100", metadata_cid: null,
        task_title: null, milestone_title: null,
        synced_at: new Date(), created_at: new Date(), updated_at: new Date(),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj-1/bounties");

    expect(res.status).toBe(200);
    expect(res.body.bounties).toHaveLength(1);
    expect(res.body.bounties[0].title).toBe("Bounty 1");
    expect(res.body.limit).toBe(50);
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project does not exist (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj-1/bounties");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/bounties/access-requests — List pending (admin+)
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/bounties/access-requests", () => {
  it("returns access requests for admin", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "req-1", project_bounty_id: 1, requester_address: "0xbbb",
        status: "pending", message: "I can help", created_at: new Date(),
        resolved_at: null, requester_name: "Bob", bounty_title: "Fix bug",
        onchain_bounty_id: 5,
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj-1/bounties/access-requests")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].requesterAddress).toBe("0xbbb");
  });

  it("rejects non-admin users", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/projects/proj-1/bounties/access-requests")
      .set(authHeader());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/bounties/:bid — Bounty detail
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/bounties/:bid", () => {
  it("returns bounty with access requests", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });

    // Bounty query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, project_id: "proj-1", task_id: null, milestone_id: null,
        onchain_bounty_id: 5, title: "Fix bug", description: "Fix it",
        creator_address: "0xaaa", creator_name: "Alice",
        claimer_address: null, claimer_name: null,
        status: "open", reward_amount: "100", metadata_cid: null,
        task_title: null, task_status: null, milestone_title: null,
        synced_at: new Date(), created_at: new Date(), updated_at: new Date(),
      }],
      rowCount: 1,
    });
    // Access requests query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "req-1", requester_address: "0xbbb",
        requester_name: "Bob", status: "pending",
        message: "I can help", created_at: new Date(),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects/proj-1/bounties/1");

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Fix bug");
    expect(res.body.accessRequests).toHaveLength(1);
    expect(res.body.accessRequests[0].requesterAddress).toBe("0xbbb");
  });

  it("returns 404 for nonexistent bounty", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project existence check (public endpoint — no auth)
    pool.query.mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 });
    // Bounty query returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/projects/proj-1/bounties/999");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/bounties/:bid/request-access — Request access
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/bounties/:bid/request-access", () => {
  it("creates an access request", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(-1); // no existing access
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    // Bounty exists
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: "Fix bug", onchain_bounty_id: 5 }],
      rowCount: 1,
    });
    // No existing pending request (duplicate check)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT access request
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-new", created_at: new Date("2025-06-01") }],
      rowCount: 1,
    });
    // getProjectName
    pool.query.mockResolvedValueOnce({
      rows: [{ name: "My Project" }],
      rowCount: 1,
    });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/request-access")
      .set(authHeader())
      .send({ message: "I want to help" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("req-new");
    expect(res.body.status).toBe("pending");
  });

  it("rejects if already a project member", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(0); // has access (viewer)
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    // Bounty exists
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: "Fix bug", onchain_bounty_id: 5 }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/request-access")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already have access");
  });

  it("rejects duplicate pending request", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(-1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    // Bounty exists
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: "Fix bug", onchain_bounty_id: 5 }],
      rowCount: 1,
    });
    // Existing pending request
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-existing" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/request-access")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("pending request");
  });

  it("returns 404 for nonexistent bounty", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(-1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    // Bounty not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/999/request-access")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/bounties/:bid/grant-access — Grant access (admin+)
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/bounties/:bid/grant-access", () => {
  it("grants access to a requester", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Find pending request by ID
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-1", requester_id: "agt_other", requester_address: "0xbbb" }],
      rowCount: 1,
    });
    // Update request status
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Get project row ID
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 10 }],
      rowCount: 1,
    });
    // INSERT collaborator
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Fetch bounty title
    pool.query.mockResolvedValueOnce({
      rows: [{ title: "Fix bug" }],
      rowCount: 1,
    });
    // getProjectName
    pool.query.mockResolvedValueOnce({
      rows: [{ name: "My Project" }],
      rowCount: 1,
    });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/grant-access")
      .set(authHeader())
      .send({ requestId: "req-1" });

    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(true);
    expect(res.body.requestId).toBe("req-1");
  });

  it("rejects non-admin users", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/grant-access")
      .set(authHeader())
      .send({ requestId: "req-1" });

    expect(res.status).toBe(403);
  });

  it("returns 404 when no pending request found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // No pending request
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/grant-access")
      .set(authHeader())
      .send({ requestId: "req-missing" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/bounties/:bid/deny-access — Deny access (admin+)
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/bounties/:bid/deny-access", () => {
  it("denies an access request", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Find pending request by ID
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-1" }],
      rowCount: 1,
    });
    // Update status to denied
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // getProjectName
    pool.query.mockResolvedValueOnce({
      rows: [{ name: "My Project" }],
      rowCount: 1,
    });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Requester address lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ requester_address: "0xbbb" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/deny-access")
      .set(authHeader())
      .send({ requestId: "req-1" });

    expect(res.status).toBe(200);
    expect(res.body.denied).toBe(true);
    expect(res.body.requestId).toBe("req-1");
  });

  it("rejects non-admin users", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/deny-access")
      .set(authHeader())
      .send({ requestId: "req-1" });

    expect(res.status).toBe(403);
  });

  it("returns 404 when no pending request found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/deny-access")
      .set(authHeader())
      .send({ requestId: "req-missing" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/bounties/:bid/sync — Sync on-chain status
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/bounties/:bid/sync", () => {
  it("syncs bounty status from on-chain data", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(0); // at least viewer
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    // Fetch bridge row
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, onchain_bounty_id: 5, status: "open", claimer_address: null,
        claimer_id: null, reward_amount: "100", task_id: null,
        title: "Fix bug", task_milestone_id: null, milestone_id: null,
      }],
      rowCount: 1,
    });
    // Query idx_bounties for on-chain status
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "5", status: 0, claimer: null, reward_amount: "100" }],
      rowCount: 1,
    });
    // UPDATE bridge row
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // getProjectName
    pool.query.mockResolvedValueOnce({
      rows: [{ name: "My Project" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/sync")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(true);
    expect(res.body.currentStatus).toBe("open");
  });

  it("rejects non-collaborators", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(-1);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/1/sync")
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("returns 404 for nonexistent bounty", async () => {
    const pool = createMockPool();
    const fm = createMockFileManager(0);
    const { app } = buildApp(pool, fm);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/proj-1/bounties/999/sync")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/bounty-requests — My access requests
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/bounty-requests", () => {
  it("returns agent's bounty access requests", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "req-1", project_bounty_id: 1, project_id: "proj-1",
        status: "pending", message: "I can help",
        created_at: new Date(), resolved_at: null,
        bounty_title: "Fix bug", onchain_bounty_id: 5,
        reward_amount: "100", bounty_status: "open",
        project_name: "My Project",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/agents/me/bounty-requests")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].bountyTitle).toBe("Fix bug");
    expect(res.body.requests[0].projectName).toBe("My Project");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/project-bounties — Global list
// ---------------------------------------------------------------------------

describe("GET /v1/project-bounties", () => {
  it("returns all project-linked bounties", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, project_id: "proj-1", task_id: null, milestone_id: null,
        onchain_bounty_id: 5, title: "Global Bounty", description: "desc",
        creator_address: "0xaaa", creator_name: "Alice",
        claimer_address: null, claimer_name: null,
        status: "open", reward_amount: "100", metadata_cid: null,
        task_title: null, milestone_title: null, project_name: "My Project",
        synced_at: new Date(), created_at: new Date(), updated_at: new Date(),
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/project-bounties");

    expect(res.status).toBe(200);
    expect(res.body.bounties).toHaveLength(1);
    expect(res.body.bounties[0].title).toBe("Global Bounty");
    expect(res.body.bounties[0].projectName).toBe("My Project");
    expect(res.body.limit).toBe(50);
  });

  it("filters by status parameter", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/project-bounties?status=claimed");

    expect(res.status).toBe(200);
    const queryStr = pool.query.mock.calls[0][0];
    expect(queryStr).toContain("pb.status = $");
  });
});
