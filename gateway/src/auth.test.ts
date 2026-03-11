import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey, isValidApiKeyFormat } from "./auth.js";

// ---------------------------------------------------------------------------
//  generateApiKey
// ---------------------------------------------------------------------------

describe("generateApiKey", () => {
  it("returns a key with nk_ prefix", () => {
    const { key } = generateApiKey();
    expect(key.startsWith("nk_")).toBe(true);
  });

  it("returns a key of exactly 67 characters", () => {
    const { key } = generateApiKey();
    expect(key.length).toBe(67);
  });

  it("returns a prefix of 11 characters", () => {
    const { prefix } = generateApiKey();
    expect(prefix.length).toBe(11);
    expect(prefix.startsWith("nk_")).toBe(true);
  });

  it("generates unique keys", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 10; i++) {
      keys.add(generateApiKey().key);
    }
    expect(keys.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
//  hashApiKey
// ---------------------------------------------------------------------------

describe("hashApiKey", () => {
  it("produces consistent hex hashes", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const key = "nk_testkey";
    const hash1 = hashApiKey(key, secret);
    const hash2 = hashApiKey(key, secret);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different keys", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const hash1 = hashApiKey("nk_key1", secret);
    const hash2 = hashApiKey("nk_key2", secret);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different secrets", () => {
    const key = "nk_testkey";
    const hash1 = hashApiKey(key, "0123456789abcdef0123456789abcdef");
    const hash2 = hashApiKey(key, "fedcba9876543210fedcba9876543210");

    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
//  isValidApiKeyFormat
// ---------------------------------------------------------------------------

describe("isValidApiKeyFormat", () => {
  it("accepts valid API key format", () => {
    const { key } = generateApiKey();
    expect(isValidApiKeyFormat(key)).toBe(true);
  });

  it("rejects keys without nk_ prefix", () => {
    expect(isValidApiKeyFormat("sk_" + "A".repeat(64))).toBe(false);
  });

  it("rejects keys that are too short", () => {
    expect(isValidApiKeyFormat("nk_abc")).toBe(false);
  });

  it("rejects keys that are too long", () => {
    expect(isValidApiKeyFormat("nk_" + "A".repeat(65))).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isValidApiKeyFormat("")).toBe(false);
  });

  it("rejects null/undefined", () => {
    expect(isValidApiKeyFormat(null as any)).toBe(false);
    expect(isValidApiKeyFormat(undefined as any)).toBe(false);
  });

  it("rejects keys with invalid characters", () => {
    expect(isValidApiKeyFormat("nk_" + "!".repeat(64))).toBe(false);
  });
});
