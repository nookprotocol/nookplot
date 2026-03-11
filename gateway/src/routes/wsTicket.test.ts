import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createWsTicketRouter } from "./wsTicket.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_ws_test", api_key_hash: TEST_KEY_HASH });

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createWsTicketRouter(pool as any, TEST_HMAC_SECRET);
  return createTestApp(router);
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  // Auth middleware: agent lookup + credit balance pre-fetch
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/ws/ticket
// ---------------------------------------------------------------------------

describe("POST /v1/ws/ticket", () => {
  it("creates a WebSocket ticket", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    setupAuth(pool);
    // DELETE expired tickets
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    // INSERT new ticket
    pool.query.mockResolvedValueOnce({ rows: [{ id: "ticket-uuid-123" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/ws/ticket")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.ticket).toBe("ticket-uuid-123");
    expect(res.body.expiresIn).toBe(30);
  });

  it("cleans up expired tickets before creating new one", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    setupAuth(pool);
    // DELETE expired tickets — verify SQL contains cleanup logic
    pool.query.mockResolvedValueOnce({ rowCount: 2 });
    // INSERT new ticket
    pool.query.mockResolvedValueOnce({ rows: [{ id: "ticket-new" }], rowCount: 1 });

    const res = await request(app)
      .post("/v1/ws/ticket")
      .set(authHeader());

    expect(res.status).toBe(200);

    // Verify the DELETE query was called with agent ID
    const deleteCall = pool.query.mock.calls[2]; // [0] auth agent, [1] auth credits, [2] delete
    const deleteSql = deleteCall[0] as string;
    expect(deleteSql).toContain("DELETE");
    expect(deleteSql).toContain("ws_tickets");
    expect(deleteCall[1]).toEqual([TEST_AGENT.id]);
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).post("/v1/ws/ticket");

    expect(res.status).toBe(401);
  });

  it("returns 500 on DB error", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    setupAuth(pool);
    // DELETE succeeds
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    // INSERT fails
    pool.query.mockRejectedValueOnce(new Error("table missing"));

    const res = await request(app)
      .post("/v1/ws/ticket")
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("WebSocket ticket");
  });
});
