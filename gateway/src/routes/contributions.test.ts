import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createContributionsRouter } from "./contributions.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ethers mock for validateAddressParam
vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const ADMIN_ADDRESS = "0xAdminAddress000000000000000000000000000001";

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);

const ADMIN_AGENT = createMockAgent({ id: "agt_admin", address: ADMIN_ADDRESS, api_key_hash: TEST_KEY_HASH });

function createMockScorer() {
  return { computeAllScores: vi.fn().mockResolvedValue(undefined) };
}

function createMockProfiler() {
  return { profileAllAgents: vi.fn().mockResolvedValue(undefined) };
}

function createMockOnChainSync() {
  return { runSyncCycle: vi.fn().mockResolvedValue({ agentsSynced: 3, txHashes: ["0xtx1"] }) };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  opts?: {
    scorer?: ReturnType<typeof createMockScorer>;
    profiler?: ReturnType<typeof createMockProfiler>;
    onChainSync?: ReturnType<typeof createMockOnChainSync> | null;
    adminAddress?: string;
  },
) {
  const scorer = opts?.scorer ?? createMockScorer();
  const profiler = opts?.profiler ?? createMockProfiler();
  const onChainSync = opts?.onChainSync === undefined ? createMockOnChainSync() : opts.onChainSync;
  const adminAddress = opts?.adminAddress ?? ADMIN_ADDRESS;

  const router = createContributionsRouter(
    pool as any,
    scorer as any,
    profiler as any,
    onChainSync as any,
    TEST_HMAC_SECRET,
    adminAddress,
  );
  return { app: createTestApp(router), scorer, profiler, onChainSync };
}

function setupAuth(pool: ReturnType<typeof createMockPool>, agent = ADMIN_AGENT) {
  // Auth middleware: agent lookup + credit balance pre-fetch
  pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/contributions/leaderboard — Public
// ---------------------------------------------------------------------------

describe("GET /v1/contributions/leaderboard", () => {
  it("returns leaderboard entries", async () => {
    const pool = createMockPool();
    // Leaderboard query
    pool.query.mockResolvedValueOnce({
      rows: [{
        address: "0xAgent1",
        display_name: "Alpha",
        overall_score: 85,
        commits_score: 30,
        exec_score: 20,
        projects_score: 15,
        lines_score: 10,
        collab_score: 10,
        bundle_count: 2,
        breakdown_cid: "bafybreak",
        computed_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
      }],
      rowCount: 1,
    });
    // Count query
    pool.query.mockResolvedValueOnce({
      rows: [{ total: "1" }],
      rowCount: 1,
    });

    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/contributions/leaderboard");

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].rank).toBe(1);
    expect(res.body.entries[0].address).toBe("0xAgent1");
    expect(res.body.entries[0].score).toBe(85);
    expect(res.body.entries[0].breakdown.commits).toBe(30);
    expect(res.body.entries[0].breakdown.bundles).toBe(2);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);
  });

  it("respects limit and offset params", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const { app } = buildApp(pool);

    await request(app).get("/v1/contributions/leaderboard?limit=10&offset=5");

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(10);
    expect(params[1]).toBe(5);
  });

  it("clamps limit to 100", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const { app } = buildApp(pool);

    await request(app).get("/v1/contributions/leaderboard?limit=500");

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(100);
  });

  it("returns 500 on query failure", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("DB down"));

    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/contributions/leaderboard");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("leaderboard");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/contributions/:address — Agent contributions
// ---------------------------------------------------------------------------

describe("GET /v1/contributions/:address", () => {
  it("returns agent contribution data with scores and tags", async () => {
    const pool = createMockPool();
    // Score query
    pool.query.mockResolvedValueOnce({
      rows: [{
        overall_score: 75,
        commits_score: 25,
        exec_score: 15,
        projects_score: 15,
        lines_score: 10,
        collab_score: 10,
        breakdown_cid: "bafybreak",
        computed_at: { toISOString: () => "2025-06-01T00:00:00.000Z" },
        synced_at: { toISOString: () => "2025-06-02T00:00:00.000Z" },
      }],
      rowCount: 1,
    });
    // Tags query
    pool.query.mockResolvedValueOnce({
      rows: [{ tag: "solidity", confidence: 0.9, source: "commits" }],
      rowCount: 1,
    });

    const { app } = buildApp(pool);
    const addr = "0x1111111111111111111111111111111111111111";

    const res = await request(app).get(`/v1/contributions/${addr}`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(addr);
    expect(res.body.score).toBe(75);
    expect(res.body.breakdown.commits).toBe(25);
    expect(res.body.expertiseTags).toHaveLength(1);
    expect(res.body.expertiseTags[0].tag).toBe("solidity");
  });

  it("returns zero score when agent has no data", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no scores
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no tags

    const { app } = buildApp(pool);
    const addr = "0x2222222222222222222222222222222222222222";

    const res = await request(app).get(`/v1/contributions/${addr}`);

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.expertiseTags).toHaveLength(0);
  });

  it("rejects invalid address", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/contributions/not-an-address");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("address");
  });

  it("returns 500 on query failure", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    const { app } = buildApp(pool);
    const addr = "0x1111111111111111111111111111111111111111";

    const res = await request(app).get(`/v1/contributions/${addr}`);

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/contributions/sync — Admin-only sync
// ---------------------------------------------------------------------------

describe("POST /v1/contributions/sync", () => {
  it("triggers sync cycle for admin", async () => {
    const pool = createMockPool();
    const scorer = createMockScorer();
    const profiler = createMockProfiler();
    const onChainSync = createMockOnChainSync();
    const { app } = buildApp(pool, { scorer, profiler, onChainSync });

    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/contributions/sync")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("complete");
    expect(res.body.agentsSynced).toBe(3);
    expect(res.body.txHashes).toEqual(["0xtx1"]);
    expect(scorer.computeAllScores).toHaveBeenCalled();
    expect(profiler.profileAllAgents).toHaveBeenCalled();
    expect(onChainSync.runSyncCycle).toHaveBeenCalled();
  });

  it("works without onChainSync configured", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool, { onChainSync: null });

    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/contributions/sync")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.agentsSynced).toBe(0);
    expect(res.body.txHashes).toEqual([]);
  });

  it("returns 403 for non-admin", async () => {
    const pool = createMockPool();
    const nonAdmin = createMockAgent({ id: "agt_user", address: "0x9999999999999999999999999999999999999999", api_key_hash: TEST_KEY_HASH });
    const { app } = buildApp(pool);

    setupAuth(pool, nonAdmin);

    const res = await request(app)
      .post("/v1/contributions/sync")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("admin");
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).post("/v1/contributions/sync");

    expect(res.status).toBe(401);
  });

  it("returns 500 on scorer error", async () => {
    const pool = createMockPool();
    const scorer = createMockScorer();
    scorer.computeAllScores.mockRejectedValue(new Error("computation failed"));
    const { app } = buildApp(pool, { scorer });

    setupAuth(pool, ADMIN_AGENT);

    const res = await request(app)
      .post("/v1/contributions/sync")
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("failed");
  });
});
