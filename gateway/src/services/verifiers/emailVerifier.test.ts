import { describe, it, expect, vi } from "vitest";
import { EmailVerifier } from "./emailVerifier.js";
import { createMockPool } from "../../test/helpers.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockSendEmail(success = true) {
  return vi.fn().mockResolvedValue(success);
}

// ---------------------------------------------------------------------------
//  sendVerificationCode
// ---------------------------------------------------------------------------

describe("EmailVerifier.sendVerificationCode", () => {
  it("generates code, stores in DB, and sends email", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail(true);
    const verifier = new EmailVerifier(pool as any, sendEmail);

    // INSERT code
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await verifier.sendVerificationCode("claim-1", "user@example.com");

    expect(result.sent).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify DB insert was called
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO email_verifications");
    expect(params[0]).toBe("claim-1");
    expect(params[1]).toBe("user@example.com");
    // Code should be 6 digits
    expect(params[2]).toMatch(/^\d{6}$/);

    // Verify email was sent
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][0]).toBe("user@example.com");
    expect(sendEmail.mock.calls[0][1]).toContain("Verification Code");
  });

  it("returns error when email sending fails", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail(false);
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await verifier.sendVerificationCode("claim-1", "user@example.com");

    expect(result.sent).toBe(false);
    expect(result.error).toContain("Failed to send");
  });

  it("returns error when DB insert fails", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail(true);
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockRejectedValueOnce(new Error("DB connection error"));

    const result = await verifier.sendVerificationCode("claim-1", "user@example.com");

    expect(result.sent).toBe(false);
    expect(result.error).toContain("DB connection error");
  });
});

// ---------------------------------------------------------------------------
//  verifyCode
// ---------------------------------------------------------------------------

describe("EmailVerifier.verifyCode", () => {
  it("verifies correct code", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail();
    const verifier = new EmailVerifier(pool as any, sendEmail);

    // SELECT verification record
    pool.query.mockResolvedValueOnce({
      rows: [{
        email: "user@example.com",
        code: "123456",
        attempts: 0,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        verified_at: null,
      }],
      rowCount: 1,
    });
    // UPDATE attempts
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // UPDATE verified_at
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await verifier.verifyCode("claim-1", "123456");

    expect(result.verified).toBe(true);
    expect(result.email).toBe("user@example.com");
  });

  it("rejects incorrect code", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail();
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockResolvedValueOnce({
      rows: [{
        email: "user@example.com",
        code: "123456",
        attempts: 0,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        verified_at: null,
      }],
      rowCount: 1,
    });
    // UPDATE attempts
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await verifier.verifyCode("claim-1", "999999");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Invalid");
  });

  it("returns error when no verification code found", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail();
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await verifier.verifyCode("claim-missing", "123456");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("No verification code found");
  });

  it("returns already verified if code was previously verified", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail();
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockResolvedValueOnce({
      rows: [{
        email: "user@example.com",
        code: "123456",
        attempts: 1,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        verified_at: new Date(),
      }],
      rowCount: 1,
    });

    const result = await verifier.verifyCode("claim-1", "123456");

    expect(result.verified).toBe(true);
    expect(result.email).toBe("user@example.com");
  });

  it("rejects when max attempts exceeded", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail();
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockResolvedValueOnce({
      rows: [{
        email: "user@example.com",
        code: "123456",
        attempts: 3,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        verified_at: null,
      }],
      rowCount: 1,
    });

    const result = await verifier.verifyCode("claim-1", "123456");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Maximum attempts");
  });

  it("rejects when code is expired", async () => {
    const pool = createMockPool();
    const sendEmail = createMockSendEmail();
    const verifier = new EmailVerifier(pool as any, sendEmail);

    pool.query.mockResolvedValueOnce({
      rows: [{
        email: "user@example.com",
        code: "123456",
        attempts: 0,
        expires_at: new Date(Date.now() - 1000), // expired
        verified_at: null,
      }],
      rowCount: 1,
    });

    const result = await verifier.verifyCode("claim-1", "123456");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("expired");
  });
});
