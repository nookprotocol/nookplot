import { describe, it, expect, vi, beforeEach } from "vitest";
import { InboxService } from "./inboxService.js";
import { createMockPool } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeMessageRow(overrides?: Record<string, unknown>) {
  return {
    id: "msg_001",
    from_agent_id: "agt_sender",
    to_agent_id: "agt_recipient",
    message_type: "text",
    content: "Hello",
    metadata: null,
    read_at: null,
    created_at: "2025-06-01T00:00:00Z",
    quarantined: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  send
// ---------------------------------------------------------------------------

describe("InboxService — send", () => {
  it("inserts a message and returns the row", async () => {
    const pool = createMockPool();
    const row = makeMessageRow();
    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const svc = new InboxService(pool as any);
    const result = await svc.send({
      fromAgentId: "agt_sender",
      toAgentId: "agt_recipient",
      content: "Hello",
    });

    expect(result.id).toBe("msg_001");
    expect(result.content).toBe("Hello");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO agent_messages"),
      expect.arrayContaining(["agt_sender", "agt_recipient", "text", "Hello"]),
    );
  });

  it("passes quarantined flag", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeMessageRow({ quarantined: true })], rowCount: 1 });

    const svc = new InboxService(pool as any);
    await svc.send({
      fromAgentId: "agt_sender",
      toAgentId: "agt_recipient",
      content: "suspect",
      quarantined: true,
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO agent_messages"),
      expect.arrayContaining([true]),
    );
  });

  it("serializes metadata as JSON", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeMessageRow()], rowCount: 1 });

    const svc = new InboxService(pool as any);
    await svc.send({
      fromAgentId: "agt_sender",
      toAgentId: "agt_recipient",
      content: "hi",
      metadata: { key: "value" },
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([JSON.stringify({ key: "value" })]),
    );
  });
});

// ---------------------------------------------------------------------------
//  getMessages
// ---------------------------------------------------------------------------

describe("InboxService — getMessages", () => {
  it("returns messages for agent", async () => {
    const pool = createMockPool();
    const rows = [makeMessageRow(), makeMessageRow({ id: "msg_002" })];
    pool.query.mockResolvedValueOnce({ rows, rowCount: 2 });

    const svc = new InboxService(pool as any);
    const result = await svc.getMessages("agt_recipient");

    expect(result).toHaveLength(2);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("to_agent_id = $1"),
      expect.arrayContaining(["agt_recipient"]),
    );
  });

  it("applies fromAgentId filter", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    await svc.getMessages("agt_recipient", { fromAgentId: "agt_sender" });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("from_agent_id"),
      expect.arrayContaining(["agt_sender"]),
    );
  });

  it("applies unreadOnly filter", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    await svc.getMessages("agt_recipient", { unreadOnly: true });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("read_at IS NULL"),
      expect.anything(),
    );
  });

  it("excludes quarantined by default", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    await svc.getMessages("agt_recipient");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("quarantined = false"),
      expect.anything(),
    );
  });

  it("includes quarantined when requested", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    await svc.getMessages("agt_recipient", { includeQuarantined: true });

    expect(pool.query).toHaveBeenCalledWith(
      expect.not.stringContaining("quarantined = false"),
      expect.anything(),
    );
  });

  it("clamps limit to 200", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    await svc.getMessages("agt_recipient", { limit: 999 });

    // The limit parameter (200) should be in the params array
    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([200]),
    );
  });
});

// ---------------------------------------------------------------------------
//  markRead
// ---------------------------------------------------------------------------

describe("InboxService — markRead", () => {
  it("updates read_at for the correct message and owner", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = new InboxService(pool as any);
    const result = await svc.markRead("msg_001", "agt_recipient");

    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("read_at"),
      ["msg_001", "agt_recipient"],
    );
  });

  it("returns false when message not found or already read", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    const result = await svc.markRead("nonexistent", "agt_recipient");

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getUnreadCount
// ---------------------------------------------------------------------------

describe("InboxService — getUnreadCount", () => {
  it("returns unread count", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 });

    const svc = new InboxService(pool as any);
    const count = await svc.getUnreadCount("agt_recipient");

    expect(count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  deleteMessage
// ---------------------------------------------------------------------------

describe("InboxService — deleteMessage", () => {
  it("deletes message owned by recipient", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = new InboxService(pool as any);
    const result = await svc.deleteMessage("msg_001", "agt_recipient");

    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM agent_messages"),
      ["msg_001", "agt_recipient"],
    );
  });

  it("returns false when message not found or wrong owner", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new InboxService(pool as any);
    const result = await svc.deleteMessage("msg_001", "agt_wrong");

    expect(result).toBe(false);
  });
});
