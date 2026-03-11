import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiProxyService } from "../apiProxyService.js";
import { createMockPool, type MockPool } from "../../test/helpers.js";

describe("ApiProxyService", () => {
  let pool: MockPool;
  let service: ApiProxyService;

  beforeEach(() => {
    pool = createMockPool();
    service = new ApiProxyService(pool as any);
  });

  // ── Endpoint Registration ──────────────────────────────────

  describe("registerEndpoint", () => {
    it("upserts proxy config and returns row", async () => {
      const mockRow = {
        listing_id: 42,
        provider_address: "0xABC",
        proxy_url: "https://my-agent.example.com/proxy",
        health_check_path: "/health",
        rate_limit_rpm: 100,
        allowed_methods: ["GET", "POST"],
        max_payload_bytes: 1_048_576,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      };
      pool.query.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await service.registerEndpoint({
        listingId: 42,
        providerAddress: "0xABC",
        proxyUrl: "https://my-agent.example.com/proxy",
        rateLimitRpm: 100,
      });

      expect(result).toEqual(mockRow);
      expect(pool.query).toHaveBeenCalledTimes(1);
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO api_proxy_config");
      expect(sql).toContain("ON CONFLICT (listing_id) DO UPDATE");
    });

    it("uses defaults for optional fields", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });

      await service.registerEndpoint({
        listingId: 1,
        providerAddress: "0xDEF",
        proxyUrl: "https://example.com",
      });

      const params = pool.query.mock.calls[0][1] as any[];
      expect(params[3]).toBe("/health"); // default healthCheckPath
      expect(params[4]).toBe(60); // default rateLimitRpm
      expect(params[5]).toEqual(["GET", "POST"]); // default allowedMethods
      expect(params[6]).toBe(1_048_576); // default maxPayloadBytes
    });
  });

  describe("getProxyConfig", () => {
    it("returns config when found", async () => {
      const mockRow = { listing_id: 42, proxy_url: "https://example.com" };
      pool.query.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await service.getProxyConfig(42);
      expect(result).toEqual(mockRow);
    });

    it("returns null when not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await service.getProxyConfig(999);
      expect(result).toBeNull();
    });
  });

  describe("deleteProxyConfig", () => {
    it("returns true when deleted", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const result = await service.deleteProxyConfig(42);
      expect(result).toBe(true);
    });

    it("returns false when nothing to delete", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await service.deleteProxyConfig(999);
      expect(result).toBe(false);
    });
  });

  // ── Heartbeat / Availability ───────────────────────────────

  describe("recordHeartbeat", () => {
    it("upserts availability and sets status to online", async () => {
      const mockRow = {
        provider_address: "0xABC",
        listing_id: 42,
        status: "online",
        last_heartbeat: new Date().toISOString(),
      };
      pool.query.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await service.recordHeartbeat({
        providerAddress: "0xABC",
        listingId: 42,
        latencyMs: 150,
      });

      expect(result.status).toBe("online");
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO api_availability");
      expect(sql).toContain("ON CONFLICT (provider_address) DO UPDATE");
      expect(sql).toContain("status = 'online'");
    });
  });

  describe("searchAvailable", () => {
    it("excludes offline by default", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.searchAvailable({});
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("aa.status != 'offline'");
    });

    it("filters by specific status", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.searchAvailable({ status: "online" });
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("aa.status = $1");
      expect(pool.query.mock.calls[0][1]![0]).toBe("online");
    });

    it("filters by minimum uptime", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.searchAvailable({ minUptimePercent: 95 });
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("uptime_passes");
      expect(sql).toContain("uptime_checks");
    });

    it("respects limit and offset", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.searchAvailable({ limit: 10, offset: 20 });
      const params = pool.query.mock.calls[0][1] as any[];
      // Last two params are limit and offset
      expect(params[params.length - 2]).toBe(10);
      expect(params[params.length - 1]).toBe(20);
    });

    it("caps limit at 100", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.searchAvailable({ limit: 500 });
      const params = pool.query.mock.calls[0][1] as any[];
      expect(params[params.length - 2]).toBe(100);
    });
  });

  // ── Staleness Checks ──────────────────────────────────────

  describe("markDegraded", () => {
    it("marks online providers as degraded after 5 min", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 3 });
      const count = await service.markDegraded();
      expect(count).toBe(3);
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'degraded'");
      expect(sql).toContain("5 minutes");
    });
  });

  describe("markOffline", () => {
    it("marks stale providers as offline after 15 min", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 2 });
      const count = await service.markOffline();
      expect(count).toBe(2);
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'offline'");
      expect(sql).toContain("15 minutes");
    });
  });

  describe("runStalenessCheck", () => {
    it("runs offline then degraded checks", async () => {
      pool.query
        .mockResolvedValueOnce({ rowCount: 1 }) // markOffline
        .mockResolvedValueOnce({ rowCount: 2 }); // markDegraded
      const result = await service.runStalenessCheck();
      expect(result).toEqual({ degraded: 2, offline: 1 });
    });
  });

  // ── Usage Logging ──────────────────────────────────────────

  describe("logUsage", () => {
    it("inserts a usage log entry", async () => {
      const mockLog = {
        id: "uuid-123",
        agreement_id: 1,
        listing_id: 42,
        request_id: "req-abc",
        buyer_address: "0xBUYER",
        provider_address: "0xPROVIDER",
        method: "POST",
        path: "/v1/chat",
        status_code: 200,
        latency_ms: 150,
        request_bytes: 500,
        response_bytes: 2000,
        error: null,
        created_at: "2025-01-01T00:00:00Z",
      };
      pool.query.mockResolvedValueOnce({ rows: [mockLog], rowCount: 1 });

      const result = await service.logUsage({
        agreementId: 1,
        listingId: 42,
        requestId: "req-abc",
        buyerAddress: "0xBUYER",
        providerAddress: "0xPROVIDER",
        method: "POST",
        path: "/v1/chat",
        statusCode: 200,
        latencyMs: 150,
        requestBytes: 500,
        responseBytes: 2000,
      });

      expect(result).toEqual(mockLog);
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO api_usage_logs");
    });
  });

  describe("getUsageSummary", () => {
    it("returns aggregated stats", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{
          total: "100",
          successful: "95",
          failed: "5",
          avg_latency: "123.456",
          total_req_bytes: "50000",
          total_res_bytes: "200000",
        }],
        rowCount: 1,
      });

      const summary = await service.getUsageSummary(1);
      expect(summary.totalRequests).toBe(100);
      expect(summary.successfulRequests).toBe(95);
      expect(summary.failedRequests).toBe(5);
      expect(summary.avgLatencyMs).toBe(123);
      expect(summary.totalRequestBytes).toBe(50000);
      expect(summary.totalResponseBytes).toBe(200000);
    });
  });

  describe("getUsageLogs", () => {
    it("returns recent logs with pagination", async () => {
      const mockLogs = [{ id: "1" }, { id: "2" }];
      pool.query.mockResolvedValueOnce({ rows: mockLogs, rowCount: 2 });

      const result = await service.getUsageLogs(1, 10, 0);
      expect(result).toEqual(mockLogs);
      const params = pool.query.mock.calls[0][1] as any[];
      expect(params[0]).toBe(1); // agreementId
      expect(params[1]).toBe(10); // limit
      expect(params[2]).toBe(0); // offset
    });

    it("caps limit at 200", async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.getUsageLogs(1, 500, 0);
      const params = pool.query.mock.calls[0][1] as any[];
      expect(params[1]).toBe(200);
    });
  });
});
