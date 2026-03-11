import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exchangeTwitterCode, fetchTwitterProfile } from "./twitterApi.js";

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
//  exchangeTwitterCode
// ---------------------------------------------------------------------------

describe("exchangeTwitterCode", () => {
  it("exchanges code for access token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "twitter_token_123" }),
    });

    const token = await exchangeTwitterCode(
      "client-id",
      "client-secret",
      "auth-code",
      "code-verifier",
      "https://example.com/callback",
    );

    expect(token).toBe("twitter_token_123");
  });

  it("sends correct Authorization header (Basic auth)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "tok" }),
    });

    await exchangeTwitterCode("myid", "mysecret", "code", "verifier", "https://cb.com");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.twitter.com/2/oauth2/token");
    const opts = call[1];
    const expectedAuth = Buffer.from("myid:mysecret").toString("base64");
    expect(opts.headers["Authorization"]).toBe(`Basic ${expectedAuth}`);
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("throws when no access_token returned", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ error: "invalid_grant", error_description: "Code expired" }),
    });

    await expect(
      exchangeTwitterCode("id", "secret", "bad-code", "verifier", "https://cb.com"),
    ).rejects.toThrow("Code expired");
  });

  it("uses error field when no error_description", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: "invalid_request" }),
    });

    await expect(
      exchangeTwitterCode("id", "secret", "code", "verifier", "https://cb.com"),
    ).rejects.toThrow("invalid_request");
  });

  it("uses fallback message when no error fields", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await expect(
      exchangeTwitterCode("id", "secret", "code", "verifier", "https://cb.com"),
    ).rejects.toThrow("Failed to get Twitter access token");
  });
});

// ---------------------------------------------------------------------------
//  fetchTwitterProfile
// ---------------------------------------------------------------------------

describe("fetchTwitterProfile", () => {
  it("fetches and maps Twitter profile correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            id: "12345",
            username: "twitteruser",
            name: "Twitter User",
            profile_image_url: "https://pbs.twimg.com/photo.jpg",
            public_metrics: { followers_count: 500 },
          },
        }),
    });

    const profile = await fetchTwitterProfile("bearer-token");

    expect(profile.id).toBe("12345");
    expect(profile.username).toBe("twitteruser");
    expect(profile.name).toBe("Twitter User");
    expect(profile.profileImageUrl).toBe("https://pbs.twimg.com/photo.jpg");
    expect(profile.followersCount).toBe(500);
  });

  it("sends correct Authorization header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            id: "1",
            username: "u",
            name: "n",
            public_metrics: { followers_count: 0 },
          },
        }),
    });

    await fetchTwitterProfile("my-access-token");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers["Authorization"]).toBe("Bearer my-access-token");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(fetchTwitterProfile("bad-token")).rejects.toThrow(
      "Twitter API error: 401 Unauthorized",
    );
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    await expect(fetchTwitterProfile("token")).rejects.toThrow("Connection refused");
  });
});
