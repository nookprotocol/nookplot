import { describe, it, expect, vi, afterEach } from "vitest";
import { ChannelSyncer } from "./channelSyncer.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockChannelService() {
  return {
    getChannelBySourceId: vi.fn().mockResolvedValue(null),
    createChannel: vi.fn().mockResolvedValue({ id: "ch_new" }),
    joinChannel: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
//  sync — communities
// ---------------------------------------------------------------------------

describe("ChannelSyncer — syncCommunities", () => {
  it("creates channels for new communities", async () => {
    const pool = createMockPool();
    const channelSvc = createMockChannelService();

    // Community query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "ai-agents", total_posts: 100 }],
      rowCount: 1,
    });
    // Guild query (for the parallel Promise.all)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const syncer = new ChannelSyncer(pool as any, channelSvc as any);
    await syncer.sync();

    expect(channelSvc.getChannelBySourceId).toHaveBeenCalledWith("ai-agents");
    expect(channelSvc.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "community-ai-agents",
        channelType: "community",
        sourceId: "ai-agents",
        isPublic: true,
      }),
    );
  });

  it("skips communities with existing channels", async () => {
    const pool = createMockPool();
    const channelSvc = createMockChannelService();
    channelSvc.getChannelBySourceId.mockResolvedValue({ id: "ch_existing" });

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "ai-agents", total_posts: 50 }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // guilds

    const syncer = new ChannelSyncer(pool as any, channelSvc as any);
    await syncer.sync();

    expect(channelSvc.createChannel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  sync — guilds
// ---------------------------------------------------------------------------

describe("ChannelSyncer — syncGuilds", () => {
  it("creates channels for approved guilds and syncs members", async () => {
    const pool = createMockPool();
    const channelSvc = createMockChannelService();

    // Community query (empty)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Guild query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "guild_1",
        guild_id: "42",
        name: "AI Builders",
        description_cid: null,
        status: "approved",
      }],
      rowCount: 1,
    });
    // Guild members
    pool.query.mockResolvedValueOnce({
      rows: [{ member_id: "0xMember1" }],
      rowCount: 1,
    });
    // Lookup agent by address
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_1" }],
      rowCount: 1,
    });

    const syncer = new ChannelSyncer(pool as any, channelSvc as any);
    await syncer.sync();

    expect(channelSvc.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "guild",
        sourceId: "guild_1",
        isPublic: false,
      }),
    );
    expect(channelSvc.joinChannel).toHaveBeenCalledWith("ch_new", "agt_1");
  });

  it("syncs members to existing guild channel without recreating", async () => {
    const pool = createMockPool();
    const channelSvc = createMockChannelService();

    // Community query (empty)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Guild query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "guild_1",
        guild_id: "42",
        name: "AI Builders",
        description_cid: null,
        status: "approved",
      }],
      rowCount: 1,
    });

    // getChannelBySourceId returns existing channel for this guild
    channelSvc.getChannelBySourceId.mockImplementation(async (sourceId: string) => {
      if (sourceId === "guild_1") return { id: "ch_existing" };
      return null;
    });

    // Guild members
    pool.query.mockResolvedValueOnce({
      rows: [{ member_id: "0xNewMember" }],
      rowCount: 1,
    });
    // Agent lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_2" }],
      rowCount: 1,
    });

    const syncer = new ChannelSyncer(pool as any, channelSvc as any);
    await syncer.sync();

    expect(channelSvc.createChannel).not.toHaveBeenCalled();
    expect(channelSvc.joinChannel).toHaveBeenCalledWith("ch_existing", "agt_2");
  });

  it("skips members not registered as agents", async () => {
    const pool = createMockPool();
    const channelSvc = createMockChannelService();

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // communities
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "guild_1",
        guild_id: "42",
        name: "Test",
        description_cid: null,
        status: "approved",
      }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ member_id: "0xUnknown" }],
      rowCount: 1,
    });
    // Agent lookup — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const syncer = new ChannelSyncer(pool as any, channelSvc as any);
    await syncer.sync();

    expect(channelSvc.joinChannel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  start / stop
// ---------------------------------------------------------------------------

describe("ChannelSyncer — start/stop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts and stops periodic sync", () => {
    const pool = createMockPool();
    const channelSvc = createMockChannelService();

    // Mock sync queries for initial call
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    vi.useFakeTimers();

    const syncer = new ChannelSyncer(pool as any, channelSvc as any, 5000);
    syncer.start();
    expect((syncer as any).timer).not.toBeNull();

    syncer.stop();
    expect((syncer as any).timer).toBeNull();

    vi.useRealTimers();
  });
});
