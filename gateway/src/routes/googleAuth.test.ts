import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createGoogleAuthRouter } from "./googleAuth.js";
import { createTestApp, createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const GOOGLE_CONFIG = {
  googleClientId: "test_google_client_id",
  googleAuthJwtSecret: "test_google_jwt_secret",
};

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createGoogleAuthRouter(pool as any, GOOGLE_CONFIG);
  return { app: createTestApp(router) };
}

// ---------------------------------------------------------------------------
//  POST /v1/auth/google
// ---------------------------------------------------------------------------

describe("POST /v1/auth/google", () => {
  it("authenticates with valid Google token", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sub: "google_123",
        email: "test@example.com",
        name: "Test User",
        picture: "https://lh3.googleusercontent.com/test",
      }),
    });

    // Upsert web_users
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "user_1", google_id: "google_123", email: "test@example.com",
        name: "Test User", picture: "https://lh3.googleusercontent.com/test",
        wallet_address: null,
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/auth/google")
      .send({ credential: "valid_google_token" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe("test@example.com");
    expect(res.body.user.name).toBe("Test User");
  });

  it("rejects missing credential", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/auth/google")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("credential");
  });

  it("returns 401 for invalid Google token", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const res = await request(app)
      .post("/v1/auth/google")
      .send({ credential: "bad_token" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid Google token");
  });

  it("returns 401 when userinfo has no sub", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ email: "test@test.com" }), // no sub
    });

    const res = await request(app)
      .post("/v1/auth/google")
      .send({ credential: "token_without_sub" });

    expect(res.status).toBe(401);
  });

  it("returns 401 on fetch error", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const res = await request(app)
      .post("/v1/auth/google")
      .send({ credential: "some_token" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Google authentication failed");
  });
});
