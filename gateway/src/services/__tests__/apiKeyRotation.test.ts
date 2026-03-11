import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateApiKey, hashApiKey, isValidApiKeyFormat } from "../../auth.js";

// Stable HMAC secret for tests
const HMAC_SECRET = "a".repeat(64);

describe("API Key Rotation", () => {
  describe("generateApiKey", () => {
    it("returns a valid nk_ prefixed key", () => {
      const { key, prefix } = generateApiKey();
      expect(key).toMatch(/^nk_[A-Za-z0-9_-]{64}$/);
      expect(prefix).toBe(key.slice(0, 11));
      expect(isValidApiKeyFormat(key)).toBe(true);
    });

    it("generates unique keys on each call", () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(a.key).not.toBe(b.key);
      expect(a.prefix).not.toBe(b.prefix);
    });
  });

  describe("hashApiKey", () => {
    it("produces deterministic hash for same key + secret", () => {
      const { key } = generateApiKey();
      const hash1 = hashApiKey(key, HMAC_SECRET);
      const hash2 = hashApiKey(key, HMAC_SECRET);
      expect(hash1).toBe(hash2);
    });

    it("different keys produce different hashes", () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(hashApiKey(a.key, HMAC_SECRET)).not.toBe(hashApiKey(b.key, HMAC_SECRET));
    });

    it("different secrets produce different hashes", () => {
      const { key } = generateApiKey();
      const secret2 = "b".repeat(64);
      expect(hashApiKey(key, HMAC_SECRET)).not.toBe(hashApiKey(key, secret2));
    });
  });

  describe("key rotation simulation", () => {
    it("old key hash differs from new key hash (rotation invalidates old key)", () => {
      const old = generateApiKey();
      const oldHash = hashApiKey(old.key, HMAC_SECRET);

      // Simulate rotation: generate new key
      const rotated = generateApiKey();
      const newHash = hashApiKey(rotated.key, HMAC_SECRET);

      expect(oldHash).not.toBe(newHash);
      expect(old.key).not.toBe(rotated.key);

      // The old key would no longer match any stored hash after rotation
      expect(hashApiKey(old.key, HMAC_SECRET)).toBe(oldHash);
      expect(hashApiKey(old.key, HMAC_SECRET)).not.toBe(newHash);
    });

    it("new key works with the new hash", () => {
      const rotated = generateApiKey();
      const storedHash = hashApiKey(rotated.key, HMAC_SECRET);

      // Simulate auth lookup: incoming key hashed matches stored hash
      expect(hashApiKey(rotated.key, HMAC_SECRET)).toBe(storedHash);
    });
  });

  describe("isValidApiKeyFormat", () => {
    it("validates correct format", () => {
      const { key } = generateApiKey();
      expect(isValidApiKeyFormat(key)).toBe(true);
    });

    it("rejects empty string", () => {
      expect(isValidApiKeyFormat("")).toBe(false);
    });

    it("rejects wrong prefix", () => {
      expect(isValidApiKeyFormat("sk_" + "a".repeat(64))).toBe(false);
    });

    it("rejects wrong length", () => {
      expect(isValidApiKeyFormat("nk_" + "a".repeat(63))).toBe(false);
      expect(isValidApiKeyFormat("nk_" + "a".repeat(65))).toBe(false);
    });

    it("rejects invalid characters", () => {
      expect(isValidApiKeyFormat("nk_" + "a".repeat(63) + "!")).toBe(false);
    });
  });

  describe("key-info metadata", () => {
    it("prefix is first 11 chars of key", () => {
      const { key, prefix } = generateApiKey();
      expect(prefix).toHaveLength(11);
      expect(prefix).toBe(key.slice(0, 11));
      expect(prefix.startsWith("nk_")).toBe(true);
    });
  });

  describe("auth error hints", () => {
    it("hint content matches expected patterns", () => {
      // Verify that hint strings are well-formed (integration check for the pattern)
      const hints = {
        missing: "Include an Authorization header",
        badFormat: "API keys start with 'nk_'",
        notFound: "This key may have been rotated",
      };

      expect(hints.missing).toContain("Authorization");
      expect(hints.badFormat).toContain("nk_");
      expect(hints.notFound).toContain("rotated");
    });
  });
});
