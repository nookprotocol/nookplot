import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createTwitterAuthRouter } from "./twitterAuth.js";
import { createTestApp, createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../services/verifiers/twitterApi.js", () => ({
  exchangeTwitterCode: vi.fn().mockResolvedValue("access_token_123"),
  fetchTwitterProfile: vi.fn().mockResolvedValue({
    id: "tw_123",
    username: "testuser",
    name: "Test User",
    followersCount: 500,
    profileImageUrl: "https://pbs.twimg.com/test.jpg",
  }),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TWITTER_CONFIG = {
  clientId: "test_client_id",
  clientSecret: "test_client_secret",
  callbackUrl: "https://gateway.example.com/v1/auth/twitter/callback",
  jwtSecret: "test_jwt_secret_for_twitter",
  frontendUrl: "https://example.com",
};

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createTwitterAuthRouter(pool as any, TWITTER_CONFIG);
  return { app: createTestApp(router) };
}

// ---------------------------------------------------------------------------
//  GET /v1/auth/twitter — Initiate OAuth
// ---------------------------------------------------------------------------

describe("GET /v1/auth/twitter", () => {
  it("redirects to Twitter OAuth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Insert session query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .get("/v1/auth/twitter")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("twitter.com/i/oauth2/authorize");
    expect(res.headers.location).toContain("client_id=test_client_id");
    expect(res.headers.location).toContain("code_challenge_method=S256");
  });

  it("redirects to frontend on error", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockRejectedValueOnce(new Error("DB fail"));

    const res = await request(app)
      .get("/v1/auth/twitter")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=init_failed");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/auth/twitter/callback — Handle redirect
// ---------------------------------------------------------------------------

describe("GET /v1/auth/twitter/callback", () => {
  it("exchanges code and redirects with token", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Delete session (returns code_verifier)
    pool.query.mockResolvedValueOnce({
      rows: [{ code_verifier: "test_verifier", expires_at: new Date(Date.now() + 600000) }],
      rowCount: 1,
    });
    // Upsert web_users
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "user_1", twitter_id: "tw_123", twitter_username: "testuser", name: "Test User", picture: null, wallet_address: null, linked_agent_id: null }],
      rowCount: 1,
    });
    // Auto-create external claim
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .get("/v1/auth/twitter/callback?code=oauth_code&state=valid_state")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("auth/callback#token=");
    expect(res.headers.location).toContain("provider=twitter");
  });

  it("redirects with error when access denied", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .get("/v1/auth/twitter/callback?error=access_denied")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=access_denied");
  });

  it("redirects with error when missing params", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .get("/v1/auth/twitter/callback")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=missing_params");
  });

  it("redirects with error for invalid state", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // No session found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/v1/auth/twitter/callback?code=abc&state=bad_state")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=invalid_state");
  });

  it("redirects with error for expired session", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Expired session
    pool.query.mockResolvedValueOnce({
      rows: [{ code_verifier: "test_verifier", expires_at: new Date(Date.now() - 60000) }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/auth/twitter/callback?code=abc&state=expired_state")
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=session_expired");
  });
});
