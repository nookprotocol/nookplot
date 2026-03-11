import { describe, it, expect, vi, beforeEach } from "vitest";
import { EgressProxy } from "./egressProxy.js";
import { createMockPool } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock secretManager
vi.mock("../secretManager.js", () => ({
  decryptSecret: vi.fn().mockReturnValue("decrypted-api-key"),
}));

// Mock dns/promises at module level (Node builtins have non-configurable properties)
const mockResolve4 = vi.fn().mockResolvedValue(["203.0.113.1"]);
const mockResolve6 = vi.fn().mockResolvedValue([]);
vi.mock("dns/promises", () => ({
  default: {
    resolve4: (...args: unknown[]) => mockResolve4(...args),
    resolve6: (...args: unknown[]) => mockResolve6(...args),
  },
  resolve4: (...args: unknown[]) => mockResolve4(...args),
  resolve6: (...args: unknown[]) => mockResolve6(...args),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 500 }),
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 600 }),
  };
}

/**
 * Sets up pool mock queries to pass through denylist + allowlist checks.
 * These precede the secret scan in the execute() pipeline.
 */
function setupDomainChecks(pool: ReturnType<typeof createMockPool>) {
  // Global denylist — not blocked
  pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // Agent allowlist — allowed
  pool.query.mockResolvedValueOnce({
    rows: [{ domain: "example.com", max_requests_per_hour: 60 }],
    rowCount: 1,
  });
}

beforeEach(() => {
  mockResolve4.mockResolvedValue(["203.0.113.1"]);
  mockResolve6.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
//  scanForSecrets (tested indirectly through execute)
//  Pipeline order: URL → protocol → blocked hostnames → private IP →
//  DNS → denylist → allowlist → SECRET SCAN → rate limit → credits → fetch
// ---------------------------------------------------------------------------

describe("EgressProxy — secret scanning", () => {
  it("blocks Ethereum private keys in URL", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    setupDomainChecks(pool);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    const hexKey = "0x" + "a".repeat(64);

    await expect(
      proxy.execute("agt_1", {
        url: `https://example.com/?key=${hexKey}`,
        method: "GET",
      }),
    ).rejects.toThrow("sensitive data pattern");
  });

  it("blocks OpenAI API keys in body", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    setupDomainChecks(pool);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", {
        url: "https://example.com/api",
        method: "POST",
        body: "Authorization: sk-abcdefghijklmnopqrstuvwxyz1234567890",
      }),
    ).rejects.toThrow("sensitive data pattern");
  });

  it("blocks GitHub PATs in headers", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    setupDomainChecks(pool);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", {
        url: "https://example.com/api",
        method: "GET",
        headers: { Authorization: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" },
      }),
    ).rejects.toThrow("sensitive data pattern");
  });

  it("blocks AWS access keys", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    setupDomainChecks(pool);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", {
        url: "https://example.com/api",
        method: "POST",
        body: "key=AKIAIOSFODNN7EXAMPLE",
      }),
    ).rejects.toThrow("sensitive data pattern");
  });

  it("blocks PEM private keys", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    setupDomainChecks(pool);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", {
        url: "https://example.com/api",
        method: "POST",
        body: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAI...",
      }),
    ).rejects.toThrow("sensitive data pattern");
  });

  it("blocks Slack tokens", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    setupDomainChecks(pool);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", {
        url: "https://example.com/api",
        method: "POST",
        body: "token=xoxb-1234567890-abcdefgh",
      }),
    ).rejects.toThrow("sensitive data pattern");
  });
});

// ---------------------------------------------------------------------------
//  URL + Protocol validation
// ---------------------------------------------------------------------------

describe("EgressProxy — URL validation", () => {
  it("rejects invalid URLs", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", { url: "not-a-url", method: "GET" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("rejects non-http/https protocols", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", { url: "ftp://example.com/file", method: "GET" }),
    ).rejects.toThrow("Protocol");
  });
});

// ---------------------------------------------------------------------------
//  SSRF protection
// ---------------------------------------------------------------------------

describe("EgressProxy — SSRF protection", () => {
  it("blocks requests to private IPs (direct)", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", { url: "http://10.0.0.1/admin", method: "GET" }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("blocks requests to loopback", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", { url: "http://127.0.0.1/admin", method: "GET" }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("blocks blocked hostnames (platform internal)", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", { url: "http://postgres.railway.internal:5432", method: "GET" }),
    ).rejects.toThrow("internal/infrastructure");
  });

  it("blocks cloud metadata endpoint", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const proxy = new EgressProxy(pool as any, cm as any, "test-key");

    await expect(
      proxy.execute("agt_1", { url: "http://metadata.google.internal/computeMetadata/v1/", method: "GET" }),
    ).rejects.toThrow("internal/infrastructure");
  });
});

// ---------------------------------------------------------------------------
//  Domain denylist + allowlist
// ---------------------------------------------------------------------------

describe("EgressProxy — domain checks", () => {
  it("blocks globally denied domains", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();

    // Global denylist hit
    pool.query.mockResolvedValueOnce({ rows: [{ domain: "evil.com" }], rowCount: 1 });

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    await expect(
      proxy.execute("agt_1", { url: "https://evil.com/api", method: "GET" }),
    ).rejects.toThrow("denied by platform policy");
  });

  it("blocks domains not on agent allowlist", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();

    // Global denylist — not blocked
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Agent allowlist — not on it
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    await expect(
      proxy.execute("agt_1", { url: "https://example.com/api", method: "GET" }),
    ).rejects.toThrow("not on your egress allowlist");
  });
});

// ---------------------------------------------------------------------------
//  Rate limiting
// ---------------------------------------------------------------------------

describe("EgressProxy — rate limiting", () => {
  it("blocks when rate limit exceeded", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();

    setupDomainChecks(pool);
    // Rate limit check — exceeded
    pool.query.mockResolvedValueOnce({ rows: [{ current_count: "61", max_allowed: "60" }], rowCount: 1 });

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    await expect(
      proxy.execute("agt_1", { url: "https://example.com/api", method: "GET" }),
    ).rejects.toThrow("Rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
//  Credit checks
// ---------------------------------------------------------------------------

describe("EgressProxy — credit checks", () => {
  it("blocks when credits insufficient", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    cm.deductCredits = vi.fn().mockRejectedValue(new Error("INSUFFICIENT_CREDITS"));

    setupDomainChecks(pool);
    // Rate limit — under
    pool.query.mockResolvedValueOnce({ rows: [{ current_count: "1", max_allowed: "60" }], rowCount: 1 });

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    await expect(
      proxy.execute("agt_1", { url: "https://example.com/api", method: "GET" }),
    ).rejects.toThrow("Insufficient credits");
  });
});

// ---------------------------------------------------------------------------
//  DNS rebinding protection
// ---------------------------------------------------------------------------

describe("EgressProxy — DNS rebinding", () => {
  it("blocks when DNS resolves to private IP", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    mockResolve4.mockResolvedValueOnce(["192.168.1.1"]);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    await expect(
      proxy.execute("agt_1", { url: "https://evil-rebind.com/api", method: "GET" }),
    ).rejects.toThrow("private/reserved IP");
  });

  it("blocks when DNS fails to resolve", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    mockResolve4.mockResolvedValueOnce([]);
    mockResolve6.mockResolvedValueOnce([]);

    const proxy = new EgressProxy(pool as any, cm as any, "test-key");
    await expect(
      proxy.execute("agt_1", { url: "https://nonexistent.example.com/api", method: "GET" }),
    ).rejects.toThrow("DNS resolution failed");
  });
});
