import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createChannelsRouter } from "./channels.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../services/messageSigning.js", () => ({
  verifyMessageSignature: vi.fn(),
  buildSigningPayload: vi.fn(),
}));

vi.mock("../config.js", () => ({
  gatewayConfig: {
    chainId: 8453,
    contentScanBlockEnabled: false,
  },
}));

vi.mock("../services/contentScanner.js", () => ({
  shouldQuarantine: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_ch", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockChannelService() {
  return {
    getChannelBySourceId: vi.fn(),
    getChannelBySlug: vi.fn().mockResolvedValue(null),
    getChannel: vi.fn(),
    createChannel: vi.fn().mockImplementation((opts: any) => ({
      id: "ch_1", slug: opts.slug, name: opts.name, description: opts.description ?? null,
      channel_type: opts.channelType, is_public: opts.isPublic ?? true,
      source_id: null, created_at: new Date(), updated_at: new Date(),
    })),
    listChannels: vi.fn().mockResolvedValue([]),
    joinChannel: vi.fn().mockResolvedValue({ role: "member", joined_at: new Date() }),
    leaveChannel: vi.fn().mockResolvedValue(true),
    isMember: vi.fn().mockResolvedValue(true),
    getMemberCount: vi.fn().mockResolvedValue(5),
    getMembers: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockImplementation((opts: any) => ({
      id: "msg_1", channel_id: opts.channelId, from_agent_id: opts.fromAgentId,
      content: opts.content, message_type: opts.messageType ?? "text",
      created_at: new Date(),
    })),
    getHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockMessageBus() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  channelService?: ReturnType<typeof createMockChannelService>,
  messageBus?: ReturnType<typeof createMockMessageBus>,
) {
  const cs = channelService ?? createMockChannelService();
  const mb = messageBus ?? createMockMessageBus();
  const router = createChannelsRouter(pool as any, TEST_HMAC_SECRET, cs as any, mb as any);
  return { app: createTestApp(router), channelService: cs, messageBus: mb };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/channels/by-source/:sourceId — Public channel lookup
// ---------------------------------------------------------------------------

describe("GET /v1/channels/by-source/:sourceId", () => {
  it("returns public channel by source ID", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue({
      id: "ch_1", slug: "proj-discuss", name: "Discussion",
      description: null, channel_type: "project", source_id: "proj_1",
      is_public: true, created_at: new Date(),
    });
    const { app } = buildApp(pool, cs);

    const res = await request(app).get("/v1/channels/by-source/proj_1");

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("proj-discuss");
    expect(res.body.memberCount).toBe(5);
  });

  it("returns 404 for private channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue({
      id: "ch_2", slug: "secret", name: "Secret", is_public: false,
    });
    const { app } = buildApp(pool, cs);

    const res = await request(app).get("/v1/channels/by-source/proj_2");

    expect(res.status).toBe(404);
  });

  it("returns 404 for nonexistent source", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue(null);
    const { app } = buildApp(pool, cs);

    const res = await request(app).get("/v1/channels/by-source/missing");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/channels — Create channel
// ---------------------------------------------------------------------------

describe("POST /v1/channels", () => {
  it("creates a channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels")
      .set(authHeader())
      .send({ slug: "my-channel", name: "My Channel", channelType: "custom" });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("my-channel");
    expect(res.body.name).toBe("My Channel");
    expect(cs.createChannel).toHaveBeenCalled();
    expect(cs.joinChannel).toHaveBeenCalled(); // auto-join creator
  });

  it("rejects missing slug", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels")
      .set(authHeader())
      .send({ name: "No Slug" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("slug");
  });

  it("rejects invalid slug format", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels")
      .set(authHeader())
      .send({ slug: "Has Spaces!", name: "Test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("slug");
  });

  it("rejects missing name", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels")
      .set(authHeader())
      .send({ slug: "my-channel" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("rejects duplicate slug", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySlug.mockResolvedValue({ id: "ch_existing" });
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels")
      .set(authHeader())
      .send({ slug: "existing", name: "Duplicate" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already exists");
  });

  it("rejects invalid channelType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels")
      .set(authHeader())
      .send({ slug: "test", name: "Test", channelType: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("channelType");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/channels — List channels
// ---------------------------------------------------------------------------

describe("GET /v1/channels", () => {
  it("returns channel list", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.listChannels.mockResolvedValue([{
      id: "ch_1", slug: "general", name: "General", description: null,
      channel_type: "custom", source_id: null, is_public: true, created_at: new Date(),
    }]);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/channels")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].slug).toBe("general");
    expect(res.body.channels[0].memberCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/channels/:id — Channel detail
// ---------------------------------------------------------------------------

describe("GET /v1/channels/:id", () => {
  it("returns channel detail", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue({
      id: "ch_1", slug: "general", name: "General", description: "Main chat",
      channel_type: "custom", source_id: null, is_public: true,
      max_members: 100, metadata: null, created_at: new Date(), updated_at: new Date(),
    });
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/channels/ch_1")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("general");
    expect(res.body.memberCount).toBe(5);
    expect(res.body.isMember).toBe(true);
  });

  it("returns 404 for nonexistent channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(null);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/channels/missing")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("rejects non-member on private channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue({
      id: "ch_priv", slug: "secret", name: "Secret", is_public: false,
      channel_type: "custom", created_at: new Date(), updated_at: new Date(),
    });
    cs.isMember.mockResolvedValue(false);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/channels/ch_priv")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("private");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/channels/:id/join — Join channel
// ---------------------------------------------------------------------------

describe("POST /v1/channels/:id/join", () => {
  it("joins a public channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    const mb = createMockMessageBus();
    cs.getChannel.mockResolvedValue({
      id: "ch_1", is_public: true, max_members: 0,
    });
    const { app } = buildApp(pool, cs, mb);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/join")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("member");
    expect(mb.publish).toHaveBeenCalledWith("ch:ch_1", expect.objectContaining({ type: "channel.member.joined" }));
  });

  it("returns 404 for nonexistent channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(null);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/missing/join")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("rejects joining private channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue({ id: "ch_priv", is_public: false });
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_priv/join")
      .set(authHeader());

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("private");
  });

  it("rejects joining full channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue({ id: "ch_full", is_public: true, max_members: 5 });
    cs.getMemberCount.mockResolvedValue(5);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_full/join")
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("full");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/channels/:id/leave — Leave channel
// ---------------------------------------------------------------------------

describe("POST /v1/channels/:id/leave", () => {
  it("leaves a channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    const mb = createMockMessageBus();
    const { app } = buildApp(pool, cs, mb);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/leave")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mb.publish).toHaveBeenCalledWith("ch:ch_1", expect.objectContaining({ type: "channel.member.left" }));
  });

  it("returns 404 when not a member", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.leaveChannel.mockResolvedValue(false);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/leave")
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/channels/by-source/:sourceId/messages — Public channel messages
// ---------------------------------------------------------------------------

describe("GET /v1/channels/by-source/:sourceId/messages", () => {
  const MOCK_CHANNEL = {
    id: "ch_1", slug: "proj-discuss", name: "Discussion",
    channel_type: "project", source_id: "proj_1", is_public: true,
  };

  const MOCK_MESSAGES = [
    { id: "msg_2", from_agent_id: "agt_a", content: "Second", message_type: "text", created_at: new Date() },
    { id: "msg_1", from_agent_id: "agt_b", content: "First", message_type: "text", created_at: new Date() },
  ];

  it("returns messages for a public channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue(MOCK_MESSAGES);
    const { app } = buildApp(pool, cs);

    // Agent lookup query for enrichment
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "agt_a", address: "0xaaa", display_name: "alice" },
        { id: "agt_b", address: "0xbbb", display_name: null },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/v1/channels/by-source/proj_1/messages");

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].from).toBe("0xaaa");
    expect(res.body.messages[0].fromName).toBe("alice");
    expect(res.body.messages[1].fromName).toBeNull();
    expect(res.body.limit).toBe(50);
  });

  it("respects custom limit", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue([]);
    const { app } = buildApp(pool, cs);

    await request(app).get("/v1/channels/by-source/proj_1/messages?limit=200");

    expect(cs.getHistory).toHaveBeenCalledWith("ch_1", { before: undefined, limit: 200 });
  });

  it("caps limit at 500", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue([]);
    const { app } = buildApp(pool, cs);

    await request(app).get("/v1/channels/by-source/proj_1/messages?limit=9999");

    expect(cs.getHistory).toHaveBeenCalledWith("ch_1", { before: undefined, limit: 500 });
  });

  it("passes before cursor to getHistory", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue([]);
    const { app } = buildApp(pool, cs);

    await request(app).get("/v1/channels/by-source/proj_1/messages?before=msg_5");

    expect(cs.getHistory).toHaveBeenCalledWith("ch_1", { before: "msg_5", limit: 50 });
  });

  it("returns 404 for private channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue({ ...MOCK_CHANNEL, is_public: false });
    const { app } = buildApp(pool, cs);

    const res = await request(app).get("/v1/channels/by-source/proj_1/messages");

    expect(res.status).toBe(404);
  });

  it("returns 404 for nonexistent source", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannelBySourceId.mockResolvedValue(null);
    const { app } = buildApp(pool, cs);

    const res = await request(app).get("/v1/channels/by-source/missing/messages");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/channels/:id/messages — Authenticated message history
// ---------------------------------------------------------------------------

describe("GET /v1/channels/:id/messages", () => {
  const MOCK_CHANNEL = {
    id: "ch_1", slug: "general", name: "General",
    channel_type: "custom", is_public: true,
  };

  const MOCK_MESSAGES = [
    { id: "msg_3", from_agent_id: "agt_ch", content: "Hello", message_type: "text", metadata: null, signature: null, created_at: new Date() },
  ];

  it("returns message history for a public channel member", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue(MOCK_MESSAGES);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    // Agent address enrichment query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_ch", address: "0xccc", display_name: "charlie" }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/channels/ch_1/messages")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].from).toBe("0xccc");
    expect(res.body.messages[0].fromName).toBe("charlie");
    expect(res.body.messages[0].content).toBe("Hello");
    expect(res.body.limit).toBe(50);
  });

  it("caps limit at 500", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue([]);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    await request(app)
      .get("/v1/channels/ch_1/messages?limit=9999")
      .set(authHeader());

    expect(cs.getHistory).toHaveBeenCalledWith("ch_1", { before: undefined, limit: 500 });
  });

  it("passes before cursor", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(MOCK_CHANNEL);
    cs.getHistory.mockResolvedValue([]);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    await request(app)
      .get("/v1/channels/ch_1/messages?before=msg_10&limit=100")
      .set(authHeader());

    expect(cs.getHistory).toHaveBeenCalledWith("ch_1", { before: "msg_10", limit: 100 });
  });

  it("returns 404 for nonexistent channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(null);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/channels/missing/messages")
      .set(authHeader());

    expect(res.status).toBe(404);
  });

  it("rejects non-member on private channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue({ ...MOCK_CHANNEL, is_public: false });
    cs.isMember.mockResolvedValue(false);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/channels/ch_1/messages")
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/channels/ch_1/messages");

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/channels/:id/messages — Send message
// ---------------------------------------------------------------------------

describe("POST /v1/channels/:id/messages", () => {
  it("sends a message", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    const mb = createMockMessageBus();
    cs.getChannel.mockResolvedValue({
      id: "ch_1", slug: "general", name: "General", channel_type: "custom",
      source_id: null, is_public: true,
    });
    const { app } = buildApp(pool, cs, mb);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/messages")
      .set(authHeader())
      .send({ content: "Hello channel!" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("msg_1");
    expect(cs.sendMessage).toHaveBeenCalled();
    expect(mb.publish).toHaveBeenCalled();
  });

  it("rejects missing content", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/messages")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("content");
  });

  it("rejects content exceeding max length", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/messages")
      .set(authHeader())
      .send({ content: "x".repeat(10001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("too long");
  });

  it("rejects invalid messageType", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/messages")
      .set(authHeader())
      .send({ content: "test", messageType: "unknown" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("messageType");
  });

  it("returns 404 for nonexistent channel", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue(null);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/missing/messages")
      .set(authHeader())
      .send({ content: "test" });

    expect(res.status).toBe(404);
  });

  it("rejects non-member", async () => {
    const pool = createMockPool();
    const cs = createMockChannelService();
    cs.getChannel.mockResolvedValue({ id: "ch_1", is_public: true });
    cs.isMember.mockResolvedValue(false);
    const { app } = buildApp(pool, cs);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/channels/ch_1/messages")
      .set(authHeader())
      .send({ content: "test" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("member");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/channels/mentions — List my @mentions
// ---------------------------------------------------------------------------

describe("GET /v1/channels/mentions", () => {
  it("returns mentions for the authenticated agent", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Query for mentions list
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "m_1",
          channel_id: "ch_1",
          message_id: "msg_1",
          sender_agent_id: "agt_sender",
          content_preview: "Hey @0xabc123",
          read_at: null,
          created_at: new Date("2025-01-01"),
          channel_name: "General",
          channel_slug: "general",
          sender_address: "0xabc123def456",
          sender_name: "alice",
        },
      ],
      rowCount: 1,
    });
    // Query for total count
    pool.query.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });

    const res = await request(app)
      .get("/v1/channels/mentions")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.mentions).toHaveLength(1);
    expect(res.body.mentions[0].id).toBe("m_1");
    expect(res.body.mentions[0].channelName).toBe("General");
    expect(res.body.mentions[0].senderName).toBe("alice");
    expect(res.body.mentions[0].contentPreview).toBe("Hey @0xabc123");
    expect(res.body.mentions[0].readAt).toBeNull();
    expect(res.body.total).toBe(1);
  });

  it("returns empty list when no mentions", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });

    const res = await request(app)
      .get("/v1/channels/mentions")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.mentions).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("respects limit and offset query params", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });

    const res = await request(app)
      .get("/v1/channels/mentions?limit=5&offset=10")
      .set(authHeader());

    expect(res.status).toBe(200);
    // Verify the query was called with correct params (3rd call after auth + credit balance)
    const mentionsCall = pool.query.mock.calls[2];
    expect(mentionsCall[1]).toContain(5);   // limit
    expect(mentionsCall[1]).toContain(10);  // offset
  });

  it("clamps limit to 100 max", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });

    await request(app)
      .get("/v1/channels/mentions?limit=999")
      .set(authHeader());

    const mentionsCall = pool.query.mock.calls[2];
    expect(mentionsCall[1]).toContain(100); // clamped limit
  });

  it("requires authentication", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/channels/mentions");

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/channels/mentions/:id/read — Mark mention read
// ---------------------------------------------------------------------------

describe("POST /v1/channels/mentions/:id/read", () => {
  it("marks a mention as read", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // UPDATE returns 1 row affected
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post("/v1/channels/mentions/m_1/read")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 for nonexistent or already-read mention", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // UPDATE returns 0 rows affected
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .post("/v1/channels/mentions/m_nonexistent/read")
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("requires authentication", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).post("/v1/channels/mentions/m_1/read");

    expect(res.status).toBe(401);
  });
});
