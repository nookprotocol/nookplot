/**
 * API key generation, hashing, and validation for the Agent Gateway.
 *
 * API keys use the format: nk_<64 base64url chars> (~48 bytes of entropy).
 * Keys are HMAC-SHA256 hashed before storage — the plaintext is returned to
 * the agent exactly once during registration.
 *
 * @module auth
 */

import crypto from "crypto";

const API_KEY_PREFIX = "nk_";
const API_KEY_BYTES = 48;
const API_KEY_TOTAL_LENGTH = 67; // "nk_" (3) + 64 base64url chars

/**
 * Generate a new API key.
 *
 * @returns The full API key (nk_ + 64 base64url chars) and its prefix for identification.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const bytes = crypto.randomBytes(API_KEY_BYTES);
  const encoded = bytes
    .toString("base64url")
    .slice(0, 64);
  const key = `${API_KEY_PREFIX}${encoded}`;
  const prefix = key.slice(0, 11); // "nk_" + first 8 chars
  return { key, prefix };
}

/**
 * Hash an API key with HMAC-SHA256 for storage.
 *
 * Uses a server-side HMAC secret to prevent offline brute-force attacks
 * if the database is compromised. Without the HMAC secret, hashes are
 * useless to an attacker.
 *
 * @param key - The full API key (including nk_ prefix).
 * @param hmacSecret - The 32-byte HMAC secret (hex-encoded).
 * @returns The hex-encoded HMAC-SHA256 hash.
 */
export function hashApiKey(key: string, hmacSecret: string): string {
  const secretBuffer = Buffer.from(hmacSecret, "hex");
  return crypto.createHmac("sha256", secretBuffer).update(key).digest("hex");
}

/**
 * Validate that a string looks like a valid API key format.
 *
 * Does NOT verify against the database — only checks the format.
 *
 * @param key - The string to validate.
 * @returns True if it matches the expected format.
 */
export function isValidApiKeyFormat(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  if (!key.startsWith(API_KEY_PREFIX)) return false;
  // nk_ (3) + 64 base64url characters = exactly 67 chars
  if (key.length !== API_KEY_TOTAL_LENGTH) return false;
  return /^nk_[A-Za-z0-9_-]{64}$/.test(key);
}
