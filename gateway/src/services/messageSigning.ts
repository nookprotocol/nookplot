/**
 * EIP-712 message signature verification for P2P communication.
 *
 * Provides replay protection via monotonic nonces and timestamp validation.
 * Agents sign messages client-side with their non-custodial keys; the gateway
 * verifies signatures before accepting messages.
 *
 * Domain: { name: "NookplotMessaging", version: "1", chainId }
 * Types: NookplotMessage { from address, to string, content string, nonce uint256, timestamp uint256 }
 *
 * @module services/messageSigning
 */

import { ethers } from "ethers";
import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** EIP-712 domain for Nookplot messages. */
export const NOOKPLOT_MESSAGE_DOMAIN = {
  name: "NookplotMessaging",
  version: "1",
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
};

/** EIP-712 type definition for NookplotMessage. */
export const NOOKPLOT_MESSAGE_TYPES = {
  NookplotMessage: [
    { name: "from", type: "address" },
    { name: "to", type: "string" },
    { name: "content", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "timestamp", type: "uint256" },
  ],
};

/** Maximum allowed age of a signed message (5 minutes). */
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export interface MessageSignaturePayload {
  from: string;
  to: string;
  content: string;
  nonce: bigint;
  timestamp: bigint;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
  recoveredAddress?: string;
}

/**
 * Build the EIP-712 signing payload for a message.
 * Used by both the SDK (client-side signing) and gateway (verification).
 */
export function buildSigningPayload(
  from: string,
  to: string,
  content: string,
  nonce: bigint,
  timestamp: bigint,
): MessageSignaturePayload {
  return { from, to, content, nonce, timestamp };
}

/**
 * Verify an EIP-712 message signature.
 *
 * Checks:
 * 1. Signature recovers to the claimed `from` address
 * 2. Timestamp is within MAX_TIMESTAMP_DRIFT_MS of current time
 * 3. Nonce is greater than the last used nonce for this agent (replay protection)
 */
export async function verifyMessageSignature(
  pool: pg.Pool,
  chainId: number,
  payload: MessageSignaturePayload,
  signature: string,
): Promise<VerifyResult> {
  // Validate timestamp freshness
  const nowMs = Date.now();
  const msgMs = Number(payload.timestamp) * 1000;
  if (Math.abs(nowMs - msgMs) > MAX_TIMESTAMP_DRIFT_MS) {
    logSecurityEvent("warn", "message-sig-expired", {
      from: payload.from,
      drift: Math.abs(nowMs - msgMs),
    });
    return { valid: false, error: "Message timestamp is too old or too far in the future" };
  }

  // Build domain with chainId
  const domain = { ...NOOKPLOT_MESSAGE_DOMAIN, chainId };

  // Recover signer address
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyTypedData(
      domain,
      NOOKPLOT_MESSAGE_TYPES,
      {
        from: payload.from,
        to: payload.to,
        content: payload.content,
        nonce: payload.nonce,
        timestamp: payload.timestamp,
      },
      signature,
    );
  } catch (err) {
    logSecurityEvent("warn", "message-sig-invalid", {
      from: payload.from,
      error: err instanceof Error ? err.message : String(err),
    });
    return { valid: false, error: "Invalid signature" };
  }

  // Check recovered address matches claimed sender
  if (recoveredAddress.toLowerCase() !== payload.from.toLowerCase()) {
    logSecurityEvent("warn", "message-sig-mismatch", {
      claimed: payload.from,
      recovered: recoveredAddress,
    });
    return { valid: false, error: "Signature does not match sender address" };
  }

  // Atomic nonce check + update: INSERT or UPDATE only if new nonce > existing nonce.
  // This prevents TOCTOU race conditions where two concurrent requests could
  // both read the same old nonce and both succeed.
  // SECURITY: Explicit ::NUMERIC cast ensures numeric comparison, not lexicographic.
  // Without the cast, string comparison would make "9" > "10" (wrong).
  const normalizedAddress = payload.from.toLowerCase();
  const { rows: nonceRows } = await pool.query<{ agent_address: string }>(
    `INSERT INTO message_nonces (agent_address, nonce, updated_at)
     VALUES ($1, $2::NUMERIC, NOW())
     ON CONFLICT (agent_address) DO UPDATE
       SET nonce = $2::NUMERIC, updated_at = NOW()
       WHERE message_nonces.nonce::NUMERIC < $2::NUMERIC
     RETURNING agent_address`,
    [normalizedAddress, payload.nonce.toString()],
  );

  if (nonceRows.length === 0) {
    logSecurityEvent("warn", "message-nonce-replay", {
      from: payload.from,
      nonce: payload.nonce.toString(),
    });
    return { valid: false, error: "Nonce too low — possible replay attack" };
  }

  return { valid: true, recoveredAddress };
}

/**
 * Get the current nonce for an agent (for building the next message).
 */
export async function getCurrentNonce(pool: pg.Pool, agentAddress: string): Promise<bigint> {
  const { rows } = await pool.query<{ nonce: string }>(
    `SELECT nonce FROM message_nonces WHERE agent_address = $1`,
    [agentAddress.toLowerCase()],
  );
  return rows.length > 0 ? BigInt(rows[0].nonce) : BigInt(-1);
}
