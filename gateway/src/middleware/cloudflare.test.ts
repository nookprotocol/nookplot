import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createCloudflareMiddleware } from "./cloudflare.js";

// Suppress audit log calls
vi.mock("./auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const SECRET = "my-cloudflare-secret-value";

function buildApp() {
  const app = express();
  app.use(createCloudflareMiddleware(SECRET));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/v1/stats", (_req, res) => res.json({ stats: true }));
  app.get("/v1/credits/packs", (_req, res) => res.json({ packs: [] }));
  app.get("/v1/activity", (_req, res) => res.json({ activity: true }));
  app.get("/v1/agents/me", (_req, res) => res.json({ me: true }));
  app.get("/v1/projects/proj-123", (_req, res) => res.json({ project: true }));
  app.get("/v1/channels/by-source/foo", (_req, res) => res.json({ channel: true }));
  app.post("/v1/projects/proj-123", (_req, res) => res.json({ updated: true }));
  app.get("/v1/some-protected", (_req, res) => res.json({ protected: true }));
  app.post("/v1/some-protected", (_req, res) => res.json({ created: true }));
  return app;
}

// ---------------------------------------------------------------------------
//  Bypass paths (exact match)
// ---------------------------------------------------------------------------

describe("Cloudflare middleware — bypass paths", () => {
  it("allows /health without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows /v1/stats without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/stats");
    expect(res.status).toBe(200);
  });

  it("allows /v1/credits/packs without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/credits/packs");
    expect(res.status).toBe(200);
  });

  it("allows /v1/activity without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/activity");
    expect(res.status).toBe(200);
  });

  it("allows /v1/agents/me without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/agents/me");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  Bypass prefixes (GET only)
// ---------------------------------------------------------------------------

describe("Cloudflare middleware — bypass prefixes (GET only)", () => {
  it("allows GET /v1/projects/:id without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/projects/proj-123");
    expect(res.status).toBe(200);
  });

  it("allows GET /v1/channels/by-source/:id without secret", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/channels/by-source/foo");
    expect(res.status).toBe(200);
  });

  it("blocks POST to prefix path without secret", async () => {
    const app = buildApp();
    const res = await request(app).post("/v1/projects/proj-123");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
//  Bearer token bypass
// ---------------------------------------------------------------------------

describe("Cloudflare middleware — Bearer bypass", () => {
  it("allows requests with Bearer token on non-bypass paths", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/v1/some-protected")
      .set("Authorization", "Bearer some-api-key");
    expect(res.status).toBe(200);
    expect(res.body.protected).toBe(true);
  });

  it("does not bypass with non-Bearer auth header", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/v1/some-protected")
      .set("Authorization", "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  Cloudflare secret header
// ---------------------------------------------------------------------------

describe("Cloudflare middleware — secret header", () => {
  it("allows requests with correct X-Cloudflare-Secret", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/v1/some-protected")
      .set("X-Cloudflare-Secret", SECRET);
    expect(res.status).toBe(200);
  });

  it("blocks requests with wrong secret", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/v1/some-protected")
      .set("X-Cloudflare-Secret", "wrong-secret");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("blocks requests with no secret on protected paths", async () => {
    const app = buildApp();
    const res = await request(app).get("/v1/some-protected");
    expect(res.status).toBe(403);
  });

  it("blocks requests with secret of different length (timing-safe)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/v1/some-protected")
      .set("X-Cloudflare-Secret", "short");
    expect(res.status).toBe(403);
  });

  it("blocks POST without secret or Bearer", async () => {
    const app = buildApp();
    const res = await request(app).post("/v1/some-protected");
    expect(res.status).toBe(403);
  });
});
