/**
 * Gateway HTTP client tests — validates request handling, retries, and error cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gatewayRequest, gatewayRequestWithRetry, isGatewayError } from "../gateway.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(headers ?? {}),
  } as Response;
}

describe("isGatewayError", () => {
  it("returns true for null", () => {
    expect(isGatewayError(null)).toBe(true);
  });

  it("returns true for undefined", () => {
    expect(isGatewayError(undefined)).toBe(true);
  });

  it("returns true for error response", () => {
    expect(isGatewayError({ ok: false, status: 400, error: "bad" })).toBe(true);
  });

  it("returns false for success response", () => {
    expect(isGatewayError({ ok: true, status: 200, data: {} })).toBe(false);
  });
});

describe("gatewayRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes a successful GET request", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agents: [] }));

    const result = await gatewayRequest("https://gw.test", "GET", "/v1/agents");
    expect(result).toEqual({ ok: true, status: 200, data: { agents: [] } });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://gw.test/v1/agents",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("makes a POST request with body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: "abc" }));

    const result = await gatewayRequest("https://gw.test", "POST", "/v1/posts", {
      body: { title: "Hello" },
    });
    expect(result).toEqual({ ok: true, status: 200, data: { id: "abc" } });
  });

  it("sends authorization header when apiKey provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await gatewayRequest("https://gw.test", "GET", "/v1/me", { apiKey: "nk_test" });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe("Bearer nk_test");
  });

  it("returns error for non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { error: "Not found" }));

    const result = await gatewayRequest("https://gw.test", "GET", "/v1/missing");
    expect(isGatewayError(result)).toBe(true);
    if (isGatewayError(result)) {
      expect(result.status).toBe(404);
      expect(result.error).toContain("Not found");
    }
  });

  it("returns error with retryAfterMs for 429", async () => {
    const resetTime = Math.floor(Date.now() / 1000) + 60;
    mockFetch.mockResolvedValueOnce(
      jsonResponse(429, { message: "Rate limit exceeded" }, { "RateLimit-Reset": String(resetTime) }),
    );

    const result = await gatewayRequest("https://gw.test", "GET", "/v1/agents");
    expect(isGatewayError(result)).toBe(true);
    if (isGatewayError(result)) {
      expect(result.status).toBe(429);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("returns error when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await gatewayRequest("https://gw.test", "GET", "/v1/agents");
    expect(isGatewayError(result)).toBe(true);
    if (isGatewayError(result)) {
      expect(result.status).toBe(0);
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("normalizes trailing slashes in URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await gatewayRequest("https://gw.test///", "GET", "/v1/agents");
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe("https://gw.test/v1/agents");
  });

  it("handles path without leading slash", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await gatewayRequest("https://gw.test", "GET", "v1/agents");
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe("https://gw.test/v1/agents");
  });
});

describe("gatewayRequestWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await gatewayRequestWithRetry("https://gw.test", "GET", "/v1/agents");
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns immediately on non-429 error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "Internal" }));

    const result = await gatewayRequestWithRetry("https://gw.test", "GET", "/v1/agents");
    expect(isGatewayError(result)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and returns success", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(429, { message: "Rate limited" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await gatewayRequestWithRetry("https://gw.test", "GET", "/v1/agents");
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
