import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createGuildsRouter } from "./guilds.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../sdkFactory.js", () => ({
  getReadOnlySDK: vi.fn(),
  // SdkFactoryConfig type stub
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_guild", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} };

function createMockGuildDetector() {
  return {
    suggestGuilds: vi.fn().mockResolvedValue([
      { members: ["0xaaa", "0xbbb"], score: 0.85, reason: "Frequent collaborators" },
    ]),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  guildDetector?: ReturnType<typeof createMockGuildDetector>,
) {
  const router = createGuildsRouter(
    pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET,
    guildDetector as any, undefined,
  );
  return { app: createTestApp(router) };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/guilds — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/guilds — 410 Gone", () => {
  it("returns 410 with prepare+relay instructions", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/guilds")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/guild");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/guilds/suggest — AI-suggested guilds
// ---------------------------------------------------------------------------

describe("GET /v1/guilds/suggest", () => {
  it("returns suggestions when detector is configured", async () => {
    const pool = createMockPool();
    const detector = createMockGuildDetector();
    const { app } = buildApp(pool, detector);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/guilds/suggest")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(res.body.suggestions[0].score).toBe(0.85);
    expect(detector.suggestGuilds).toHaveBeenCalledWith(TEST_AGENT.address, 3);
  });

  it("respects limit query param", async () => {
    const pool = createMockPool();
    const detector = createMockGuildDetector();
    const { app } = buildApp(pool, detector);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/guilds/suggest?limit=5")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(detector.suggestGuilds).toHaveBeenCalledWith(TEST_AGENT.address, 5);
  });

  it("returns 501 when detector is not configured", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool); // no detector
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/guilds/suggest")
      .set(authHeader());

    expect(res.status).toBe(501);
    expect(res.body.error).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
//  410 Gone stubs — approve, reject, leave, spawn
// ---------------------------------------------------------------------------

describe("Guild write operations — 410 Gone", () => {
  it("POST /v1/guilds/:id/approve returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/guilds/1/approve")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/guild");
  });

  it("POST /v1/guilds/:id/reject returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/guilds/1/reject")
      .set(authHeader());

    expect(res.status).toBe(410);
  });

  it("POST /v1/guilds/:id/leave returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/guilds/1/leave")
      .set(authHeader());

    expect(res.status).toBe(410);
  });

  it("POST /v1/guilds/:id/spawn returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/guilds/1/spawn")
      .set(authHeader());

    expect(res.status).toBe(410);
  });
});
