import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createBountiesRouter } from "./bounties.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../config.js", () => ({
  gatewayConfig: {
    ipfsReadGateway: "https://ipfs.example.com/ipfs",
  },
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ethers mock for validation middleware
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
const CREATOR_ADDR = "0x2222222222222222222222222222222222222222";
const APPLICANT_ADDR = "0x1111111111111111111111111111111111111111";
const TEST_AGENT = createMockAgent({ id: "agt_bounty", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest", address: APPLICANT_ADDR });

const CREATOR_API_KEY = "nk_" + "b".repeat(64);
const CREATOR_KEY_HASH = hashApiKey(CREATOR_API_KEY, TEST_HMAC_SECRET);
const CREATOR_AGENT = createMockAgent({ id: "agt_creator", api_key_hash: CREATOR_KEY_HASH, did_cid: "bafycreator", address: CREATOR_ADDR });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} } as any;

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createBountiesRouter(pool as any, SDK_CONFIG, TEST_HMAC_SECRET);
  return createTestApp(router);
}

function setupAuth(pool: ReturnType<typeof createMockPool>, agent = TEST_AGENT) {
  pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader(key = TEST_API_KEY) {
  return { Authorization: `Bearer ${key}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/bounties — List bounties (public)
// ---------------------------------------------------------------------------

describe("GET /v1/bounties", () => {
  it("returns paginated bounties", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "1",
        creator: "0xCreator",
        metadataCid: "bafybounty",
        community: "ai-research",
        rewardAmount: "1000000000000000",
        escrowType: "usdc",
        status: 0,
        claimer: null,
        deadline: "0",
        createdAt: "2025-06-01T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bounties");

    expect(res.status).toBe(200);
    expect(res.body.bounties).toHaveLength(1);
    expect(res.body.bounties[0].community).toBe("ai-research");
    expect(res.body.first).toBe(20);
    expect(res.body.skip).toBe(0);
  });

  it("filters by status", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/v1/bounties?status=1");

    // calls[0-1] are the two schema detection queries at construction (token_address + approved_claimer)
    const sql = pool.query.mock.calls[2][0] as string;
    expect(sql).toContain("status");
    const params = pool.query.mock.calls[2][1] as unknown[];
    expect(params[0]).toBe(1);
  });

  it("rejects invalid status", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/bounties?status=7");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("filters by community", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/v1/bounties?community=ai-research");

    const sql = pool.query.mock.calls[2][0] as string;
    expect(sql).toContain("community");
  });

  it("rejects too-long community parameter", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get(`/v1/bounties?community=${"x".repeat(129)}`);

    expect(res.status).toBe(400);
  });

  it("respects first and skip params", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/v1/bounties?first=10&skip=5");

    const params = pool.query.mock.calls[2][1] as unknown[];
    expect(params).toContain(10);
    expect(params).toContain(5);
  });

  it("clamps first to 100", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/v1/bounties?first=500");

    const params = pool.query.mock.calls[2][1] as unknown[];
    expect(params[0]).toBe(100);
  });

  it("returns 500 on query failure", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    pool.query.mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get("/v1/bounties");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/bounties/:id — Bounty detail
// ---------------------------------------------------------------------------

describe("GET /v1/bounties/:id", () => {
  it("returns bounty detail", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "1",
        creator: "0xCreator",
        metadataCid: "bafybounty",
        community: "ai-research",
        rewardAmount: "1000000000000000",
        status: 2,
        claimer: "0xClaimer",
        submissionCid: "bafysub",
        deadline: "0",
        createdAt: "2025-06-01T00:00:00.000Z",
        claimedAt: "2025-06-02T00:00:00.000Z",
        submittedAt: "2025-06-03T00:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bounties/1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(2);
    expect(res.body.claimer).toBe("0xClaimer");
  });

  it("rejects non-numeric ID", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/bounties/abc");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("number");
  });

  it("returns 404 when not found", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/bounties/999");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  410 Gone — Bounty write operations
// ---------------------------------------------------------------------------

describe("Bounties — 410 Gone", () => {
  it("POST /v1/bounties/:id/claim returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/bounties/1/claim")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
  });

  it("POST /v1/bounties/:id/unclaim returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/bounties/1/unclaim")
      .set(authHeader());

    expect(res.status).toBe(410);
  });

  it("POST /v1/bounties/:id/approve returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/bounties/1/approve")
      .set(authHeader());

    expect(res.status).toBe(410);
  });

  it("POST /v1/bounties/:id/dispute returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/bounties/1/dispute")
      .set(authHeader());

    expect(res.status).toBe(410);
  });

  it("POST /v1/bounties/:id/cancel returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/bounties/1/cancel")
      .set(authHeader());

    expect(res.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bounties/:id/apply — Apply to bounty
// ---------------------------------------------------------------------------

describe("POST /v1/bounties/:id/apply", () => {
  it("creates application for open bounty", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // getBountyStatus (status 0 = open)
    pool.query.mockResolvedValueOnce({ rows: [{ status: 0 }], rowCount: 1 });
    // getBountyCreator
    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });
    // INSERT application
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "app-uuid-1", status: "pending", createdAt: new Date().toISOString() }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/bounties/1/apply")
      .set(authHeader())
      .send({ message: "I can do this! I have extensive experience building similar tools and would deliver high-quality work." });

    expect(res.status).toBe(201);
    expect(res.body.application.id).toBe("app-uuid-1");
  });

  it("rejects self-application", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    // Auth as creator
    setupAuth(pool, CREATOR_AGENT);

    // getBountyStatus
    pool.query.mockResolvedValueOnce({ rows: [{ status: 0 }], rowCount: 1 });
    // getBountyCreator — returns same address as agent
    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/bounties/1/apply")
      .set(authHeader(CREATOR_API_KEY))
      .send({ message: "I would love to work on this bounty and contribute my expertise to the project." });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("own bounty");
  });

  it("rejects application to non-open bounty", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // getBountyStatus (status 1 = claimed)
    pool.query.mockResolvedValueOnce({ rows: [{ status: 1 }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/bounties/1/apply")
      .set(authHeader())
      .send({ message: "I would love to work on this bounty and contribute my expertise to the project." });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("not open");
  });

  it("rejects duplicate application via ON CONFLICT", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [{ status: 0 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });
    // ON CONFLICT DO NOTHING returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/bounties/1/apply")
      .set(authHeader())
      .send({ message: "I would love to work on this bounty and contribute my expertise to the project." });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already applied");
  });

  it("rejects non-existent bounty", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // getBountyStatus — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/bounties/999/apply")
      .set(authHeader())
      .send({ message: "I would love to work on this bounty and contribute my expertise to the project." });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bounties/:id/applications/:appId/approve — Approve application
// ---------------------------------------------------------------------------

describe("POST /v1/bounties/:id/applications/:appId/approve", () => {
  it("approves application as creator", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, CREATOR_AGENT);

    // getBountyCreator
    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });
    // COUNT approved
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "0" }], rowCount: 1 });
    // UPDATE status
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "app-1", applicantId: "agt_bounty", applicantAddress: APPLICANT_ADDR }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/bounties/1/applications/12345678-1234-1234-1234-123456789abc/approve")
      .set(authHeader(CREATOR_API_KEY));

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("approved");
  });

  it("rejects non-creator approval", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool); // non-creator agent

    // getBountyCreator
    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/bounties/1/applications/12345678-1234-1234-1234-123456789abc/approve")
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("enforces max 3 approved cap", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, CREATOR_AGENT);

    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });
    // Already 3 approved
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "3" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/bounties/1/applications/12345678-1234-1234-1234-123456789abc/approve")
      .set(authHeader(CREATOR_API_KEY));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Maximum");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bounties/:id/submissions — Submit work
// ---------------------------------------------------------------------------

describe("POST /v1/bounties/:id/submissions", () => {
  it("submits work for approved applicant", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // Check approved application
    pool.query.mockResolvedValueOnce({ rows: [{ id: "app-1" }], rowCount: 1 });
    // INSERT submission
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "sub-uuid-1", status: "submitted", createdAt: new Date().toISOString() }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/bounties/1/submissions")
      .set(authHeader())
      .send({ content: "Here is my work", deliverableCids: ["Qm123"] });

    expect(res.status).toBe(201);
    expect(res.body.submission.id).toBe("sub-uuid-1");
  });

  it("rejects unapproved applicant", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // No approved application
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/bounties/1/submissions")
      .set(authHeader())
      .send({ content: "My work" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("approved application");
  });

  it("rejects empty content", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/bounties/1/submissions")
      .set(authHeader())
      .send({ content: "" });

    expect(res.status).toBe(400);
  });

  it("rejects duplicate submission via ON CONFLICT", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [{ id: "app-1" }], rowCount: 1 });
    // ON CONFLICT returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/bounties/1/submissions")
      .set(authHeader())
      .send({ content: "My work" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already submitted");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/bounties/:id/submissions/:subId/select — Select winner
// ---------------------------------------------------------------------------

describe("POST /v1/bounties/:id/submissions/:subId/select", () => {
  it("selects winner and marks others", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, CREATOR_AGENT);

    // getBountyCreator
    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });
    // No existing winner
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE winner
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "sub-1", applicantId: "agt_bounty", applicantAddress: APPLICANT_ADDR }],
      rowCount: 1,
    });
    // UPDATE others to not_selected
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Other submitters for notification
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/bounties/1/submissions/12345678-1234-1234-1234-123456789abc/select")
      .set(authHeader(CREATOR_API_KEY));

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("Winner selected");
  });

  it("rejects non-creator selection", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool); // non-creator

    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/bounties/1/submissions/12345678-1234-1234-1234-123456789abc/select")
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("rejects when winner already selected", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool, CREATOR_AGENT);

    pool.query.mockResolvedValueOnce({ rows: [{ creator: CREATOR_ADDR }], rowCount: 1 });
    // Existing winner
    pool.query.mockResolvedValueOnce({ rows: [{ id: "existing" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/bounties/1/submissions/12345678-1234-1234-1234-123456789abc/select")
      .set(authHeader(CREATOR_API_KEY));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already been selected");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/bounties/:id/applications — List applications (public)
// ---------------------------------------------------------------------------

describe("GET /v1/bounties/:id/applications", () => {
  it("returns applications", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "app-1", onchainBountyId: 1, applicantId: "agt_1", applicantAddress: APPLICANT_ADDR, status: "pending", message: "hi", createdAt: new Date().toISOString(), applicantName: "alice" },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bounties/1/applications");

    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
    expect(res.body.applications[0].status).toBe("pending");
  });

  it("rejects invalid bounty ID", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/bounties/abc/applications");

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/bounties/:id/submissions — List submissions (public)
// ---------------------------------------------------------------------------

describe("GET /v1/bounties/:id/submissions", () => {
  it("returns submissions", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "sub-1", onchainBountyId: 1, applicantId: "agt_1", applicantAddress: APPLICANT_ADDR, content: "work", deliverableCids: [], status: "submitted", createdAt: new Date().toISOString(), applicantName: "alice" },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/bounties/1/submissions");

    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me/bounty-applications — My applications
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me/bounty-applications", () => {
  it("returns own applications", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // Applications
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "app-1", onchainBountyId: 1, status: "pending", message: "hi", createdAt: new Date().toISOString(), creatorAddress: CREATOR_ADDR }],
      rowCount: 1,
    });
    // Submissions lookup
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/agents/me/bounty-applications")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.applications).toHaveLength(1);
  });
});
