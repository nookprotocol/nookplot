/**
 * Email-based identity verification.
 *
 * Sends a 6-digit verification code to the claimed email address.
 * Agent submits the code back to prove they control the email.
 * Codes expire after 15 minutes, max 3 attempts.
 *
 * @module services/verifiers/emailVerifier
 */

import crypto from "crypto";
import type { Pool } from "pg";
import { logSecurityEvent } from "../../middleware/auditLog.js";

export interface EmailVerifyResult {
  verified: boolean;
  email?: string;
  error?: string;
}

export class EmailVerifier {
  private readonly pool: Pool;
  private readonly sendEmail: (to: string, subject: string, body: string) => Promise<boolean>;

  /**
   * @param pool - Database pool
   * @param sendEmail - Email sending function (pluggable — use your preferred provider)
   */
  constructor(pool: Pool, sendEmail: (to: string, subject: string, body: string) => Promise<boolean>) {
    this.pool = pool;
    this.sendEmail = sendEmail;
  }

  /**
   * Generate and send a verification code for a claim.
   */
  async sendVerificationCode(claimId: string, email: string): Promise<{ sent: boolean; error?: string }> {
    try {
      // Generate 6-digit code
      const code = crypto.randomInt(100000, 999999).toString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      // Store in DB (overwrite any existing code for this claim)
      await this.pool.query(
        `INSERT INTO email_verifications (claim_id, email, code, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (claim_id) DO UPDATE SET
           code = EXCLUDED.code,
           attempts = 0,
           expires_at = EXCLUDED.expires_at,
           verified_at = NULL`,
        [claimId, email, code, expiresAt],
      );

      // Send email
      const sent = await this.sendEmail(
        email,
        "Nookplot Verification Code",
        `Your Nookplot verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
      );

      if (!sent) {
        return { sent: false, error: "Failed to send verification email" };
      }

      logSecurityEvent("info", "email-verification-sent", { claimId, email: email.replace(/(.{2})(.*)(@.*)/, "$1***$3") });
      return { sent: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { sent: false, error: msg };
    }
  }

  /**
   * Verify a submitted code against the stored code.
   */
  async verifyCode(claimId: string, submittedCode: string): Promise<EmailVerifyResult> {
    try {
      const { rows } = await this.pool.query<{
        email: string;
        code: string;
        attempts: number;
        expires_at: Date;
        verified_at: Date | null;
      }>(
        `SELECT email, code, attempts, expires_at, verified_at
         FROM email_verifications
         WHERE claim_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [claimId],
      );

      if (rows.length === 0) {
        return { verified: false, error: "No verification code found. Request a new one." };
      }

      const record = rows[0];

      if (record.verified_at) {
        return { verified: true, email: record.email };
      }

      if (record.attempts >= 3) {
        return { verified: false, error: "Maximum attempts exceeded. Request a new code." };
      }

      if (new Date() > record.expires_at) {
        return { verified: false, error: "Verification code expired. Request a new code." };
      }

      // Increment attempts
      await this.pool.query(
        `UPDATE email_verifications SET attempts = attempts + 1 WHERE claim_id = $1`,
        [claimId],
      );

      // Constant-time comparison to prevent timing attacks
      if (!crypto.timingSafeEqual(Buffer.from(submittedCode), Buffer.from(record.code))) {
        logSecurityEvent("warn", "email-verification-failed", {
          claimId,
          attempts: record.attempts + 1,
        });
        return { verified: false, error: "Invalid verification code." };
      }

      // Mark as verified
      await this.pool.query(
        `UPDATE email_verifications SET verified_at = NOW() WHERE claim_id = $1`,
        [claimId],
      );

      logSecurityEvent("info", "email-verification-success", { claimId });
      return { verified: true, email: record.email };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { verified: false, error: msg };
    }
  }
}
