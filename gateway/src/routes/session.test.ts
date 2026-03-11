import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import cookieParser from "cookie-parser";
import express from "express";
import { hashApiKey } from "../auth.js";
import { createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

// Suppress audit log
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

import { createSessionRouter, SESSION_COOKIE_NAME } from "./session.js";

const TEST_API_KEY = "nk_" + "a".repeat(64);
const AGENT = createMockAgent({
  api_key_hash: hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET),
  api_key_prefix: "nk_…aaaa",
  display_name: "TestAgent",
});

function createApp(pool: ReturnType<typeof createMockPool>) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/v1", createSessionRouter(pool as any, TEST_HMAC_SECRET));
  return app;
}

describe("POST /v1/auth/session", () => {
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("returns 400 when apiKey is missing", async () => {
    const app = createApp(pool);
    const res = await request(app).post("/v1/auth/session").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing apiKey/);
  });

  it("returns 400 for invalid key format", async () => {
    const app = createApp(pool);
    const res = await request(app)
      .post("/v1/auth/session")
      .send({ apiKey: "bad_key" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid API key format/);
  });

  it("returns 401 for unknown key", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = createApp(pool);
    const res = await request(app)
      .post("/v1/auth/session")
      .send({ apiKey: TEST_API_KEY });
    expect(res.status).toBe(401);
  });

  it("sets HttpOnly cookie and returns metadata for valid key", async () => {
    pool.query.mockResolvedValueOnce({ rows: [AGENT] });
    const app = createApp(pool);
    const res = await request(app)
      .post("/v1/auth/session")
      .send({ apiKey: TEST_API_KEY });
    expect(res.status).toBe(200);

    // Body contains non-sensitive metadata
    expect(res.body.agentId).toBe(AGENT.id);
    expect(res.body.address).toBe(AGENT.address);
    expect(res.body.displayName).toBe(AGENT.display_name);
    expect(res.body.apiKeyPrefix).toBe(AGENT.api_key_prefix);

    // Cookie is set
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const sessionCookie = (Array.isArray(cookies) ? cookies : [cookies]).find(
      (c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Path=/");
  });
});

describe("POST /v1/auth/logout", () => {
  it("clears the session cookie", async () => {
    const pool = createMockPool();
    const app = createApp(pool);
    const res = await request(app).post("/v1/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    // Cookie should be cleared (set to empty or expired)
    const sessionCookie = (Array.isArray(cookies) ? cookies : [cookies]).find(
      (c: string) => c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(sessionCookie).toBeDefined();
  });
});

describe("GET /v1/auth/check", () => {
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("returns authenticated: false when no cookie", async () => {
    const app = createApp(pool);
    const res = await request(app).get("/v1/auth/check");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it("returns authenticated: true with valid cookie", async () => {
    pool.query.mockResolvedValueOnce({ rows: [AGENT] });
    const app = createApp(pool);
    const res = await request(app)
      .get("/v1/auth/check")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${TEST_API_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.agent.agentId).toBe(AGENT.id);
  });

  it("returns authenticated: false with invalid cookie", async () => {
    const app = createApp(pool);
    const res = await request(app)
      .get("/v1/auth/check")
      .set("Cookie", `${SESSION_COOKIE_NAME}=bad_value`);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });
});
