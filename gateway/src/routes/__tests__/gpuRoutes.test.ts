import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createGpuRouter } from "../gpu.js";
import {
  createTestApp,
  createMockPool,
  createMockAgent,
  mockAuthMiddleware,
  TEST_HMAC_SECRET,
} from "../../test/helpers.js";
import type { GpuAvailabilityRow } from "../../services/gpuAvailabilityService.js";
import type { GpuChallengeRow } from "../../services/gpuChallengeService.js";

// ---------------------------------------------------------------------------
// Mock auth middleware
// ---------------------------------------------------------------------------

const TEST_AGENT = createMockAgent({
  id: "test-agent-id",
  address: "0x1111111111111111111111111111111111111111",
});

vi.mock("../../middleware/auth.js", () => ({
  createAuthMiddleware: () => mockAuthMiddleware(TEST_AGENT),
  registeredMiddleware: (_req: any, _res: any, next: any) => next(),
  ownerOnlyMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../../middleware/rateLimit.js", () => ({
  createKeyRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const PROVIDER = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHALLENGE_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";

function makeGpuRow(overrides?: Partial<GpuAvailabilityRow>): GpuAvailabilityRow {
  return {
    provider_address: PROVIDER,
    listing_id: 42,
    status: "online",
    gpu_model: "A100",
    vram_gb: 80,
    gpu_temp_c: 45,
    gpu_utilization: 12,
    vram_used_gb: 4.2,
    current_agreement_id: null,
    last_heartbeat: "2025-06-01T00:00:00.000Z",
    created_at: "2025-06-01T00:00:00.000Z",
    updated_at: "2025-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeChallengeRow(overrides?: Partial<GpuChallengeRow>): GpuChallengeRow {
  return {
    challenge_id: CHALLENGE_ID,
    challenger_address: TEST_AGENT.address,
    provider_address: PROVIDER,
    listing_id: 42,
    challenge_input_cid: "QmInputCid123",
    challenge_output_cid: null,
    expected_min_tflops: 100,
    actual_tflops: null,
    wall_time_ms: null,
    status: "pending",
    created_at: "2025-06-01T00:00:00.000Z",
    completed_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

function createMockGpuAvailabilityService() {
  return {
    recordHeartbeat: vi.fn().mockResolvedValue(makeGpuRow()),
    getAvailability: vi.fn().mockResolvedValue(makeGpuRow()),
    searchAvailableGpus: vi.fn().mockResolvedValue([makeGpuRow()]),
    markDegraded: vi.fn().mockResolvedValue(0),
    markOffline: vi.fn().mockResolvedValue(0),
    runStalenessCheck: vi.fn().mockResolvedValue({ degraded: 0, offline: 0 }),
  };
}

function createMockGpuChallengeService() {
  return {
    createChallenge: vi.fn().mockResolvedValue(makeChallengeRow()),
    submitChallengeResult: vi.fn().mockResolvedValue(makeChallengeRow({ status: "completed" })),
    getChallenge: vi.fn().mockResolvedValue(makeChallengeRow()),
    getProviderChallenges: vi.fn().mockResolvedValue([makeChallengeRow()]),
    getProviderChallengeStats: vi.fn().mockResolvedValue({
      totalChallenges: 5,
      completedChallenges: 4,
      failedChallenges: 1,
      passRate: 80,
      lastChallengeAt: "2025-06-15T00:00:00.000Z",
      avgTflops: 123.45,
    }),
    expireStale: vi.fn().mockResolvedValue(0),
  };
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(
  availOverrides?: Partial<ReturnType<typeof createMockGpuAvailabilityService>>,
  challengeOverrides?: Partial<ReturnType<typeof createMockGpuChallengeService>>,
) {
  const pool = createMockPool();
  const availService = { ...createMockGpuAvailabilityService(), ...availOverrides };
  const challengeService = { ...createMockGpuChallengeService(), ...challengeOverrides };
  const router = createGpuRouter(pool as any, TEST_HMAC_SECRET, availService as any, challengeService as any);
  const app = createTestApp(router);
  return { app, pool, availService, challengeService };
}

// ===========================================================================
// POST /v1/gpu/heartbeat
// ===========================================================================

describe("POST /v1/gpu/heartbeat", () => {
  it("records heartbeat and returns result", async () => {
    const { app, pool, availService } = buildApp();
    // Mock listing ownership check — listing exists and owned by test agent
    pool.query.mockResolvedValueOnce({
      rows: [{ provider_address: TEST_AGENT.address.toLowerCase() }],
    });

    const res = await request(app)
      .post("/v1/gpu/heartbeat")
      .send({ listingId: 42, status: "idle", gpuModel: "A100", vramGb: 80 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.availability).toBeDefined();
    expect(availService.recordHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAddress: TEST_AGENT.address,
        listingId: 42,
        gpuModel: "A100",
        vramGb: 80,
      }),
    );
  });

  it("returns 400 when listingId is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/gpu/heartbeat")
      .send({ status: "idle" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("listingId");
  });

  it("returns 400 when listingId is not a number", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/gpu/heartbeat")
      .send({ listingId: "not-a-number" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when listing does not exist", async () => {
    const { app, pool } = buildApp();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/v1/gpu/heartbeat")
      .send({ listingId: 999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Listing not found");
  });

  it("returns 403 when agent does not own the listing", async () => {
    const { app, pool } = buildApp();
    pool.query.mockResolvedValueOnce({
      rows: [{ provider_address: "0xsomeoneelse" }],
    });

    const res = await request(app)
      .post("/v1/gpu/heartbeat")
      .send({ listingId: 42 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("do not own");
  });

  it("returns 500 on service error", async () => {
    const { app, pool } = buildApp({
      recordHeartbeat: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ provider_address: TEST_AGENT.address.toLowerCase() }],
    });

    const res = await request(app)
      .post("/v1/gpu/heartbeat")
      .send({ listingId: 42 });

    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /v1/gpu/availability
// ===========================================================================

describe("GET /v1/gpu/availability", () => {
  it("returns public (redacted) data when unauthenticated", async () => {
    const pool = createMockPool();
    // tryAuth queries api_keys — return empty to simulate no auth
    pool.query.mockResolvedValue({ rows: [] });

    const { app } = buildApp();

    const res = await request(app).get("/v1/gpu/availability");

    expect(res.status).toBe(200);
    expect(res.body.gpus).toBeDefined();
    expect(Array.isArray(res.body.gpus)).toBe(true);
    // Public rows should have vram_tier, not gpu_model
    if (res.body.gpus.length > 0) {
      const gpu = res.body.gpus[0];
      expect(gpu).toHaveProperty("vram_tier");
      expect(gpu).toHaveProperty("status");
    }
  });

  it("passes filter params to service", async () => {
    const { app, availService } = buildApp();

    await request(app).get("/v1/gpu/availability?gpuModel=A100&minVram=40&status=online&limit=10&offset=5");

    expect(availService.searchAvailableGpus).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuModel: "A100",
        minVram: 40,
        status: "online",
        limit: 10,
        offset: 5,
      }),
    );
  });

  it("returns 500 on service error", async () => {
    const { app } = buildApp({
      searchAvailableGpus: vi.fn().mockRejectedValue(new Error("DB down")),
    });

    const res = await request(app).get("/v1/gpu/availability");
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /v1/gpu/availability/:listingId
// ===========================================================================

describe("GET /v1/gpu/availability/:listingId", () => {
  it("returns 400 for non-numeric listingId", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/gpu/availability/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("number");
  });

  it("returns 404 when listing not found", async () => {
    const { app } = buildApp({
      getAvailability: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).get("/v1/gpu/availability/999");
    expect(res.status).toBe(404);
  });

  it("returns availability data for valid listing", async () => {
    const { app } = buildApp();

    const res = await request(app).get("/v1/gpu/availability/42");
    expect(res.status).toBe(200);
    expect(res.body.availability).toBeDefined();
  });
});

// ===========================================================================
// POST /v1/gpu/challenge
// ===========================================================================

describe("POST /v1/gpu/challenge", () => {
  it("creates a challenge and returns 201", async () => {
    const { app, pool, challengeService } = buildApp();
    // Mock listing ownership check — listing exists with matching provider
    pool.query.mockResolvedValueOnce({ rows: [{ c: "1" }] });

    const res = await request(app)
      .post("/v1/gpu/challenge")
      .send({
        listingId: 42,
        providerAddress: PROVIDER,
        challengeInputCid: "QmInputCid123",
        expectedMinTflops: 100,
      });

    expect(res.status).toBe(201);
    expect(res.body.challenge).toBeDefined();
    expect(challengeService.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        challengerAddress: TEST_AGENT.address,
        providerAddress: PROVIDER,
        listingId: 42,
        challengeInputCid: "QmInputCid123",
        expectedMinTflops: 100,
      }),
    );
  });

  it("returns 400 when required fields are missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post("/v1/gpu/challenge")
      .send({ listingId: 42 }); // missing providerAddress and challengeInputCid

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("returns 404 when listing/provider combo does not exist", async () => {
    const { app, pool } = buildApp();
    pool.query.mockResolvedValueOnce({ rows: [{ c: "0" }] });

    const res = await request(app)
      .post("/v1/gpu/challenge")
      .send({ listingId: 42, providerAddress: PROVIDER, challengeInputCid: "QmTest" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Listing not found");
  });

  it("returns 500 on service error", async () => {
    const { app, pool } = buildApp(undefined, {
      createChallenge: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    pool.query.mockResolvedValueOnce({ rows: [{ c: "1" }] });

    const res = await request(app)
      .post("/v1/gpu/challenge")
      .send({ listingId: 42, providerAddress: PROVIDER, challengeInputCid: "QmTest" });

    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /v1/gpu/challenge/:id/submit
// ===========================================================================

describe("POST /v1/gpu/challenge/:id/submit", () => {
  it("submits challenge result", async () => {
    const { app, challengeService } = buildApp();

    const res = await request(app)
      .post(`/v1/gpu/challenge/${CHALLENGE_ID}/submit`)
      .send({
        challengeOutputCid: "QmOutputCid456",
        actualTflops: 150,
        wallTimeMs: 5000,
      });

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(challengeService.submitChallengeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: CHALLENGE_ID,
        providerAddress: TEST_AGENT.address,
        challengeOutputCid: "QmOutputCid456",
      }),
    );
  });

  it("returns 400 when challengeOutputCid is missing", async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post(`/v1/gpu/challenge/${CHALLENGE_ID}/submit`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("challengeOutputCid");
  });

  it("returns 404 when challenge not found", async () => {
    const { app } = buildApp(undefined, {
      submitChallengeResult: vi.fn().mockRejectedValue(new Error("Challenge not found or not your challenge.")),
    });

    const res = await request(app)
      .post(`/v1/gpu/challenge/${CHALLENGE_ID}/submit`)
      .send({ challengeOutputCid: "QmTest" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when challenge is expired", async () => {
    const { app } = buildApp(undefined, {
      submitChallengeResult: vi.fn().mockRejectedValue(new Error("Challenge has expired.")),
    });

    const res = await request(app)
      .post(`/v1/gpu/challenge/${CHALLENGE_ID}/submit`)
      .send({ challengeOutputCid: "QmTest" });

    expect(res.status).toBe(409);
  });

  it("returns 409 when challenge already completed", async () => {
    const { app } = buildApp(undefined, {
      submitChallengeResult: vi.fn().mockRejectedValue(new Error("Challenge is completed, cannot submit results.")),
    });

    const res = await request(app)
      .post(`/v1/gpu/challenge/${CHALLENGE_ID}/submit`)
      .send({ challengeOutputCid: "QmTest" });

    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// GET /v1/gpu/challenge/:id
// ===========================================================================

describe("GET /v1/gpu/challenge/:id", () => {
  it("returns full challenge details for challenger", async () => {
    const challenge = makeChallengeRow({ challenger_address: TEST_AGENT.address });
    const { app } = buildApp(undefined, {
      getChallenge: vi.fn().mockResolvedValue(challenge),
    });

    const res = await request(app).get(`/v1/gpu/challenge/${CHALLENGE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.challenge.challenge_input_cid).toBe("QmInputCid123");
  });

  it("returns full challenge details for provider", async () => {
    const challenge = makeChallengeRow({ provider_address: TEST_AGENT.address });
    const { app } = buildApp(undefined, {
      getChallenge: vi.fn().mockResolvedValue(challenge),
    });

    const res = await request(app).get(`/v1/gpu/challenge/${CHALLENGE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.challenge.challenge_input_cid).toBe("QmInputCid123");
  });

  it("returns redacted view for non-party", async () => {
    const challenge = makeChallengeRow({
      challenger_address: "0x9999999999999999999999999999999999999999",
      provider_address: "0x8888888888888888888888888888888888888888",
    });
    const { app } = buildApp(undefined, {
      getChallenge: vi.fn().mockResolvedValue(challenge),
    });

    const res = await request(app).get(`/v1/gpu/challenge/${CHALLENGE_ID}`);

    expect(res.status).toBe(200);
    // Redacted — no CIDs or TFLOPS
    expect(res.body.challenge).not.toHaveProperty("challenge_input_cid");
    expect(res.body.challenge).not.toHaveProperty("challenger_address");
    expect(res.body.challenge).toHaveProperty("status");
    expect(res.body.challenge).toHaveProperty("challenge_id");
  });

  it("returns 404 when challenge not found", async () => {
    const { app } = buildApp(undefined, {
      getChallenge: vi.fn().mockResolvedValue(null),
    });

    const res = await request(app).get(`/v1/gpu/challenge/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// GET /v1/gpu/providers/:address/challenges
// ===========================================================================

describe("GET /v1/gpu/providers/:address/challenges", () => {
  it("returns stats for any caller", async () => {
    const { app, challengeService } = buildApp();

    const res = await request(app).get(`/v1/gpu/providers/${PROVIDER}/challenges`);

    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.totalChallenges).toBe(5);
    expect(res.body.stats.passRate).toBe(80);
    expect(challengeService.getProviderChallengeStats).toHaveBeenCalledWith(PROVIDER);
  });

  it("returns 500 on service error", async () => {
    const { app } = buildApp(undefined, {
      getProviderChallengeStats: vi.fn().mockRejectedValue(new Error("DB down")),
    });

    const res = await request(app).get(`/v1/gpu/providers/${PROVIDER}/challenges`);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// Tiered disclosure integration
// ===========================================================================

describe("Tiered disclosure integration", () => {
  it("GET /v1/gpu/availability returns array with vram_tier when no auth", async () => {
    const gpuRows = [
      makeGpuRow({ listing_id: 1, vram_gb: 80, last_heartbeat: "2025-06-01T01:00:00.000Z" }),
      makeGpuRow({ listing_id: 2, vram_gb: 24, last_heartbeat: "2025-06-01T00:00:00.000Z" }),
    ];
    const { app } = buildApp({
      searchAvailableGpus: vi.fn().mockResolvedValue(gpuRows),
    });

    const res = await request(app).get("/v1/gpu/availability");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.gpus)).toBe(true);
    expect(res.body.gpus).toHaveLength(2);
    // Public rows should have vram_tier, not gpu_model or vram_gb
    for (const gpu of res.body.gpus) {
      expect(gpu).toHaveProperty("vram_tier");
      expect(gpu).toHaveProperty("status");
      expect(gpu).toHaveProperty("listing_id");
      expect(gpu).not.toHaveProperty("gpu_model");
      expect(gpu).not.toHaveProperty("vram_gb");
      expect(gpu).not.toHaveProperty("provider_address");
      expect(gpu).not.toHaveProperty("gpu_temp_c");
    }
    expect(res.body.gpus[0].vram_tier).toBe("80GB+");
    expect(res.body.gpus[1].vram_tier).toBe("24GB+");
  });

  it("search results are ordered by last_heartbeat DESC (service contract)", async () => {
    // The service uses ORDER BY ga.last_heartbeat DESC — verify the route
    // returns results in the same order the service provides
    const newerRow = makeGpuRow({ listing_id: 1, last_heartbeat: "2025-06-01T12:00:00.000Z" });
    const olderRow = makeGpuRow({ listing_id: 2, last_heartbeat: "2025-06-01T00:00:00.000Z" });
    const { app } = buildApp({
      searchAvailableGpus: vi.fn().mockResolvedValue([newerRow, olderRow]),
    });

    const res = await request(app).get("/v1/gpu/availability");

    expect(res.status).toBe(200);
    expect(res.body.gpus).toHaveLength(2);
    // Newer heartbeat should come first (service returns DESC order)
    expect(res.body.gpus[0].last_heartbeat).toBe("2025-06-01T12:00:00.000Z");
    expect(res.body.gpus[1].last_heartbeat).toBe("2025-06-01T00:00:00.000Z");
  });
});

// ===========================================================================
// Challenge flow edge cases
// ===========================================================================

describe("Challenge flow edge cases", () => {
  it("POST /v1/gpu/challenge with invalid providerAddress format still passes to service", async () => {
    // The route does not validate providerAddress format — it checks listing+provider
    // combo in the DB. An invalid address will simply not match any listing.
    const { app, pool } = buildApp();
    pool.query.mockResolvedValueOnce({ rows: [{ c: "0" }] }); // listing check fails

    const res = await request(app)
      .post("/v1/gpu/challenge")
      .send({
        listingId: 42,
        providerAddress: "not-a-valid-address",
        challengeInputCid: "QmInputCid123",
      });

    // Returns 404 because the listing+provider combo doesn't exist
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Listing not found");
  });

  it("GET /v1/gpu/challenge/:id with non-UUID id still works (service handles lookup)", async () => {
    const challenge = makeChallengeRow({
      challenge_id: "some-non-uuid-string",
      challenger_address: TEST_AGENT.address,
    });
    const { app } = buildApp(undefined, {
      getChallenge: vi.fn().mockResolvedValue(challenge),
    });

    const res = await request(app).get("/v1/gpu/challenge/some-non-uuid-string");

    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(res.body.challenge.challenge_id).toBe("some-non-uuid-string");
  });

  it("POST /v1/gpu/challenge/:id/submit with expired challenge returns 409", async () => {
    const { app } = buildApp(undefined, {
      submitChallengeResult: vi.fn().mockRejectedValue(new Error("Challenge has expired.")),
    });

    const res = await request(app)
      .post(`/v1/gpu/challenge/${CHALLENGE_ID}/submit`)
      .send({ challengeOutputCid: "QmExpiredOutput" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("expired");
  });
});

// ===========================================================================
// GET /v1/gpu/providers/:address/research-stats
// ===========================================================================

describe("GET /v1/gpu/providers/:address/research-stats", () => {
  it("returns research stats for a provider", async () => {
    const { app, pool } = buildApp();
    pool.query.mockResolvedValueOnce({
      rows: [{ total_experiments: "42", improvements: "8", bundles_produced: "3" }],
    });

    const res = await request(app).get(`/v1/gpu/providers/${PROVIDER}/research-stats`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.researchStats.totalExperiments).toBe(42);
    expect(res.body.researchStats.improvements).toBe(8);
    expect(res.body.researchStats.bundlesProduced).toBe(3);
    expect(res.body.researchStats.successRate).toBe(19);
  });

  it("returns zeroes when no research data", async () => {
    const { app, pool } = buildApp();
    pool.query.mockResolvedValueOnce({
      rows: [{ total_experiments: "0", improvements: "0", bundles_produced: "0" }],
    });

    const res = await request(app).get(`/v1/gpu/providers/${PROVIDER}/research-stats`);

    expect(res.status).toBe(200);
    expect(res.body.researchStats.totalExperiments).toBe(0);
    expect(res.body.researchStats.successRate).toBe(0);
  });

  it("returns 500 on DB error", async () => {
    const { app, pool } = buildApp();
    pool.query.mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get(`/v1/gpu/providers/${PROVIDER}/research-stats`);
    expect(res.status).toBe(500);
  });
});
