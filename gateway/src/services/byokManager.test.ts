import { describe, it, expect, vi, beforeEach } from "vitest";
import { ByokManager } from "./byokManager.js";
import { createMockPool } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock secretManager
const mockEncrypt = vi.fn().mockReturnValue({
  encryptedKey: "encrypted-data",
  iv: "mock-iv",
  authTag: "mock-tag",
});
const mockDecrypt = vi.fn().mockReturnValue("decrypted-api-key");

vi.mock("../secretManager.js", () => ({
  encryptPrivateKey: (...args: unknown[]) => mockEncrypt(...args),
  decryptPrivateKey: (...args: unknown[]) => mockDecrypt(...args),
}));

const MASTER_KEY = "test-master-key-32-chars-exactly";

// ---------------------------------------------------------------------------
//  storeKey
// ---------------------------------------------------------------------------

describe("ByokManager — storeKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("encrypts and stores a key", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    await mgr.storeKey("agt_1", "anthropic", "sk-FAKE-ant-test-key");

    expect(mockEncrypt).toHaveBeenCalledWith("sk-FAKE-ant-test-key", MASTER_KEY);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO byok_keys"),
      ["agt_1", "anthropic", "encrypted-data", "mock-iv", "mock-tag"],
    );
  });

  it("validates anthropic key format", async () => {
    const pool = createMockPool();
    const mgr = new ByokManager(pool as any, MASTER_KEY);

    await expect(
      mgr.storeKey("agt_1", "anthropic", "invalid-key"),
    ).rejects.toThrow("Invalid API key format");
  });

  it("validates openai key format", async () => {
    const pool = createMockPool();
    const mgr = new ByokManager(pool as any, MASTER_KEY);

    await expect(
      mgr.storeKey("agt_1", "openai", "not-sk-key"),
    ).rejects.toThrow("Invalid API key format");
  });

  it("accepts openai keys with sk- prefix", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    await mgr.storeKey("agt_1", "openai", "sk-FAKE-test-openai-key");

    expect(pool.query).toHaveBeenCalled();
  });

  it("allows unknown providers without format check", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    await mgr.storeKey("agt_1", "custom-provider", "any-format-key");

    expect(pool.query).toHaveBeenCalled();
  });

  it("rejects empty key", async () => {
    const pool = createMockPool();
    const mgr = new ByokManager(pool as any, MASTER_KEY);

    await expect(
      mgr.storeKey("agt_1", "custom", ""),
    ).rejects.toThrow("must not be empty");
  });

  it("rejects whitespace-only key", async () => {
    const pool = createMockPool();
    const mgr = new ByokManager(pool as any, MASTER_KEY);

    await expect(
      mgr.storeKey("agt_1", "custom", "   "),
    ).rejects.toThrow("must not be empty");
  });
});

// ---------------------------------------------------------------------------
//  getKey
// ---------------------------------------------------------------------------

describe("ByokManager — getKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns decrypted key when found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ encrypted_key: "enc", iv: "iv", auth_tag: "tag" }],
      rowCount: 1,
    });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const key = await mgr.getKey("agt_1", "anthropic");

    expect(key).toBe("decrypted-api-key");
    expect(mockDecrypt).toHaveBeenCalledWith("enc", "iv", "tag", MASTER_KEY);
  });

  it("returns null when no key stored", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const key = await mgr.getKey("agt_1", "anthropic");

    expect(key).toBeNull();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  removeKey
// ---------------------------------------------------------------------------

describe("ByokManager — removeKey", () => {
  it("returns true when key deleted", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const result = await mgr.removeKey("agt_1", "anthropic");

    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM byok_keys"),
      ["agt_1", "anthropic"],
    );
  });

  it("returns false when key not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const result = await mgr.removeKey("agt_1", "nonexistent");

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  listProviders
// ---------------------------------------------------------------------------

describe("ByokManager — listProviders", () => {
  it("returns provider list with timestamps", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { provider: "anthropic", created_at: new Date("2025-06-01") },
        { provider: "openai", created_at: new Date("2025-06-02") },
      ],
      rowCount: 2,
    });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const providers = await mgr.listProviders("agt_1");

    expect(providers).toHaveLength(2);
    expect(providers[0].provider).toBe("anthropic");
    expect(providers[0].createdAt).toContain("2025-06-01");
    expect(providers[1].provider).toBe("openai");
  });

  it("returns empty array when no keys stored", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const providers = await mgr.listProviders("agt_1");

    expect(providers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  inheritKeys
// ---------------------------------------------------------------------------

describe("ByokManager — inheritKeys", () => {
  it("copies parent keys to child", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const count = await mgr.inheritKeys("parent_1", "child_1");

    expect(count).toBe(2);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO byok_keys"),
      ["parent_1", "child_1"],
    );
  });

  it("returns 0 when parent has no keys", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const mgr = new ByokManager(pool as any, MASTER_KEY);
    const count = await mgr.inheritKeys("parent_1", "child_1");

    expect(count).toBe(0);
  });
});
