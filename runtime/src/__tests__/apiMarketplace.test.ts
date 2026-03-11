import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiMarketplaceManager } from "../api-marketplace.js";

// Mock ConnectionManager
function createMockConnection() {
  return {
    request: vi.fn().mockResolvedValue({ ok: true }),
    gatewayUrl: "https://gateway.nookplot.com",
    apiKey: "test-api-key",
  };
}

describe("ApiMarketplaceManager", () => {
  let connection: ReturnType<typeof createMockConnection>;
  let manager: ApiMarketplaceManager;

  beforeEach(() => {
    connection = createMockConnection();
    manager = new ApiMarketplaceManager(connection as any);
  });

  // ── Read Operations ──────────────────────────────────────────

  describe("searchAvailable", () => {
    it("calls GET /v1/api/availability with no params", async () => {
      await manager.searchAvailable();
      expect(connection.request).toHaveBeenCalledWith("GET", "/v1/api/availability");
    });

    it("passes status filter", async () => {
      await manager.searchAvailable({ status: "online" });
      expect(connection.request).toHaveBeenCalledWith(
        "GET",
        expect.stringContaining("status=online"),
      );
    });

    it("passes minUptime filter", async () => {
      await manager.searchAvailable({ minUptime: 95 });
      expect(connection.request).toHaveBeenCalledWith(
        "GET",
        expect.stringContaining("minUptime=95"),
      );
    });

    it("passes limit and offset", async () => {
      await manager.searchAvailable({ limit: 10, offset: 20 });
      const url = connection.request.mock.calls[0][1] as string;
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=20");
    });
  });

  describe("getAvailability", () => {
    it("calls GET /v1/api/availability/:listingId", async () => {
      await manager.getAvailability(42);
      expect(connection.request).toHaveBeenCalledWith("GET", "/v1/api/availability/42");
    });
  });

  describe("getUsage", () => {
    it("calls GET /v1/api/usage/:agreementId", async () => {
      await manager.getUsage(7);
      expect(connection.request).toHaveBeenCalledWith(
        "GET",
        "/v1/api/usage/7?limit=50&offset=0",
      );
    });

    it("passes custom limit and offset", async () => {
      await manager.getUsage(7, 10, 5);
      expect(connection.request).toHaveBeenCalledWith(
        "GET",
        "/v1/api/usage/7?limit=10&offset=5",
      );
    });
  });

  // ── Provider Operations ──────────────────────────────────────

  describe("registerEndpoint", () => {
    it("calls POST /v1/api/register-endpoint", async () => {
      await manager.registerEndpoint({
        listingId: 42,
        proxyUrl: "https://my-agent.example.com/proxy",
        rateLimitRpm: 100,
      });
      expect(connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/api/register-endpoint",
        {
          listingId: 42,
          proxyUrl: "https://my-agent.example.com/proxy",
          rateLimitRpm: 100,
        },
      );
    });
  });

  describe("heartbeat", () => {
    it("calls POST /v1/api/heartbeat", async () => {
      await manager.heartbeat({ listingId: 42, latencyMs: 150 });
      expect(connection.request).toHaveBeenCalledWith(
        "POST",
        "/v1/api/heartbeat",
        { listingId: 42, latencyMs: 150 },
      );
    });
  });

  // ── Proxy Signing ────────────────────────────────────────────

  describe("buildProxySignPayload", () => {
    it("returns EIP-712 domain, types, and value", () => {
      const result = manager.buildProxySignPayload(1, "POST", "/v1/chat", '{"msg":"hi"}');

      expect(result.domain).toEqual({
        name: "NookplotApiProxy",
        version: "1",
        chainId: 8453,
      });
      expect(result.types.ApiRequest).toHaveLength(3);
      expect(result.value.agreementId).toBe(1n);
      expect(typeof result.value.timestamp).toBe("bigint");
      expect(result.value.requestHash).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it("produces deterministic hash for same inputs", () => {
      const a = manager.buildProxySignPayload(1, "POST", "/v1/chat", '{"msg":"hi"}');
      const b = manager.buildProxySignPayload(1, "POST", "/v1/chat", '{"msg":"hi"}');
      expect(a.value.requestHash).toBe(b.value.requestHash);
    });

    it("produces different hash for different body", () => {
      const a = manager.buildProxySignPayload(1, "POST", "/v1/chat", '{"msg":"hi"}');
      const b = manager.buildProxySignPayload(1, "POST", "/v1/chat", '{"msg":"bye"}');
      expect(a.value.requestHash).not.toBe(b.value.requestHash);
    });
  });
});
