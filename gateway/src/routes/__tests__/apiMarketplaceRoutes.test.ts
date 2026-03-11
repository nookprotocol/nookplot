import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApiMarketplaceRouter } from "../api-marketplace.js";
import {
  createTestApp,
  createMockPool,
  createMockAgent,
  mockAuthMiddleware,
  TEST_HMAC_SECRET,
  type MockPool,
} from "../../test/helpers.js";
import type { ApiAvailabilityRow, ApiProxyConfigRow, UsageSummary } from "../../services/apiProxyService.js";

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

const PROVIDER = "0x1111111111111111111111111111111111111111";

function makeAvailabilityRow(overrides?: Partial<ApiAvailabilityRow>): ApiAvailabilityRow {
  return {
    provider_address: PROVIDER,
    listing_id: 42,
    status: "online",
    last_heartbeat: "2025-06-01T00:00:00.000Z",
    last_latency_ms: 150,
    uptime_checks: 100,
    uptime_passes: 98,
    active_agreements: 3,
    created_at: "2025-06-01T00:00:00.000Z",
    updated_at: "2025-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProxyConfig(overrides?: Partial<ApiProxyConfigRow>): ApiProxyConfigRow {
  return {
    listing_id: 42,
    provider_address: PROVIDER,
    proxy_url: "https://my-agent.example.com/proxy",
    health_check_path: "/health",
    rate_limit_rpm: 100,
    allowed_methods: ["GET", "POST"],
    max_payload_bytes: 1_048_576,
    created_at: "2025-06-01T00:00:00.000Z",
    updated_at: "2025-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock service
// ---------------------------------------------------------------------------

function createMockApiProxyService() {
  return {
    registerEndpoint: vi.fn().mockResolvedValue(makeProxyConfig()),
    getProxyConfig: vi.fn().mockResolvedValue(makeProxyConfig()),
    deleteProxyConfig: vi.fn().mockResolvedValue(true),
    recordHeartbeat: vi.fn().mockResolvedValue(makeAvailabilityRow()),
    getAvailability: vi.fn().mockResolvedValue(makeAvailabilityRow()),
    searchAvailable: vi.fn().mockResolvedValue([makeAvailabilityRow()]),
    markDegraded: vi.fn().mockResolvedValue(0),
    markOffline: vi.fn().mockResolvedValue(0),
    runStalenessCheck: vi.fn().mockResolvedValue({ degraded: 0, offline: 0 }),
    logUsage: vi.fn().mockResolvedValue({ id: "usage-1" }),
    getUsageSummary: vi.fn().mockResolvedValue({
      totalRequests: 100,
      successfulRequests: 95,
      failedRequests: 5,
      avgLatencyMs: 123,
      totalRequestBytes: 50000,
      totalResponseBytes: 200000,
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: "2025-06-01T00:00:00.000Z",
    } satisfies UsageSummary),
    getUsageLogs: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(
  svcOverrides?: Partial<ReturnType<typeof createMockApiProxyService>>,
  poolOverrides?: Partial<MockPool>,
) {
  const pool = { ...createMockPool(), ...poolOverrides };
  const service = { ...createMockApiProxyService(), ...svcOverrides };
  const router = createApiMarketplaceRouter(pool as any, TEST_HMAC_SECRET, service as any);
  const app = createTestApp(router);
  return { app, pool, service };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("API Marketplace Routes", () => {
  // ── POST /v1/api/register-endpoint ─────────────────────────

  describe("POST /v1/api/register-endpoint", () => {
    it("registers endpoint and returns config", async () => {
      const pool = createMockPool();
      // Listing ownership check
      pool.query.mockResolvedValueOnce({
        rows: [{ provider_address: PROVIDER.toLowerCase(), category: "api" }],
        rowCount: 1,
      });
      const { app, service } = buildApp(undefined, pool);

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({
          listingId: 42,
          proxyUrl: "https://my-agent.example.com/proxy",
          rateLimitRpm: 100,
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.config).toBeDefined();
      expect(service.registerEndpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId: 42,
          proxyUrl: "https://my-agent.example.com/proxy",
          rateLimitRpm: 100,
        }),
      );
    });

    it("rejects missing listingId", async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({ proxyUrl: "https://example.com" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("listingId");
    });

    it("rejects missing proxyUrl", async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({ listingId: 42 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("proxyUrl");
    });

    it("rejects invalid URL", async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({ listingId: 42, proxyUrl: "not-a-url" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("valid URL");
    });

    it("rejects non-api category listing", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({
        rows: [{ provider_address: PROVIDER.toLowerCase(), category: "gpu" }],
        rowCount: 1,
      });
      const { app } = buildApp(undefined, pool);

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({ listingId: 42, proxyUrl: "https://example.com" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("category must be 'api'");
    });

    it("returns 404 for non-existent listing", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const { app } = buildApp(undefined, pool);

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({ listingId: 999, proxyUrl: "https://example.com" });

      expect(res.status).toBe(404);
    });

    it("rejects invalid allowedMethods", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({
        rows: [{ provider_address: PROVIDER.toLowerCase(), category: "api" }],
        rowCount: 1,
      });
      const { app } = buildApp(undefined, pool);

      const res = await request(app)
        .post("/v1/api/register-endpoint")
        .send({
          listingId: 42,
          proxyUrl: "https://example.com",
          allowedMethods: ["GET", "BANANA"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("allowedMethods");
    });
  });

  // ── POST /v1/api/heartbeat ─────────────────────────────────

  describe("POST /v1/api/heartbeat", () => {
    it("records heartbeat and returns availability", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({
        rows: [{ provider_address: PROVIDER.toLowerCase() }],
        rowCount: 1,
      });
      const { app, service } = buildApp(undefined, pool);

      const res = await request(app)
        .post("/v1/api/heartbeat")
        .send({ listingId: 42, latencyMs: 150 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.availability).toBeDefined();
      expect(service.recordHeartbeat).toHaveBeenCalled();
    });

    it("rejects missing listingId", async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post("/v1/api/heartbeat")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 403 for listing not owned by caller", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({
        rows: [{ provider_address: "0xOTHER" }],
        rowCount: 1,
      });
      const { app } = buildApp(undefined, pool);

      const res = await request(app)
        .post("/v1/api/heartbeat")
        .send({ listingId: 42 });

      expect(res.status).toBe(403);
    });
  });

  // ── GET /v1/api/availability ───────────────────────────────

  describe("GET /v1/api/availability", () => {
    it("returns redacted data for unauthenticated requests", async () => {
      const pool = createMockPool();
      // tryAuth query returns no match (unauthenticated)
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const { app } = buildApp(undefined, pool);

      const res = await request(app).get("/v1/api/availability");

      expect(res.status).toBe(200);
      expect(res.body.apis).toBeDefined();
      expect(Array.isArray(res.body.apis)).toBe(true);
      // Public rows should not have provider_address
      if (res.body.apis.length > 0) {
        expect(res.body.apis[0]).not.toHaveProperty("provider_address");
        expect(res.body.apis[0]).toHaveProperty("uptime_percent");
      }
    });
  });

  // ── GET /v1/api/availability/:listingId ────────────────────

  describe("GET /v1/api/availability/:listingId", () => {
    it("returns availability for a specific listing", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // tryAuth
      const { app } = buildApp(undefined, pool);

      const res = await request(app).get("/v1/api/availability/42");

      expect(res.status).toBe(200);
      expect(res.body.availability).toBeDefined();
    });

    it("returns 404 for non-existent listing", async () => {
      const { app } = buildApp({
        getAvailability: vi.fn().mockResolvedValue(null),
      });

      const res = await request(app).get("/v1/api/availability/999");

      expect(res.status).toBe(404);
    });

    it("rejects non-numeric listing ID", async () => {
      const { app } = buildApp();

      const res = await request(app).get("/v1/api/availability/abc");

      expect(res.status).toBe(400);
    });
  });

  // ── GET /v1/api/usage/:agreementId ─────────────────────────

  describe("GET /v1/api/usage/:agreementId", () => {
    it("returns usage for agreement party", async () => {
      const pool = createMockPool();
      // Agreement lookup
      pool.query.mockResolvedValueOnce({
        rows: [{
          buyer_address: PROVIDER.toLowerCase(),
          provider_address: "0xother",
          listing_id: 42,
        }],
        rowCount: 1,
      });
      const { app } = buildApp(undefined, pool);

      const res = await request(app).get("/v1/api/usage/1");

      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.totalRequests).toBe(100);
    });

    it("returns 403 for non-party", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({
        rows: [{
          buyer_address: "0xother1",
          provider_address: "0xother2",
          listing_id: 42,
        }],
        rowCount: 1,
      });
      const { app } = buildApp(undefined, pool);

      const res = await request(app).get("/v1/api/usage/1");

      expect(res.status).toBe(403);
    });

    it("returns 404 for non-existent agreement", async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const { app } = buildApp(undefined, pool);

      const res = await request(app).get("/v1/api/usage/999");

      expect(res.status).toBe(404);
    });
  });

  // ── POST /v1/api-proxy/:agreementId/* ───────────────────────

  describe("POST /v1/api-proxy/:agreementId/*", () => {
    it("rejects requests without signature headers", async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post("/v1/api-proxy/1/v1/chat")
        .send({ message: "hello" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("X-Nookplot-Signature");
    });

    it("rejects expired timestamps", async () => {
      const { app } = buildApp();
      const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 min ago

      const res = await request(app)
        .post("/v1/api-proxy/1/v1/chat")
        .set("X-Nookplot-Signature", "0xfake")
        .set("X-Nookplot-Timestamp", String(staleTimestamp))
        .send({ message: "hello" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("expired");
    });

    it("rejects invalid signatures", async () => {
      const { app } = buildApp();
      const timestamp = Math.floor(Date.now() / 1000);

      const res = await request(app)
        .post("/v1/api-proxy/1/v1/chat")
        .set("X-Nookplot-Signature", "0x" + "ab".repeat(65))
        .set("X-Nookplot-Timestamp", String(timestamp))
        .send({ message: "hello" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid EIP-712 signature");
    });

    it("rejects non-numeric agreement ID", async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post("/v1/api-proxy/abc/v1/chat")
        .set("X-Nookplot-Signature", "0xfake")
        .set("X-Nookplot-Timestamp", String(Math.floor(Date.now() / 1000)))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Agreement ID must be a number");
    });
  });
});
