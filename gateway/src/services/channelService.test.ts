import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelService } from "./channelService.js";
import { createMockPool } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeChannelRow(overrides?: Record<string, unknown>) {
  return {
    id: "ch_001",
    slug: "test-channel",
    name: "Test Channel",
    description: null,
    channel_type: "custom",
    source_id: null,
    creator_id: "agt_creator",
    max_members: 0,
    is_public: true,
    metadata: {},
    created_at: "2025-06-01T00:00:00Z",
    updated_at: "2025-06-01T00:00:00Z",
    ...overrides,
  };
}

function makeMemberRow(overrides?: Record<string, unknown>) {
  return {
    id: "mem_001",
    channel_id: "ch_001",
    agent_id: "agt_member",
    role: "member",
    joined_at: "2025-06-01T00:00:00Z",
    ...overrides,
  };
}

function makeMessageRow(overrides?: Record<string, unknown>) {
  return {
    id: "cmsg_001",
    channel_id: "ch_001",
    from_agent_id: "agt_sender",
    message_type: "text",
    content: "Hello channel",
    metadata: {},
    signature: null,
    created_at: "2025-06-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  createChannel
// ---------------------------------------------------------------------------

describe("ChannelService — createChannel", () => {
  it("inserts channel with defaults", async () => {
    const pool = createMockPool();
    const row = makeChannelRow();
    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.createChannel({ slug: "test-channel", name: "Test Channel" });

    expect(result.id).toBe("ch_001");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO channels"),
      expect.arrayContaining(["test-channel", "Test Channel"]),
    );
  });

  it("passes channelType and sourceId", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeChannelRow({ channel_type: "project", source_id: "proj_1" })], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    await svc.createChannel({ slug: "proj-ch", name: "Project", channelType: "project", sourceId: "proj_1" });

    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["project", "proj_1"]),
    );
  });
});

// ---------------------------------------------------------------------------
//  getChannel / getChannelBySlug / getChannelBySourceId
// ---------------------------------------------------------------------------

describe("ChannelService — getChannel", () => {
  it("returns channel by id", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeChannelRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.getChannel("ch_001");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ch_001");
  });

  it("returns null when not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    const result = await svc.getChannel("nonexistent");

    expect(result).toBeNull();
  });
});

describe("ChannelService — getChannelBySlug", () => {
  it("returns channel by slug", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeChannelRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.getChannelBySlug("test-channel");

    expect(result).not.toBeNull();
    expect(result!.slug).toBe("test-channel");
  });
});

describe("ChannelService — getChannelBySourceId", () => {
  it("returns channel by source_id", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeChannelRow({ source_id: "src_1" })], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.getChannelBySourceId("src_1");

    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  listChannels
// ---------------------------------------------------------------------------

describe("ChannelService — listChannels", () => {
  it("returns channels with no filters", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeChannelRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.listChannels();

    expect(result).toHaveLength(1);
  });

  it("filters by channelType using allowlist", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.listChannels({ channelType: "community" });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("channel_type"),
      expect.arrayContaining(["community"]),
    );
  });

  it("returns empty for invalid channelType", async () => {
    const pool = createMockPool();

    const svc = new ChannelService(pool as any);
    const result = await svc.listChannels({ channelType: "malicious_type" });

    expect(result).toHaveLength(0);
    // Should NOT query the DB for invalid types
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("clamps limit to 200", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.listChannels({ limit: 999 });

    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([200]),
    );
  });
});

// ---------------------------------------------------------------------------
//  joinChannel / leaveChannel
// ---------------------------------------------------------------------------

describe("ChannelService — joinChannel", () => {
  it("inserts new membership", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeMemberRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.joinChannel("ch_001", "agt_member");

    expect(result.agent_id).toBe("agt_member");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT"),
      expect.arrayContaining(["ch_001", "agt_member", "member"]),
    );
  });

  it("returns existing membership on conflict (idempotent)", async () => {
    const pool = createMockPool();
    // INSERT returns nothing (already exists)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SELECT existing row
    pool.query.mockResolvedValueOnce({ rows: [makeMemberRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.joinChannel("ch_001", "agt_member");

    expect(result.agent_id).toBe("agt_member");
  });
});

describe("ChannelService — leaveChannel", () => {
  it("deletes membership", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.leaveChannel("ch_001", "agt_member");

    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM channel_members"),
      ["ch_001", "agt_member"],
    );
  });

  it("returns false when not a member", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    const result = await svc.leaveChannel("ch_001", "agt_nobody");

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getMembers / isMember / getMemberCount
// ---------------------------------------------------------------------------

describe("ChannelService — getMembers", () => {
  it("returns members list", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeMemberRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.getMembers("ch_001");

    expect(result).toHaveLength(1);
  });

  it("clamps limit to 200", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.getMembers("ch_001", 500);

    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      ["ch_001", 200, 0],
    );
  });
});

describe("ChannelService — isMember", () => {
  it("returns true when member", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    expect(await svc.isMember("ch_001", "agt_member")).toBe(true);
  });

  it("returns false when not member", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    expect(await svc.isMember("ch_001", "agt_nobody")).toBe(false);
  });
});

describe("ChannelService — getMemberCount", () => {
  it("returns count", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ count: "42" }], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    expect(await svc.getMemberCount("ch_001")).toBe(42);
  });
});

// ---------------------------------------------------------------------------
//  sendMessage / getHistory
// ---------------------------------------------------------------------------

describe("ChannelService — sendMessage", () => {
  it("inserts message", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeMessageRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.sendMessage({
      channelId: "ch_001",
      fromAgentId: "agt_sender",
      content: "Hello channel",
    });

    expect(result.content).toBe("Hello channel");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO channel_messages"),
      expect.arrayContaining(["ch_001", "agt_sender", "text", "Hello channel"]),
    );
  });
});

describe("ChannelService — getHistory", () => {
  it("returns messages for channel", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeMessageRow()], rowCount: 1 });

    const svc = new ChannelService(pool as any);
    const result = await svc.getHistory("ch_001");

    expect(result).toHaveLength(1);
  });

  it("excludes quarantined by default", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.getHistory("ch_001");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("quarantined = false"),
      expect.anything(),
    );
  });

  it("includes quarantined when requested", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.getHistory("ch_001", { includeQuarantined: true });

    expect(pool.query).toHaveBeenCalledWith(
      expect.not.stringContaining("quarantined = false"),
      expect.anything(),
    );
  });

  it("supports cursor-based pagination (before)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.getHistory("ch_001", { before: "2025-06-01T00:00:00Z" });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("created_at <"),
      expect.arrayContaining(["2025-06-01T00:00:00Z"]),
    );
  });

  it("clamps limit to 200", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ChannelService(pool as any);
    await svc.getHistory("ch_001", { limit: 500 });

    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([200]),
    );
  });
});
