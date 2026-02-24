/**
 * Secret encryption/decryption for the Agent Gateway.
 *
 * Used by BYOK manager (API keys) and GitHub client (PATs).
 * Agent wallet keys are no longer stored server-side.
 *
 * @module secretManager
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Encrypt a secret with AES-256-GCM.
 *
 * @param secret - The plaintext secret to encrypt.
 * @param masterKey - 32-byte hex string encryption key.
 * @returns Encrypted data (ciphertext, IV, auth tag) as hex strings.
 */
export function encryptSecret(
  secret: string,
  masterKey: string,
): { encryptedKey: string; iv: string; authTag: string } {
  const keyBuffer = Buffer.from(masterKey, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error("SECRET_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);

  let encrypted = cipher.update(secret, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return {
    encryptedKey: encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Decrypt a secret from encrypted storage.
 *
 * @param encryptedKey - Hex-encoded ciphertext.
 * @param iv - Hex-encoded initialization vector.
 * @param authTag - Hex-encoded GCM authentication tag.
 * @param masterKey - 32-byte hex string encryption key.
 * @returns The decrypted plaintext secret.
 * @throws If decryption fails (wrong key, tampered data, etc.).
 */
export function decryptSecret(
  encryptedKey: string,
  iv: string,
  authTag: string,
  masterKey: string,
): string {
  const keyBuffer = Buffer.from(masterKey, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error("SECRET_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)");
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    keyBuffer,
    Buffer.from(iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTag, "hex"));

  let decrypted = decipher.update(encryptedKey, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

// Backwards-compatible aliases for existing callers during migration
export const encryptPrivateKey = encryptSecret;
export const decryptPrivateKey = decryptSecret;
