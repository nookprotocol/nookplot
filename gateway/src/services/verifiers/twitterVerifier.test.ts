import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TwitterVerifier } from "./twitterVerifier.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock twitterApi so we control token exchange and profile fetch
vi.mock("./twitterApi.js", () => ({
  exchangeTwitterCode: vi.fn(),
  fetchTwitterProfile: vi.fn(),
}));

import { exchangeTwitterCode, fetchTwitterProfile } from "./twitterApi.js";

const mockExchange = exchangeTwitterCode as ReturnType<typeof vi.fn>;
const mockProfile = fetchTwitterProfile as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExchange.mockReset();
  mockProfile.mockReset();
});

// ---------------------------------------------------------------------------
//  getAuthorizationUrl
// ---------------------------------------------------------------------------

describe("TwitterVerifier.getAuthorizationUrl", () => {
  it("generates correct Twitter OAuth 2.0 PKCE URL", () => {
    const verifier = new TwitterVerifier("tw-client", "tw-secret", "https://example.com/tw-cb");
    const url = verifier.getAuthorizationUrl("state-xyz", "challenge-abc");

    expect(url).toContain("https://twitter.com/i/oauth2/authorize");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=tw-client");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Ftw-cb");
    expect(url).toContain("scope=users.read+tweet.read");
    expect(url).toContain("state=state-xyz");
    expect(url).toContain("code_challenge=challenge-abc");
    expect(url).toContain("code_challenge_method=S256");
  });
});

// ---------------------------------------------------------------------------
//  verifyCallback
// ---------------------------------------------------------------------------

describe("TwitterVerifier.verifyCallback", () => {
  const verifier = new TwitterVerifier("tw-client", "tw-secret", "https://example.com/tw-cb");

  it("verifies matching username successfully", async () => {
    mockExchange.mockResolvedValue("access-token-123");
    mockProfile.mockResolvedValue({
      id: "99",
      username: "twitteruser",
      name: "Twitter User",
      followersCount: 200,
    });

    const result = await verifier.verifyCallback("code", "verifier", "twitteruser");

    expect(result.verified).toBe(true);
    expect(result.username).toBe("twitteruser");
    expect(result.displayName).toBe("Twitter User");
    expect(result.followersCount).toBe(200);

    // Verify exchangeTwitterCode was called with correct args
    expect(mockExchange).toHaveBeenCalledWith(
      "tw-client",
      "tw-secret",
      "code",
      "verifier",
      "https://example.com/tw-cb",
    );
    expect(mockProfile).toHaveBeenCalledWith("access-token-123");
  });

  it("matches username case-insensitively", async () => {
    mockExchange.mockResolvedValue("tok");
    mockProfile.mockResolvedValue({
      id: "1",
      username: "TwitterUser",
      name: "TU",
      followersCount: 0,
    });

    const result = await verifier.verifyCallback("code", "verifier", "twitteruser");
    expect(result.verified).toBe(true);
    expect(result.username).toBe("TwitterUser");
  });

  it("rejects username mismatch", async () => {
    mockExchange.mockResolvedValue("tok");
    mockProfile.mockResolvedValue({
      id: "1",
      username: "realhandle",
      name: "Real",
      followersCount: 50,
    });

    const result = await verifier.verifyCallback("code", "verifier", "claimedhandle");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("mismatch");
    expect(result.error).toContain("claimedhandle");
    expect(result.error).toContain("realhandle");
  });

  it("returns error when token exchange fails", async () => {
    mockExchange.mockRejectedValue(new Error("Code expired"));

    const result = await verifier.verifyCallback("bad-code", "verifier", "user");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Code expired");
  });

  it("returns error when profile fetch fails", async () => {
    mockExchange.mockResolvedValue("tok");
    mockProfile.mockRejectedValue(new Error("Twitter API error: 429 Too Many Requests"));

    const result = await verifier.verifyCallback("code", "verifier", "user");

    expect(result.verified).toBe(false);
    expect(result.error).toContain("429");
  });

  it("returns error on unexpected error type", async () => {
    mockExchange.mockRejectedValue("string error");

    const result = await verifier.verifyCallback("code", "verifier", "user");

    expect(result.verified).toBe(false);
    expect(result.error).toBe("string error");
  });
});
