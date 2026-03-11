import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { encryptSecret, decryptSecret } from "./secretManager.js";

// Generate a valid 32-byte hex key for testing
const MASTER_KEY = crypto.randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------
//  encryptSecret
// ---------------------------------------------------------------------------

describe("encryptSecret", () => {
  it("returns encrypted data with iv and authTag", () => {
    const result = encryptSecret("my-secret-value", MASTER_KEY);

    expect(result.encryptedKey).toBeDefined();
    expect(result.iv).toBeDefined();
    expect(result.authTag).toBeDefined();
    expect(result.encryptedKey.length).toBeGreaterThan(0);
    expect(result.iv.length).toBe(24); // 12 bytes = 24 hex chars
  });

  it("produces different ciphertexts for same plaintext (random IV)", () => {
    const result1 = encryptSecret("same-secret", MASTER_KEY);
    const result2 = encryptSecret("same-secret", MASTER_KEY);

    expect(result1.encryptedKey).not.toBe(result2.encryptedKey);
    expect(result1.iv).not.toBe(result2.iv);
  });

  it("throws for invalid key length", () => {
    expect(() => encryptSecret("secret", "tooshort")).toThrow("32 bytes");
  });
});

// ---------------------------------------------------------------------------
//  decryptSecret
// ---------------------------------------------------------------------------

describe("decryptSecret", () => {
  it("decrypts back to original plaintext", () => {
    const original = "my-webhook-secret-whsec_123456";
    const { encryptedKey, iv, authTag } = encryptSecret(original, MASTER_KEY);
    const decrypted = decryptSecret(encryptedKey, iv, authTag, MASTER_KEY);

    expect(decrypted).toBe(original);
  });

  it("decrypts unicode content", () => {
    const original = "secret with émojis 🔑 and ñ";
    const { encryptedKey, iv, authTag } = encryptSecret(original, MASTER_KEY);
    const decrypted = decryptSecret(encryptedKey, iv, authTag, MASTER_KEY);

    expect(decrypted).toBe(original);
  });

  it("throws with wrong key", () => {
    const { encryptedKey, iv, authTag } = encryptSecret("secret", MASTER_KEY);
    const wrongKey = crypto.randomBytes(32).toString("hex");

    expect(() => decryptSecret(encryptedKey, iv, authTag, wrongKey)).toThrow();
  });

  it("throws with tampered ciphertext", () => {
    const { encryptedKey, iv, authTag } = encryptSecret("secret", MASTER_KEY);
    const tampered = "ff" + encryptedKey.slice(2);

    expect(() => decryptSecret(tampered, iv, authTag, MASTER_KEY)).toThrow();
  });

  it("throws with tampered authTag", () => {
    const { encryptedKey, iv, authTag } = encryptSecret("secret", MASTER_KEY);
    const tampered = "00".repeat(authTag.length / 2);

    expect(() => decryptSecret(encryptedKey, iv, tampered, MASTER_KEY)).toThrow();
  });

  it("throws for invalid key length", () => {
    expect(() => decryptSecret("enc", "iv", "tag", "short")).toThrow("32 bytes");
  });
});

// ---------------------------------------------------------------------------
//  Round-trip with various payloads
// ---------------------------------------------------------------------------

describe("encryptSecret + decryptSecret — round-trip", () => {
  it("handles empty string", () => {
    const { encryptedKey, iv, authTag } = encryptSecret("", MASTER_KEY);
    const decrypted = decryptSecret(encryptedKey, iv, authTag, MASTER_KEY);
    expect(decrypted).toBe("");
  });

  it("handles long payload", () => {
    const long = "x".repeat(10000);
    const { encryptedKey, iv, authTag } = encryptSecret(long, MASTER_KEY);
    const decrypted = decryptSecret(encryptedKey, iv, authTag, MASTER_KEY);
    expect(decrypted).toBe(long);
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ apiKey: "sk-test", nested: { value: 42 } });
    const { encryptedKey, iv, authTag } = encryptSecret(json, MASTER_KEY);
    const decrypted = decryptSecret(encryptedKey, iv, authTag, MASTER_KEY);
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(json));
  });
});
