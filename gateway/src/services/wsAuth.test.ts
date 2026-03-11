import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticateWs } from "./wsAuth.js";
import { createMockPool } from "../test/helpers.js";
import { hashApiKey } from "../auth.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const HMAC_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function createMockRequest(queryString: string): any {
  return {
    url: `/ws${queryString}`,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

const mockAgent = {
  id: "agt_1",
  address: "0x1111",
  api_key_hash: "hash",
  api_key_prefix: "nk_test",
  status: "active",
};

// ---------------------------------------------------------------------------
//  ticket-based auth
// ---------------------------------------------------------------------------

describe("authenticateWs — ticket auth", () => {
  it("authenticates with valid ticket", async () => {
    const pool = createMockPool();
    const ticketUUID = "12345678-1234-1234-1234-123456789abc";

    // UPDATE ws_tickets (consume ticket)
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_1" }],
      rowCount: 1,
    });
    // SELECT agent
    pool.query.mockResolvedValueOnce({
      rows: [mockAgent],
      rowCount: 1,
    });

    const req = createMockRequest(`?ticket=${ticketUUID}`);
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).not.toBeNull();
    expect(result!.agent.id).toBe("agt_1");
  });

  it("rejects invalid UUID format", async () => {
    const pool = createMockPool();
    const req = createMockRequest("?ticket=not-a-uuid");
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).toBeNull();
    // No DB queries should have been made
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects expired or used ticket", async () => {
    const pool = createMockPool();
    const ticketUUID = "12345678-1234-1234-1234-123456789abc";

    // UPDATE returns no rows (ticket already used or expired)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const req = createMockRequest(`?ticket=${ticketUUID}`);
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).toBeNull();
  });

  it("rejects ticket for inactive agent", async () => {
    const pool = createMockPool();
    const ticketUUID = "12345678-1234-1234-1234-123456789abc";

    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Agent not found (or inactive)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const req = createMockRequest(`?ticket=${ticketUUID}`);
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  token-based auth (deprecated)
// ---------------------------------------------------------------------------

describe("authenticateWs — token auth (deprecated)", () => {
  it("authenticates with valid API key (before cutoff)", async () => {
    const pool = createMockPool();
    // Generate a properly formatted API key
    const fakeKey = "nk_" + "A".repeat(64);
    const keyHash = hashApiKey(fakeKey, HMAC_SECRET);

    pool.query.mockResolvedValueOnce({
      rows: [{ ...mockAgent, api_key_hash: keyHash }],
      rowCount: 1,
    });

    const req = createMockRequest(`?token=${fakeKey}`);
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).not.toBeNull();
    expect(result!.agent.id).toBe("agt_1");
  });

  it("rejects invalid API key", async () => {
    const pool = createMockPool();
    const fakeKey = "nk_" + "B".repeat(64);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const req = createMockRequest(`?token=${fakeKey}`);
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).toBeNull();
  });

  it("rejects non-nk_ prefixed token", async () => {
    const pool = createMockPool();
    const req = createMockRequest("?token=invalid_key_format");
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  no auth
// ---------------------------------------------------------------------------

describe("authenticateWs — missing auth", () => {
  it("returns null when no token or ticket provided", async () => {
    const pool = createMockPool();
    const req = createMockRequest("");
    const result = await authenticateWs(req, pool as any, HMAC_SECRET);

    expect(result).toBeNull();
  });
});
