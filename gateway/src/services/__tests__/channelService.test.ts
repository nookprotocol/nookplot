import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelService } from "../channelService.js";
import type { ChannelRow, ChannelMemberRow, ChannelMessageRow } from "../channelService.js";

// ============================================================
//  Mock factories
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockMessageBus() {
  return { publish: vi.fn(), subscribe: vi.fn(), subscribePattern: vi.fn(), unsubscribe: vi.fn(), shutdown: vi.fn() };
}

// ============================================================
//  Fixture data
// ============================================================

const CHANNEL_ID = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const AGENT_ID   = "cccccccc-4444-5555-6666-dddddddddddd";

const CHANNEL_ROW: ChannelRow = {
  id: CHANNEL_ID,
  slug: "general",
  name: "General",
  description: "A general channel",
  channel_type: "custom",
  source_id: null,
  creator_id: AGENT_ID,
  max_members: 0,
  is_public: true,
  metadata: {},
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

const MEMBER_ROW: ChannelMemberRow = {
  id: "mmmmmmmm-1111-2222-3333-nnnnnnnnnnnn",
  channel_id: CHANNEL_ID,
  agent_id: AGENT_ID,
  role: "member",
  joined_at: "2024-01-01T00:00:00.000Z",
};

const MESSAGE_ROW: ChannelMessageRow = {
  id: "eeeeeeee-7777-8888-9999-ffffffffffff",
  channel_id: CHANNEL_ID,
  from_agent_id: AGENT_ID,
  message_type: "text",
  content: "Hello, world!",
  metadata: {},
  signature: null,
  created_at: "2024-01-01T00:00:00.000Z",
};

// ============================================================
//  Tests
// ============================================================

describe("ChannelService", () => {
  // ----------------------------------------------------------
  //  createChannel
  // ----------------------------------------------------------
  describe("createChannel", () => {
    it("applies default values when optional fields are omitted", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...CHANNEL_ROW }] });

      const result = await service.createChannel({ slug: "general", name: "General" });

      expect(result).toEqual(CHANNEL_ROW);

      // Verify the INSERT was called with correct defaults:
      // channelType="custom", maxMembers=0, isPublic=true, metadata={}
      const call = pool.query.mock.calls[0];
      const params = call[1] as unknown[];
      expect(params[3]).toBe("custom");   // channelType
      expect(params[4]).toBeNull();       // sourceId
      expect(params[5]).toBeNull();       // creatorId
      expect(params[6]).toBe(0);          // maxMembers
      expect(params[7]).toBe(true);       // isPublic
      expect(params[8]).toBe("{}");       // metadata JSON
      expect(params[9]).toEqual([]);      // tags (empty)
    });

    it("stores provided custom values verbatim", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);

      const customRow: ChannelRow = {
        ...CHANNEL_ROW,
        channel_type: "community",
        source_id: "src-001",
        creator_id: AGENT_ID,
        max_members: 50,
        is_public: false,
        metadata: { theme: "dark" },
      };
      pool.query.mockResolvedValueOnce({ rows: [customRow] });

      const result = await service.createChannel({
        slug: "private-community",
        name: "Private Community",
        channelType: "community",
        sourceId: "src-001",
        creatorId: AGENT_ID,
        maxMembers: 50,
        isPublic: false,
        metadata: { theme: "dark" },
      });

      expect(result.channel_type).toBe("community");
      expect(result.max_members).toBe(50);
      expect(result.is_public).toBe(false);

      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(params[3]).toBe("community");
      expect(params[4]).toBe("src-001");
      expect(params[5]).toBe(AGENT_ID);
      expect(params[6]).toBe(50);
      expect(params[7]).toBe(false);
      expect(params[8]).toBe(JSON.stringify({ theme: "dark" }));
    });

    it("normalizes tags (trims, lowercases, deduplicates, applies aliases)", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...CHANNEL_ROW }] });

      await service.createChannel({
        slug: "dev",
        name: "Dev",
        // "JS" → alias "javascript", "  TypeScript " → "typescript", duplicate "javascript"
        tags: ["JS", "  TypeScript ", "JavaScript"],
      });

      const params = pool.query.mock.calls[0][1] as unknown[];
      const tags = params[9] as string[];
      // JS → javascript (alias), TypeScript → typescript, JavaScript → javascript (duplicate, dropped)
      expect(tags).toEqual(["javascript", "typescript"]);
    });

    it("publishes entity:channel event via messageBus when bus is set", async () => {
      const pool = createMockPool();
      const bus = createMockMessageBus();
      const service = new ChannelService(pool);
      service.setMessageBus(bus);
      pool.query.mockResolvedValueOnce({ rows: [{ ...CHANNEL_ROW }] });

      await service.createChannel({ slug: "general", name: "General" });

      expect(bus.publish).toHaveBeenCalledOnce();
      expect(bus.publish).toHaveBeenCalledWith(
        "entity:channel",
        expect.objectContaining({
          type: "entity.created",
          data: expect.objectContaining({ entityType: "channel" }),
        }),
      );
    });

    it("does not call messageBus when no bus is set", async () => {
      const pool = createMockPool();
      const bus = createMockMessageBus();
      const service = new ChannelService(pool);
      // intentionally NOT calling setMessageBus
      pool.query.mockResolvedValueOnce({ rows: [{ ...CHANNEL_ROW }] });

      await service.createChannel({ slug: "general", name: "General" });

      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  //  Lookup methods
  // ----------------------------------------------------------
  describe("getChannel", () => {
    it("returns the channel row when found", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...CHANNEL_ROW }] });

      const result = await service.getChannel(CHANNEL_ID);
      expect(result).toEqual(CHANNEL_ROW);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE id = $1"),
        [CHANNEL_ID],
      );
    });

    it("returns null when channel is not found", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getChannel("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("getChannelBySlug", () => {
    it("returns null when slug does not exist", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getChannelBySlug("no-such-slug");
      expect(result).toBeNull();
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE slug = $1"),
        ["no-such-slug"],
      );
    });
  });

  describe("getChannelBySourceId", () => {
    it("returns null when source_id does not exist", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getChannelBySourceId("missing-source");
      expect(result).toBeNull();
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE source_id = $1"),
        ["missing-source"],
      );
    });
  });

  // ----------------------------------------------------------
  //  listChannels
  // ----------------------------------------------------------
  describe("listChannels", () => {
    it("passes channelType filter into query when type is valid", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...CHANNEL_ROW, channel_type: "community" }] });

      const result = await service.listChannels({ channelType: "community" });

      expect(result).toHaveLength(1);
      const sql = pool.query.mock.calls[0][0] as string;
      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(sql).toContain("channel_type = $1");
      expect(params[0]).toBe("community");
    });

    it("returns empty array immediately for invalid channelType without querying", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);

      const result = await service.listChannels({ channelType: "injection'; DROP TABLE channels;--" });

      expect(result).toEqual([]);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("clamps limit to 200 when a larger value is supplied", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.listChannels({ limit: 9999 });

      const params = pool.query.mock.calls[0][1] as unknown[];
      // With no filters, limit is the first pushed param (index 0)
      expect(params[0]).toBe(200);
    });
  });

  // ----------------------------------------------------------
  //  joinChannel / leaveChannel / isMember
  // ----------------------------------------------------------
  describe("joinChannel", () => {
    it("returns the inserted member row on a fresh join", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      // INSERT RETURNING returns the new row
      pool.query.mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW }] });

      const result = await service.joinChannel(CHANNEL_ID, AGENT_ID);

      expect(result).toEqual(MEMBER_ROW);
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("ON CONFLICT");
      expect(pool.query.mock.calls[0][1]).toEqual([CHANNEL_ID, AGENT_ID, "member"]);
    });

    it("falls back to SELECT when member already exists (ON CONFLICT DO NOTHING returns empty)", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      // INSERT returns nothing (conflict)
      pool.query.mockResolvedValueOnce({ rows: [] });
      // SELECT returns the existing row
      pool.query.mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, role: "admin" }] });

      const result = await service.joinChannel(CHANNEL_ID, AGENT_ID, "admin");

      expect(result.role).toBe("admin");
      expect(pool.query).toHaveBeenCalledTimes(2);
      const selectSql = pool.query.mock.calls[1][0] as string;
      expect(selectSql).toContain("SELECT");
      expect(pool.query.mock.calls[1][1]).toEqual([CHANNEL_ID, AGENT_ID]);
    });
  });

  describe("leaveChannel", () => {
    it("returns true when a row was deleted", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.leaveChannel(CHANNEL_ID, AGENT_ID);

      expect(result).toBe(true);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM channel_members"),
        [CHANNEL_ID, AGENT_ID],
      );
    });

    it("returns false when the agent was not a member", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      const result = await service.leaveChannel(CHANNEL_ID, "nonexistent-agent");
      expect(result).toBe(false);
    });
  });

  describe("isMember", () => {
    it("returns true when count > 0", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ count: "1" }] });

      const result = await service.isMember(CHANNEL_ID, AGENT_ID);
      expect(result).toBe(true);
    });

    it("returns false when count is 0", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }] });

      const result = await service.isMember(CHANNEL_ID, "stranger");
      expect(result).toBe(false);
    });
  });

  // ----------------------------------------------------------
  //  sendMessage
  // ----------------------------------------------------------
  describe("sendMessage", () => {
    it("defaults messageType to 'text' and quarantined to false", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...MESSAGE_ROW }] });

      const result = await service.sendMessage({
        channelId: CHANNEL_ID,
        fromAgentId: AGENT_ID,
        content: "Hello, world!",
      });

      expect(result).toEqual(MESSAGE_ROW);

      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(params[2]).toBe("text");      // messageType
      expect(params[4]).toBe("{}");        // metadata JSON
      expect(params[5]).toBeNull();        // signature
      expect(params[6]).toBe(false);       // quarantined
    });

    it("stores the quarantined flag when explicitly set to true", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      const quarantinedRow = { ...MESSAGE_ROW, id: "qqqqqqqq-0000-0000-0000-qqqqqqqqqqqq" };
      pool.query.mockResolvedValueOnce({ rows: [quarantinedRow] });

      await service.sendMessage({
        channelId: CHANNEL_ID,
        fromAgentId: AGENT_ID,
        content: "suspicious content",
        messageType: "text",
        quarantined: true,
      });

      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(params[6]).toBe(true);
    });
  });

  // ----------------------------------------------------------
  //  getHistory
  // ----------------------------------------------------------
  describe("getHistory", () => {
    it("excludes quarantined messages by default (appends quarantined = false condition)", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...MESSAGE_ROW }] });

      const result = await service.getHistory(CHANNEL_ID);

      expect(result).toHaveLength(1);
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain("quarantined = false");
      expect(pool.query.mock.calls[0][1][0]).toBe(CHANNEL_ID);
    });

    it("includes quarantined messages when includeQuarantined is true", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [{ ...MESSAGE_ROW }] });

      await service.getHistory(CHANNEL_ID, { includeQuarantined: true });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).not.toContain("quarantined = false");
    });

    it("adds a 'before' timestamp condition when the filter is supplied", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [] });

      const before = "2024-06-01T12:00:00.000Z";
      await service.getHistory(CHANNEL_ID, { before });

      const sql = pool.query.mock.calls[0][0] as string;
      const params = pool.query.mock.calls[0][1] as unknown[];
      expect(sql).toContain("created_at < $2");
      expect(params[1]).toBe(before);
    });

    it("clamps limit to 200 when a larger value is supplied", async () => {
      const pool = createMockPool();
      const service = new ChannelService(pool);
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getHistory(CHANNEL_ID, { limit: 5000 });

      // With no 'before' filter and no quarantined filter, limit is params[1]
      const params = pool.query.mock.calls[0][1] as unknown[];
      const limitValue = params.find((p) => p === 200);
      expect(limitValue).toBe(200);
    });
  });
});
