import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubVerifier } from "./githubVerifier.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Global fetch mock
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
//  getAuthorizationUrl
// ---------------------------------------------------------------------------

describe("GitHubVerifier.getAuthorizationUrl", () => {
  it("generates correct GitHub OAuth URL", () => {
    const verifier = new GitHubVerifier("client-id-123", "secret", "https://example.com/callback");
    const url = verifier.getAuthorizationUrl("state-abc");

    expect(url).toContain("https://github.com/login/oauth/authorize");
    expect(url).toContain("client_id=client-id-123");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcallback");
    expect(url).toContain("scope=read%3Auser");
    expect(url).toContain("state=state-abc");
  });
});

// ---------------------------------------------------------------------------
//  verifyCallback
// ---------------------------------------------------------------------------

describe("GitHubVerifier.verifyCallback", () => {
  const verifier = new GitHubVerifier("client-id", "client-secret", "https://example.com/cb");

  it("verifies matching username successfully", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Token exchange
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: "gho_token123" }),
        });
      }
      // Profile fetch
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            login: "testuser",
            html_url: "https://github.com/testuser",
            public_repos: 42,
            followers: 100,
          }),
      });
    });

    const result = await verifier.verifyCallback("oauth-code", "testuser");

    expect(result.verified).toBe(true);
    expect(result.username).toBe("testuser");
    expect(result.profileUrl).toBe("https://github.com/testuser");
    expect(result.publicRepos).toBe(42);
    expect(result.followers).toBe(100);
  });

  it("matches username case-insensitively", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: "gho_token123" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            login: "TestUser",
            html_url: "https://github.com/TestUser",
            public_repos: 10,
            followers: 5,
          }),
      });
    });

    const result = await verifier.verifyCallback("code", "testuser");
    expect(result.verified).toBe(true);
    expect(result.username).toBe("TestUser");
  });

  it("rejects username mismatch", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: "gho_token123" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            login: "realuser",
            html_url: "https://github.com/realuser",
            public_repos: 0,
            followers: 0,
          }),
      });
    });

    const result = await verifier.verifyCallback("code", "claimeduser");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("mismatch");
    expect(result.error).toContain("claimeduser");
    expect(result.error).toContain("realuser");
  });

  it("returns error when token exchange fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: "bad_verification_code" }),
    });

    const result = await verifier.verifyCallback("bad-code", "testuser");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("bad_verification_code");
  });

  it("returns error when no access_token and no error field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await verifier.verifyCallback("code", "testuser");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Failed to get access token");
  });

  it("returns error when profile fetch fails", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: "gho_token" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: "Bad credentials" }),
      });
    });

    const result = await verifier.verifyCallback("code", "testuser");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Failed to fetch GitHub user profile");
  });

  it("returns error on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await verifier.verifyCallback("code", "testuser");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("sends correct headers for token exchange", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: "test" }),
    });

    await verifier.verifyCallback("the-code", "user");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://github.com/login/oauth/access_token");
    const opts = call[1];
    expect(opts.method).toBe("POST");
    expect(opts.headers["Accept"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.code).toBe("the-code");
    expect(body.client_id).toBe("client-id");
    expect(body.client_secret).toBe("client-secret");
  });
});
