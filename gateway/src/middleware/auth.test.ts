import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "./auth.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";
import type { AuthenticatedRequest } from "../types.js";

// Suppress audit log calls
vi.mock("./auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Valid API key: nk_ + 64 base64url chars = 67 chars total
const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);

// ---------------------------------------------------------------------------
//  createAuthMiddleware
// ---------------------------------------------------------------------------

describe("createAuthMiddleware", () => {
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
  });

  function buildApp(mockPool: ReturnType<typeof createMockPool>) {
    const router = Router();
    const auth = createAuthMiddleware(mockPool as any, TEST_HMAC_SECRET);
    router.get("/test", auth, (req, res) => {
      const aReq = req as AuthenticatedRequest;
      res.json({ agentId: aReq.agent!.id });
    });
    return createTestApp(router);
  }

  it("rejects requests with no Authorization header", async () => {
    const app = buildApp(pool);
    const res = await request(app).get("/v1/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.message).toContain("Missing or invalid Authorization header");
  });

  it("rejects requests with non-Bearer auth", async () => {
    const app = buildApp(pool);
    const res = await request(app).get("/v1/test").set("Authorization", "Basic abc123");
    expect(res.status).toBe(401);
  });

  it("rejects invalid bearer token when Privy is not configured", async () => {
    const app = buildApp(pool);
    // With Privy support, non-nk_ tokens are potential Privy tokens;
    // nk_ tokens with wrong length also fail isValidApiKeyFormat → treated as Privy.
    // Without a Privy client, all invalid bearers get the generic rejection.
    const res = await request(app).get("/v1/test").set("Authorization", "Bearer bad-key");
    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Missing or invalid Authorization header");
  });

  it("rejects API key not found in database", async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const app = buildApp(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid or revoked API key.");
  });

  it("authenticates valid API key and attaches agent to request", async () => {
    const agent = createMockAgent({ id: "agt_auth_test" });

    // First query: agent lookup
    pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
    // Second query: credit balance pre-fetch
    pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "500" }], rowCount: 1 });

    const app = buildApp(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe("agt_auth_test");

    // Verify the hash was computed and queried
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE api_key_hash = $1"),
      [TEST_KEY_HASH],
    );
  });

  it("continues even if credit pre-fetch fails", async () => {
    const agent = createMockAgent();

    pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
    pool.query.mockRejectedValueOnce(new Error("credit lookup failure"));

    const app = buildApp(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
  });

  it("returns 500 on database error during agent lookup", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection refused"));

    const app = buildApp(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });

  // ── Cookie fallback ──

  function buildAppWithCookies(mockPool: ReturnType<typeof createMockPool>) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const router = Router();
    const auth = createAuthMiddleware(mockPool as any, TEST_HMAC_SECRET);
    router.get("/test", auth, (req, res) => {
      const aReq = req as AuthenticatedRequest;
      res.json({ agentId: aReq.agent!.id });
    });
    app.use("/v1", router);
    return app;
  }

  it("authenticates via HttpOnly cookie when no Bearer header", async () => {
    const agent = createMockAgent({ id: "agt_cookie_test" });
    pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "100" }], rowCount: 1 });

    const app = buildAppWithCookies(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Cookie", `nk_session=${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe("agt_cookie_test");
  });

  it("prefers Bearer token over cookie when both present", async () => {
    const agent = createMockAgent({ id: "agt_bearer_wins" });
    pool.query.mockResolvedValueOnce({ rows: [agent], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "100" }], rowCount: 1 });

    const app = buildAppWithCookies(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Authorization", `Bearer ${TEST_API_KEY}`)
      .set("Cookie", `nk_session=nk_${"b".repeat(64)}`);

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe("agt_bearer_wins");
    // The query should have been called with the Bearer token's hash, not the cookie's
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE api_key_hash = $1"),
      [TEST_KEY_HASH],
    );
  });

  it("rejects invalid cookie format", async () => {
    const app = buildAppWithCookies(pool);
    const res = await request(app)
      .get("/v1/test")
      .set("Cookie", "nk_session=not_a_valid_key");

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid API key format.");
  });
});

// ---------------------------------------------------------------------------
//  registeredMiddleware
// ---------------------------------------------------------------------------

describe("registeredMiddleware", () => {
  function buildApp(agent: ReturnType<typeof createMockAgent> | undefined) {
    const router = Router();
    router.get("/test", (req, _res, next) => {
      (req as any).agent = agent;
      next();
    }, registeredMiddleware as any, (req, res) => {
      res.json({ ok: true });
    });
    return createTestApp(router);
  }

  it("rejects when req.agent is missing", async () => {
    const app = buildApp(undefined);
    const res = await request(app).get("/v1/test");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Authentication required.");
  });

  it("rejects when agent has no did_cid", async () => {
    const app = buildApp(createMockAgent({ did_cid: null }));
    const res = await request(app).get("/v1/test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Not registered");
  });

  it("passes when agent has did_cid", async () => {
    const app = buildApp(createMockAgent({ did_cid: "bafytest" }));
    const res = await request(app).get("/v1/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  ownerOnlyMiddleware
// ---------------------------------------------------------------------------

describe("ownerOnlyMiddleware", () => {
  function buildApp(agent: ReturnType<typeof createMockAgent> | undefined) {
    const router = Router();
    router.get("/test", (req, _res, next) => {
      (req as any).agent = agent;
      next();
    }, ownerOnlyMiddleware as any, (req, res) => {
      res.json({ ok: true });
    });
    return createTestApp(router);
  }

  it("rejects when req.agent is missing", async () => {
    const app = buildApp(undefined);
    const res = await request(app).get("/v1/test");
    expect(res.status).toBe(401);
  });

  it("passes when no X-Wallet-Address header is present", async () => {
    const app = buildApp(createMockAgent());
    const res = await request(app).get("/v1/test");
    expect(res.status).toBe(200);
  });

  it("passes when wallet matches agent address (case-insensitive)", async () => {
    const agent = createMockAgent({ address: "0xABCD1234567890abcdef1234567890abcdef1234" });
    const app = buildApp(agent);
    const res = await request(app)
      .get("/v1/test")
      .set("X-Wallet-Address", "0xabcd1234567890abcdef1234567890abcdef1234");
    expect(res.status).toBe(200);
  });

  it("rejects when wallet does not match agent address", async () => {
    const agent = createMockAgent({ address: "0x1111111111111111111111111111111111111111" });
    const app = buildApp(agent);
    const res = await request(app)
      .get("/v1/test")
      .set("X-Wallet-Address", "0x2222222222222222222222222222222222222222");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Owner only");
  });
});
