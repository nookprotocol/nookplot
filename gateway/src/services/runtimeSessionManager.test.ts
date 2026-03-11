import { describe, it, expect, vi, afterEach } from "vitest";
import { RuntimeSessionManager } from "./runtimeSessionManager.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  createSession
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — createSession", () => {
  it("disconnects existing sessions and creates a new one", async () => {
    const pool = createMockPool();
    // Disconnect existing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Insert new session
    pool.query.mockResolvedValueOnce({
      rows: [{ connected_at: new Date("2025-06-01T00:00:00Z") }],
      rowCount: 1,
    });

    const mgr = new RuntimeSessionManager(pool as any);
    const result = await mgr.createSession("agt_1", { runtime: "typescript" });

    expect(result.sessionId).toBeDefined();
    expect(result.sessionId).toHaveLength(64); // 32 bytes hex
    expect(result.connectedAt).toContain("2025-06-01");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
//  heartbeat
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — heartbeat", () => {
  it("returns true when session updated", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new RuntimeSessionManager(pool as any);
    const result = await mgr.heartbeat("session_123");

    expect(result).toBe(true);
  });

  it("returns false when session not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new RuntimeSessionManager(pool as any);
    const result = await mgr.heartbeat("nonexistent");

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  disconnect
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — disconnect", () => {
  it("disconnects with ownership verification", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new RuntimeSessionManager(pool as any);
    const result = await mgr.disconnect("session_123", "agt_1");

    expect(result).toBe(true);
    // Should include both session_id and agent_id params
    expect(pool.query.mock.calls[0][1]).toEqual(["session_123", "agt_1"]);
  });

  it("disconnects without ownership (internal use)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new RuntimeSessionManager(pool as any);
    const result = await mgr.disconnect("session_123");

    expect(result).toBe(true);
    // Should only include session_id
    expect(pool.query.mock.calls[0][1]).toEqual(["session_123"]);
  });

  it("returns false when session not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new RuntimeSessionManager(pool as any);
    const result = await mgr.disconnect("nonexistent", "agt_1");

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  disconnectAgent
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — disconnectAgent", () => {
  it("returns number of disconnected sessions", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 3 });

    const mgr = new RuntimeSessionManager(pool as any);
    const count = await mgr.disconnectAgent("agt_1");

    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
//  getActiveSession
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — getActiveSession", () => {
  it("returns active session", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "row_1",
        agent_id: "agt_1",
        session_id: "sess_abc",
        connected_at: new Date("2025-06-01"),
        last_heartbeat: new Date("2025-06-01"),
        metadata: { runtime: "typescript" },
        disconnected_at: null,
      }],
      rowCount: 1,
    });

    const mgr = new RuntimeSessionManager(pool as any);
    const session = await mgr.getActiveSession("agt_1");

    expect(session).not.toBeNull();
    expect(session!.agentId).toBe("agt_1");
    expect(session!.sessionId).toBe("sess_abc");
    expect(session!.metadata).toEqual({ runtime: "typescript" });
    expect(session!.disconnectedAt).toBeNull();
  });

  it("returns null when no active session", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new RuntimeSessionManager(pool as any);
    const session = await mgr.getActiveSession("agt_1");

    expect(session).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getPresence
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — getPresence", () => {
  it("returns connected agent presence list", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        agent_id: "agt_1",
        address: "0x1111",
        display_name: "TestBot",
        connected_at: new Date("2025-06-01"),
        last_heartbeat: new Date("2025-06-01"),
      }],
      rowCount: 1,
    });

    const mgr = new RuntimeSessionManager(pool as any);
    const presence = await mgr.getPresence();

    expect(presence).toHaveLength(1);
    expect(presence[0].agentId).toBe("agt_1");
    expect(presence[0].displayName).toBe("TestBot");
    // sessionId should NOT be in presence (security)
    expect((presence[0] as any).sessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  getActiveCount
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — getActiveCount", () => {
  it("returns count of active sessions", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ count: "5" }],
      rowCount: 1,
    });

    const mgr = new RuntimeSessionManager(pool as any);
    const count = await mgr.getActiveCount();

    expect(count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  cleanupStaleSessions
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — cleanupStaleSessions", () => {
  it("disconnects sessions older than timeout", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const mgr = new RuntimeSessionManager(pool as any, 60_000);
    const cleaned = await mgr.cleanupStaleSessions();

    expect(cleaned).toBe(2);
    // Verify the timeout date was passed
    const queryParams = pool.query.mock.calls[0][1];
    expect(queryParams[0]).toBeInstanceOf(Date);
  });

  it("returns 0 when no stale sessions", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new RuntimeSessionManager(pool as any);
    const cleaned = await mgr.cleanupStaleSessions();

    expect(cleaned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  startCleanup / stopCleanup
// ---------------------------------------------------------------------------

describe("RuntimeSessionManager — cleanup timer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts and stops periodic cleanup", () => {
    const pool = createMockPool();
    const mgr = new RuntimeSessionManager(pool as any);

    vi.useFakeTimers();

    mgr.startCleanup(1000);
    expect((mgr as any).cleanupTimer).not.toBeNull();

    mgr.stopCleanup();
    expect((mgr as any).cleanupTimer).toBeNull();

    vi.useRealTimers();
  });
});
