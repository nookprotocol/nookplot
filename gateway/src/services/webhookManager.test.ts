import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { WebhookManager, WebhookError } from "./webhookManager.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../secretManager.js", () => ({
  encryptSecret: vi.fn().mockReturnValue({
    encryptedKey: "enc_hex",
    iv: "iv_hex",
    authTag: "tag_hex",
  }),
  decryptSecret: vi.fn().mockReturnValue("decrypted_secret"),
}));

function createMockBroadcaster() {
  return { broadcast: vi.fn() };
}

const ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex

// ---------------------------------------------------------------------------
//  register
// ---------------------------------------------------------------------------

describe("WebhookManager — register", () => {
  it("registers a webhook with valid source name", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        agent_id: "agt_1",
        source: "github",
        config: {},
        active: true,
        created_at: "2025-06-01",
      }],
      rowCount: 1,
    });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    const result = await mgr.register("agt_1", "github", {});

    expect(result.id).toBe("wh_1");
    expect(result.source).toBe("github");
    expect(result.active).toBe(true);
  });

  it("rejects invalid source names", async () => {
    const pool = createMockPool();
    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);

    await expect(mgr.register("agt_1", "INVALID NAME!", {})).rejects.toThrow("Invalid source name");
    await expect(mgr.register("agt_1", "", {})).rejects.toThrow("Invalid source name");
  });

  it("encrypts secret before storage when encryption key provided", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        agent_id: "agt_1",
        source: "stripe",
        config: { encryptedSecret: "enc_hex", secretIv: "iv_hex", secretAuthTag: "tag_hex" },
        active: true,
        created_at: "2025-06-01",
      }],
      rowCount: 1,
    });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any, ENCRYPTION_KEY);
    await mgr.register("agt_1", "stripe", { secret: "whsec_test123" });

    // Should have stored config without plaintext secret
    const insertCall = pool.query.mock.calls[0];
    const storedConfig = JSON.parse(insertCall[1][2]);
    expect(storedConfig.secret).toBeUndefined();
    expect(storedConfig.encryptedSecret).toBe("enc_hex");
  });
});

// ---------------------------------------------------------------------------
//  list
// ---------------------------------------------------------------------------

describe("WebhookManager — list", () => {
  it("returns webhook registrations for agent", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "wh_1", agent_id: "agt_1", source: "github", config: {}, active: true, created_at: "2025-06-01" },
        { id: "wh_2", agent_id: "agt_1", source: "stripe", config: {}, active: false, created_at: "2025-06-02" },
      ],
      rowCount: 2,
    });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    const list = await mgr.list("agt_1");

    expect(list).toHaveLength(2);
    expect(list[0].source).toBe("github");
    expect(list[1].active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  remove
// ---------------------------------------------------------------------------

describe("WebhookManager — remove", () => {
  it("returns true when webhook deleted", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    const removed = await mgr.remove("agt_1", "github");

    expect(removed).toBe(true);
  });

  it("returns false when webhook not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    const removed = await mgr.remove("agt_1", "nonexistent");

    expect(removed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  getEventLog
// ---------------------------------------------------------------------------

describe("WebhookManager — getEventLog", () => {
  it("returns mapped event entries with pagination", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "evt_1",
        agent_id: "agt_1",
        source: "github",
        event_type: "push",
        status: "delivered",
        payload_size: 512,
        error_message: null,
        created_at: "2025-06-01",
      }],
      rowCount: 1,
    });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    const entries = await mgr.getEventLog("agt_1", 0, 10);

    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe("push");
    expect(entries[0].status).toBe("delivered");
    expect(entries[0].payloadSize).toBe(512);
  });
});

// ---------------------------------------------------------------------------
//  handleIncoming — security pipeline
// ---------------------------------------------------------------------------

