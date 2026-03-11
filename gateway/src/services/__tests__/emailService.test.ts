/**
 * Unit tests for EmailService — agent email inboxes via Resend.
 *
 * Verifies:
 * - Inbox CRUD (create, duplicate rejection, reserved username, update, delete)
 * - Outbound (send, credit deduction, daily limit, suppression check, content scan blocking)
 * - Inbound processing (payload parsing, inbox lookup, thread resolution, auto-reply, content scan)
 * - Bounce/complaint handling (bounce → suppression, complaint → suppression)
 * - Threading (in-reply-to matching, new thread creation)
 * - Anti-abuse (daily limit enforcement, auto-reply flood prevention)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmailService, EmailError } from "../emailService.js";

// Mock Resend
const mockSend = vi.fn().mockResolvedValue({ data: { id: "resend-id-123" }, error: null });
const mockGet = vi.fn().mockResolvedValue({ data: null, error: { message: "Not found" } });

vi.mock("resend", () => {
  return {
    Resend: class MockResend {
      emails = { send: mockSend, get: mockGet };
    },
  };
});

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const mockFetchWithTimeout = vi.fn().mockResolvedValue({
  ok: false,
  status: 404,
  statusText: "Not Found",
});

vi.mock("../../fetchWithTimeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue(undefined),
    addCredits: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContentScanner() {
  return {
    scanForBlocking: vi.fn().mockReturnValue({ blocked: false, result: { signals: [], maxSeverity: 0, threatLevel: "none", scannedLength: 0 } }),
    scanAndRecord: vi.fn().mockResolvedValue(undefined),
    recordBlockedContent: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEventBroadcaster() {
  return {
    broadcast: vi.fn(),
  };
}

const TEST_ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex key for tests

const DEFAULT_CONFIG = {
  resendApiKey: "re_test_123",
  domain: "ai.nookplot.com",
  encryptionKey: TEST_ENCRYPTION_KEY,
  createInboxCost: 50,  // 0.50 credits
  sendCost: 15,         // 0.15 credits
  sendAttachmentCost: 25,
  dailyLimitTier1: 50,
  dailyLimitTier2: 200,
};

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function createService(pool?: ReturnType<typeof createMockPool>) {
  const p = pool ?? createMockPool();
  const cm = createMockCreditManager();
  const cs = createMockContentScanner();
  const eb = createMockEventBroadcaster();

  const service = new EmailService(p as any, DEFAULT_CONFIG);
  service.setCreditManager(cm as any);
  service.setContentScanner(cs as any);
  service.setEventBroadcaster(eb as any);

  return { service, pool: p, creditManager: cm, contentScanner: cs, eventBroadcaster: eb };
}

describe("EmailService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ data: { id: "resend-id-123" }, error: null });
    mockGet.mockResolvedValue({ data: null, error: { message: "Not found" } });
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
  });

  // ── Inbox CRUD ──

  describe("createInbox", () => {
    it("creates inbox, charges credits, returns row", async () => {
      const { service, pool, creditManager } = createService();

      // No existing inbox for agent
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Username not taken
      pool.query.mockResolvedValueOnce({ rows: [] });
      // INSERT RETURNING
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "glitch",
          email_address: "glitch@ai.nookplot.com", is_active: true,
        }],
      });

      const inbox = await service.createInbox(AGENT_ID, { username: "glitch" });

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 50, expect.stringContaining("email_create_inbox:"), "email_create_inbox",
      );
      expect(inbox.username).toBe("glitch");
      expect(inbox.email_address).toBe("glitch@ai.nookplot.com");
    });

    it("rejects duplicate inbox for same agent", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [{ id: "existing" }] });

      await expect(
        service.createInbox(AGENT_ID, { username: "glitch" }),
      ).rejects.toThrow("already has an email inbox");
    });

    it("rejects taken username", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [] }); // no inbox for agent
      pool.query.mockResolvedValueOnce({ rows: [{ id: "other-inbox" }] }); // username taken

      await expect(
        service.createInbox(AGENT_ID, { username: "glitch" }),
      ).rejects.toThrow("Username already taken");
    });

    it("rejects reserved usernames", async () => {
      const { service } = createService();

      await expect(
        service.createInbox(AGENT_ID, { username: "admin" }),
      ).rejects.toThrow("reserved");
    });

    it("coerces boolean autoReply to null (prevents 'false' auto-reply bug)", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [] }); // no existing inbox
      pool.query.mockResolvedValueOnce({ rows: [] }); // username available
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "glitch",
          email_address: "glitch@ai.nookplot.com", is_active: true,
          auto_reply: null,
        }],
      });

      await service.createInbox(AGENT_ID, { username: "glitch", autoReply: false as any });

      // The INSERT query (3rd call, index 2) should have null for auto_reply, not boolean false
      const insertCall = pool.query.mock.calls[2];
      const params = insertCall[1] as unknown[];
      // auto_reply is the 5th param ($5)
      expect(params[4]).toBeNull();
    });

    it("rejects invalid username format", async () => {
      const { service } = createService();

      await expect(
        service.createInbox(AGENT_ID, { username: "A" }),
      ).rejects.toThrow("Username must be");

      await expect(
        service.createInbox(AGENT_ID, { username: "-bad" }),
      ).rejects.toThrow("Username must be");

      await expect(
        service.createInbox(AGENT_ID, { username: "has spaces" }),
      ).rejects.toThrow("Username must be");
    });
  });

  describe("getInbox", () => {
    it("returns inbox when found", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, username: "glitch", is_active: true }],
      });

      const inbox = await service.getInbox(AGENT_ID);
      expect(inbox?.username).toBe("glitch");
    });

    it("returns null when no inbox", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const inbox = await service.getInbox(AGENT_ID);
      expect(inbox).toBeNull();
    });
  });

  describe("updateInbox", () => {
    it("updates display name and auto-reply", async () => {
      const { service, pool } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, username: "glitch", is_active: true }],
      });
      // UPDATE
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", display_name: "Glitch Bot", auto_reply: "I'm away" }],
      });

      const updated = await service.updateInbox(AGENT_ID, {
        displayName: "Glitch Bot",
        autoReply: "I'm away",
      });

      expect(updated.display_name).toBe("Glitch Bot");
    });

    it("throws when no inbox found", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.updateInbox(AGENT_ID, { displayName: "New Name" }),
      ).rejects.toThrow("No active inbox");
    });
  });

  describe("deleteInbox", () => {
    it("deactivates inbox", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.deleteInbox(AGENT_ID);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("is_active = false"),
        [AGENT_ID],
      );
    });

    it("throws when no inbox to delete", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      await expect(service.deleteInbox(AGENT_ID)).rejects.toThrow("No active inbox");
    });
  });

  describe("checkUsernameAvailable", () => {
    it("returns true for available username", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.checkUsernameAvailable("newuser");
      expect(result.available).toBe(true);
    });

    it("returns false for taken username", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ id: "x" }] });

      const result = await service.checkUsernameAvailable("taken");
      expect(result.available).toBe(false);
    });

    it("returns false for reserved username", async () => {
      const { service } = createService();
      const result = await service.checkUsernameAvailable("admin");
      expect(result.available).toBe(false);
    });

    it("returns false for invalid format", async () => {
      const { service } = createService();
      const result = await service.checkUsernameAvailable("x");
      expect(result.available).toBe(false);
    });
  });

  // ── Outbound ──

  describe("sendEmail", () => {
    it("sends email via Resend, deducts credits, stores message, increments counter", async () => {
      const { service, pool, creditManager } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "glitch",
          email_address: "glitch@ai.nookplot.com",
          display_name: null, is_active: true,
        }],
      });
      // getDailyLimit — credit_balances
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [] });
      // isEmailSuppressed
      pool.query.mockResolvedValueOnce({ rows: [] });
      // INSERT message
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "msg-1", inbox_id: "inbox-1", direction: "outbound",
          from_address: "glitch@ai.nookplot.com",
          to_addresses: ["alice@example.com"], subject: "Hello",
          status: "delivered",
        }],
      });
      // daily counter upsert
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const msg = await service.sendEmail(AGENT_ID, {
        to: "alice@example.com",
        subject: "Hello",
        bodyText: "Hi Alice!",
      });

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 15, expect.stringContaining("email_send:"), "email_send",
      );
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
        from: "glitch@ai.nookplot.com",
        to: ["alice@example.com"],
        subject: "Hello",
        text: "Hi Alice!",
      }));
      expect(msg.direction).toBe("outbound");
      expect(msg.status).toBe("delivered");
    });

    it("rejects when no inbox exists", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] }); // no inbox

      await expect(
        service.sendEmail(AGENT_ID, { to: "a@b.com", subject: "Hi", bodyText: "Hello" }),
      ).rejects.toThrow("No active inbox");
    });

    it("enforces daily send limit", async () => {
      const { service, pool } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, email_address: "g@ai.nookplot.com", is_active: true }],
      });
      // getDailyLimit (tier 1 = 50)
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount = 50 (at limit)
      pool.query.mockResolvedValueOnce({ rows: [{ send_count: 50 }] });

      await expect(
        service.sendEmail(AGENT_ID, { to: "a@b.com", subject: "Hi", bodyText: "Hello" }),
      ).rejects.toThrow("Daily send limit");
    });

    it("rejects sending to suppressed address", async () => {
      const { service, pool } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, email_address: "g@ai.nookplot.com", is_active: true }],
      });
      // getDailyLimit
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [] });
      // isEmailSuppressed — found!
      pool.query.mockResolvedValueOnce({ rows: [{ id: "sup-1" }] });

      await expect(
        service.sendEmail(AGENT_ID, { to: "bounced@example.com", subject: "Hi", bodyText: "Hello" }),
      ).rejects.toThrow("suppression list");
    });

    it("blocks content that fails safety scan", async () => {
      const { service, pool, contentScanner } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, email_address: "g@ai.nookplot.com", is_active: true }],
      });
      // getDailyLimit
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [] });
      // isEmailSuppressed
      pool.query.mockResolvedValueOnce({ rows: [] });

      contentScanner.scanForBlocking.mockReturnValueOnce({
        blocked: true,
        result: { signals: [{ category: "phishing" }], maxSeverity: 90, threatLevel: "high", scannedLength: 100 },
      });

      await expect(
        service.sendEmail(AGENT_ID, { to: "a@b.com", subject: "Click here", bodyText: "Send me your password" }),
      ).rejects.toThrow("Content blocked");
    });

    it("rejects invalid email addresses", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, email_address: "g@ai.nookplot.com", is_active: true }],
      });

      await expect(
        service.sendEmail(AGENT_ID, { to: "not-an-email", subject: "Hi", bodyText: "Hello" }),
      ).rejects.toThrow("Invalid email address");
    });

    it("rejects missing subject", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, email_address: "g@ai.nookplot.com", is_active: true }],
      });

      await expect(
        service.sendEmail(AGENT_ID, { to: "a@b.com", subject: "", bodyText: "Hello" }),
      ).rejects.toThrow("Subject required");
    });

    it("refunds credits on Resend API failure", async () => {
      const { service, pool, creditManager } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "glitch",
          email_address: "glitch@ai.nookplot.com",
          display_name: null, is_active: true,
        }],
      });
      // getDailyLimit
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [] });
      // isEmailSuppressed
      pool.query.mockResolvedValueOnce({ rows: [] });

      // Resend API returns error
      mockSend.mockResolvedValueOnce({ data: null, error: { message: "Rate limited" } });

      await expect(
        service.sendEmail(AGENT_ID, { to: "a@b.com", subject: "Hi", bodyText: "Hello" }),
      ).rejects.toThrow("Failed to send email via Resend");

      expect(creditManager.addCredits).toHaveBeenCalledWith(
        AGENT_ID, 15, expect.stringContaining("email_send_refund:"), "email_send_refund",
      );
    });
  });

  describe("replyToEmail", () => {
    it("replies to an inbound email", async () => {
      const { service, pool, creditManager } = createService();

      // getMessage — original
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "orig-msg", inbox_id: "inbox-1", agent_id: AGENT_ID,
          direction: "inbound", from_address: "alice@example.com",
          to_addresses: ["glitch@ai.nookplot.com"],
          subject: "Question", message_id: "<orig@example.com>",
        }],
      });

      // sendEmail internals: getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "glitch",
          email_address: "glitch@ai.nookplot.com", is_active: true,
        }],
      });
      // getDailyLimit
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [] });
      // isEmailSuppressed
      pool.query.mockResolvedValueOnce({ rows: [] });
      // thread resolution — find parent
      pool.query.mockResolvedValueOnce({
        rows: [{ thread_id: "thread-1", id: "orig-msg" }],
      });
      // INSERT message
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "reply-msg", direction: "outbound", subject: "Re: Question",
          to_addresses: ["alice@example.com"], status: "delivered",
        }],
      });
      // daily counter
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const reply = await service.replyToEmail(AGENT_ID, "orig-msg", {
        bodyText: "Here is my answer",
      });

      expect(reply.subject).toBe("Re: Question");
      expect(creditManager.deductCredits).toHaveBeenCalled();
    });

    it("throws when original message not found", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.replyToEmail(AGENT_ID, "nonexistent", { bodyText: "Hello" }),
      ).rejects.toThrow("Message not found");
    });
  });

  // ── Inbound ──

  describe("processInboundEmail", () => {
    it("processes Resend inbound payload, stores message, broadcasts event", async () => {
      const { service, pool, eventBroadcaster, contentScanner } = createService();

      // Inbox lookup by username
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "testuser",
          email_address: "testuser@ai.nookplot.com", is_active: true,
          auto_reply: null, forward_to_agent: false,
        }],
      });
      // INSERT message
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbound-msg-1", inbox_id: "inbox-1", direction: "inbound",
          from_address: "sender@example.com", subject: "Hello Agent",
        }],
      });

      await service.processInboundEmail({
        created_at: new Date().toISOString(),
        email_id: "resend-inbound-123",
        from: "sender@example.com",
        to: ["testuser@ai.nookplot.com"],
        subject: "Hello Agent",
        text: "Hello from the outside world",
      });

      // Should have broadcast WebSocket event
      expect(eventBroadcaster.broadcast).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: "email.received",
          data: expect.objectContaining({
            from: "sender@example.com",
            subject: "Hello Agent",
          }),
        }),
      );

      // Should have run content scan (fire-and-forget)
      expect(contentScanner.scanAndRecord).toHaveBeenCalled();
    });

    it("fetches body from Resend API when webhook text/html are missing", async () => {
      const { service, pool, eventBroadcaster } = createService();

      // fetchWithTimeout returns body content
      mockFetchWithTimeout.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: "Fetched body text", html: "<p>Fetched body html</p>" }),
      });

      // Inbox lookup by username
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "testuser",
          email_address: "testuser@ai.nookplot.com", is_active: true,
          auto_reply: null, forward_to_agent: false,
        }],
      });
      // INSERT message
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbound-msg-2", inbox_id: "inbox-1", direction: "inbound",
          from_address: "sender@example.com", subject: "Reply",
        }],
      });

      await service.processInboundEmail({
        created_at: new Date().toISOString(),
        email_id: "resend-inbound-789",
        from: "sender@example.com",
        to: ["testuser@ai.nookplot.com"],
        subject: "Reply",
        // No text or html — simulates missing body in webhook
      });

      // Should have called fetchWithTimeout with the Resend receiving API
      expect(mockFetchWithTimeout).toHaveBeenCalledWith(
        "https://api.resend.com/emails/receiving/resend-inbound-789",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer") }),
        }),
      );

      // Should have broadcast with preview from fetched body
      expect(eventBroadcaster.broadcast).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          type: "email.received",
          data: expect.objectContaining({
            preview: expect.stringContaining("Fetched body text"),
          }),
        }),
      );
    });

    it("handles 'Display Name <email>' format in to field", async () => {
      const { service, pool, eventBroadcaster } = createService();

      // Inbox lookup by username — extracted from angle brackets
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, username: "testuser",
          email_address: "testuser@ai.nookplot.com", is_active: true,
          auto_reply: null, forward_to_agent: false,
        }],
      });
      // INSERT message
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbound-msg-3", inbox_id: "inbox-1", direction: "inbound",
          from_address: "sender@example.com",
        }],
      });

      await service.processInboundEmail({
        created_at: new Date().toISOString(),
        email_id: "resend-inbound-display",
        from: "sender@example.com",
        to: ["Test User <testuser@ai.nookplot.com>"],
        subject: "Hello",
        text: "Body content",
      });

      // Should have found the inbox despite display name format
      expect(eventBroadcaster.broadcast).toHaveBeenCalled();
    });

    it("silently returns when no matching inbox found", async () => {
      const { service, pool, eventBroadcaster } = createService();

      // No inbox found
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.processInboundEmail({
        created_at: new Date().toISOString(),
        email_id: "resend-inbound-456",
        from: "sender@example.com",
        to: ["nobody@ai.nookplot.com"],
        subject: "Hello",
      });

      expect(eventBroadcaster.broadcast).not.toHaveBeenCalled();
    });
  });

  // ── Bounce / Complaint ──

  describe("processBounceNotification", () => {
    it("adds bounce to suppression list", async () => {
      const { service, pool } = createService();

      // suppression insert
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      // message status update
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.processBounceNotification({
        email_id: "resend-123",
        to: ["bad@example.com"],
      });

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO agent_email_suppressions"),
        ["bad@example.com", expect.stringContaining("Resend bounce")],
      );
    });
  });

  describe("processComplaintNotification", () => {
    it("adds complaint to suppression list", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rowCount: 1 }); // suppression insert
      pool.query.mockResolvedValueOnce({ rowCount: 1 }); // message status

      await service.processComplaintNotification({
        email_id: "resend-789",
        to: ["angry@example.com"],
      });

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO agent_email_suppressions"),
        ["angry@example.com", expect.stringContaining("Resend complaint")],
      );
    });
  });

  describe("isEmailSuppressed", () => {
    it("returns true for suppressed address", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ id: "sup-1" }] });

      const result = await service.isEmailSuppressed("bounced@example.com");
      expect(result).toBe(true);
    });

    it("returns false for non-suppressed address", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.isEmailSuppressed("good@example.com");
      expect(result).toBe(false);
    });
  });

  // ── Threading ──

  describe("threading", () => {
    it("resolves thread from in-reply-to header on send", async () => {
      const { service, pool } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: "inbox-1", agent_id: AGENT_ID, email_address: "g@ai.nookplot.com", is_active: true,
        }],
      });
      // getDailyLimit
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [] });
      // isEmailSuppressed
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Thread resolution — find existing thread
      pool.query.mockResolvedValueOnce({
        rows: [{ thread_id: "existing-thread-id", id: "parent-msg" }],
      });
      // INSERT message
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "msg-1", thread_id: "existing-thread-id" }],
      });
      // daily counter
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const msg = await service.sendEmail(AGENT_ID, {
        to: "bob@example.com",
        subject: "Re: Discussion",
        bodyText: "Continuing the thread",
        inReplyTo: "<parent@example.com>",
      });

      // Verify thread lookup query was made
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT thread_id"),
        ["<parent@example.com>"],
      );
    });
  });

  // ── Stats ──

  describe("getEmailStats", () => {
    it("returns aggregated stats", async () => {
      const { service, pool } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, is_active: true }],
      });
      // sent count
      pool.query.mockResolvedValueOnce({ rows: [{ count: "25" }] });
      // received count
      pool.query.mockResolvedValueOnce({ rows: [{ count: "100" }] });
      // unread count
      pool.query.mockResolvedValueOnce({ rows: [{ count: "10" }] });
      // getDailyLimit
      pool.query.mockResolvedValueOnce({ rows: [] });
      // getTodaySendCount
      pool.query.mockResolvedValueOnce({ rows: [{ send_count: 5 }] });

      const stats = await service.getEmailStats(AGENT_ID);

      expect(stats.sent).toBe(25);
      expect(stats.received).toBe(100);
      expect(stats.unread).toBe(10);
      expect(stats.dailySendsRemaining).toBe(45); // 50 - 5
    });
  });

  // ── Messages ──

  describe("listMessages", () => {
    it("returns messages with pagination", async () => {
      const { service, pool } = createService();

      // getInbox
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "inbox-1", agent_id: AGENT_ID, is_active: true }],
      });
      // messages query
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "msg-1" }, { id: "msg-2" }],
      });
      // count query
      pool.query.mockResolvedValueOnce({
        rows: [{ count: "42" }],
      });

      const result = await service.listMessages(AGENT_ID, { limit: 10, offset: 0 });
      expect(result.messages).toHaveLength(2);
      expect(result.total).toBe(42);
    });
  });

  describe("markRead", () => {
    it("updates message status to read", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.markRead(AGENT_ID, "msg-1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'read'"),
        ["msg-1", AGENT_ID],
      );
    });

    it("throws when message not found", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      await expect(service.markRead(AGENT_ID, "nope")).rejects.toThrow("not found");
    });
  });

  describe("deleteMessage", () => {
    it("deletes message", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.deleteMessage(AGENT_ID, "msg-1");
    });

    it("throws when message not found", async () => {
      const { service, pool } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      await expect(service.deleteMessage(AGENT_ID, "nope")).rejects.toThrow("not found");
    });
  });
});