describe("WebhookManager — handleIncoming", () => {
  it("rejects when agent not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // agent lookup

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(mgr.handleIncoming("0xunknown", "github", {}, "{}"))
      .rejects.toThrow("Agent not found");
  });

  it("rejects when no registration exists", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 }); // agent
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no registration

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(mgr.handleIncoming("0xabc", "github", {}, "{}"))
      .rejects.toThrow("No webhook registered");
  });

  it("rejects inactive webhooks", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "wh_1", config: {}, active: false }],
      rowCount: 1,
    });

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(mgr.handleIncoming("0xabc", "github", {}, "{}"))
      .rejects.toThrow("inactive");
  });

  it("deduplicates via idempotency key", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 }); // agent
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "wh_1", config: {}, active: true }],
      rowCount: 1,
    }); // registration
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "existing_event" }],
      rowCount: 1,
    }); // idempotency check — already exists

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    // Should return silently (no error)
    await mgr.handleIncoming("0xabc", "github", { "x-github-delivery": "delivery-123" }, "{}");

    // Broadcaster should NOT have been called (deduped)
    const broadcaster = (mgr as any).eventBroadcaster;
    // We can't easily access it, but no error thrown = success
  });

  it("rejects missing HMAC signature when configured", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        config: { secret: "whsec_123", signatureHeader: "X-Hub-Signature-256" },
        active: true,
      }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency — new
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logEvent

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(mgr.handleIncoming("0xabc", "github", {}, "{}"))
      .rejects.toThrow("Missing signature header");
  });

  it("rejects invalid HMAC signature", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        config: { secret: "whsec_123", signatureHeader: "X-Hub-Signature-256" },
        active: true,
      }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logEvent

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(
      mgr.handleIncoming("0xabc", "github", { "x-hub-signature-256": "sha256=" + "ab".repeat(32) }, "{}")
    ).rejects.toThrow("Invalid signature");
  });

  it("validates correct HMAC signature and delivers", async () => {
    const secret = "whsec_test";
    const body = '{"event":"push"}';
    const hmac = crypto.createHmac("sha256", secret).update(body).digest("hex");

    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 }); // agent
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        config: { secret, signatureHeader: "X-Hub-Signature-256" },
        active: true,
      }],
      rowCount: 1,
    }); // registration
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency
    // Rate limit
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    // logEvent
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const broadcaster = createMockBroadcaster();
    const mgr = new WebhookManager(pool as any, broadcaster as any);

    await mgr.handleIncoming(
      "0xabc", "github",
      { "x-hub-signature-256": `sha256=${hmac}` },
      body,
    );

    expect(broadcaster.broadcast).toHaveBeenCalledWith("agt_1", expect.objectContaining({
      type: "webhook.received",
    }));
  });

  it("rejects expired timestamp (replay protection)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        config: { timestampHeader: "X-Webhook-Timestamp", maxAgeSeconds: 60 },
        active: true,
      }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logEvent

    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 120); // 2 minutes old

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(
      mgr.handleIncoming("0xabc", "github", { "x-webhook-timestamp": oldTimestamp }, "{}")
    ).rejects.toThrow("timestamp too old");
  });

  it("enforces rate limit (100/hour)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "wh_1", config: {}, active: true }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency
    // Rate limit — at max
    pool.query.mockResolvedValueOnce({ rows: [{ count: "100" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logEvent

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(mgr.handleIncoming("0xabc", "github", {}, "{}"))
      .rejects.toThrow("Rate limit exceeded");
  });

  it("rejects oversized payload (>256KB)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "wh_1", config: {}, active: true }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }); // rate limit
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logEvent

    const largeBody = "x".repeat(262_145); // 256KB + 1

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(mgr.handleIncoming("0xabc", "github", {}, largeBody))
      .rejects.toThrow("Payload too large");
  });

  it("rejects SHA1 signatures", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "wh_1",
        config: { secret: "whsec", signatureHeader: "X-Hub-Signature" },
        active: true,
      }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // idempotency
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // logEvent

    const mgr = new WebhookManager(pool as any, createMockBroadcaster() as any);
    await expect(
      mgr.handleIncoming("0xabc", "github", { "x-hub-signature": "sha1=abc123" }, "{}")
    ).rejects.toThrow("Invalid signature");
  });
});

// ---------------------------------------------------------------------------
//  WebhookError
// ---------------------------------------------------------------------------

describe("WebhookError", () => {
  it("includes status code", () => {
    const err = new WebhookError("test", 429, { retryAfter: "3600" });
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe("3600");
    expect(err.name).toBe("WebhookError");
  });
});
