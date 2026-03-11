import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  createIpRateLimiter,
  createRegistrationRateLimiter,
  createKeyRateLimiter,
  createReadKeyRateLimiter,
  createSubgraphIpRateLimiter,
  createAuthIpRateLimiter,
  createMethodAwareRateLimiter,
} from "./rateLimit.js";

// ---------------------------------------------------------------------------
//  createIpRateLimiter
// ---------------------------------------------------------------------------

describe("createIpRateLimiter", () => {
  it("allows requests under the limit", async () => {
    const app = express();
    app.use(createIpRateLimiter(60_000, 5));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
  });

  it("blocks after exceeding limit", async () => {
    const app = express();
    app.use(createIpRateLimiter(60_000, 2));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app).get("/test");
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error).toContain("Too many requests");
  });

  it("skips authenticated requests (Bearer)", async () => {
    const app = express();
    app.use(createIpRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // First unauthenticated request uses up the limit
    await request(app).get("/test");
    // Authenticated request should be skipped
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer some-key");
    expect(res.status).toBe(200);
  });

  it("does not expose rate limit headers for unauthenticated endpoints", async () => {
    const app = express();
    app.use(createIpRateLimiter(60_000, 10));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    const hasRateLimitHeader = Object.keys(res.headers).some((h) =>
      h.toLowerCase().includes("ratelimit"),
    );
    expect(hasRateLimitHeader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  createRegistrationRateLimiter
// ---------------------------------------------------------------------------

describe("createRegistrationRateLimiter", () => {
  it("allows registrations under the limit", async () => {
    const app = express();
    app.use(createRegistrationRateLimiter(600_000, 2));
    app.post("/register", (_req, res) => res.json({ ok: true }));

    const res = await request(app).post("/register");
    expect(res.status).toBe(200);
  });

  it("blocks after exceeding limit", async () => {
    const app = express();
    app.use(createRegistrationRateLimiter(600_000, 1));
    app.post("/register", (_req, res) => res.json({ ok: true }));

    await request(app).post("/register");
    const res = await request(app).post("/register");
    expect(res.status).toBe(429);
    expect(res.body.error).toContain("registrations");
  });
});

// ---------------------------------------------------------------------------
//  createKeyRateLimiter
// ---------------------------------------------------------------------------

describe("createKeyRateLimiter", () => {
  it("rate limits by agent API key prefix", async () => {
    const app = express();
    // Agent middleware must run BEFORE rate limiter (same as production: auth → rate limit)
    app.use((req: any, _res, next) => {
      req.agent = { api_key_prefix: "np_…test" };
      next();
    });
    app.use(createKeyRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });

  it("falls back to IP when no agent", async () => {
    const app = express();
    // No agent: unauthenticated requests get 3x headroom (maxPerKey * 3)
    app.use(createKeyRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // maxPerKey=1 → unauthenticated max=3, so 4th request triggers 429
    await request(app).get("/test");
    await request(app).get("/test");
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
//  createReadKeyRateLimiter
// ---------------------------------------------------------------------------

describe("createReadKeyRateLimiter", () => {
  it("uses read: prefix for key generation", async () => {
    const app = express();
    // Agent middleware must run BEFORE rate limiters (same as production)
    app.use((req: any, _res, next) => {
      req.agent = { api_key_prefix: "np_…test2" };
      next();
    });
    // Create both a read limiter and a key limiter with limit=1
    app.use(createKeyRateLimiter(60_000, 1));
    app.use(createReadKeyRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // First request consumes both key and read budgets
    await request(app).get("/test");
    // Second request — both limits are exhausted
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
//  createSubgraphIpRateLimiter
// ---------------------------------------------------------------------------

describe("createSubgraphIpRateLimiter", () => {
  it("uses subgraph-ip: prefix", async () => {
    const app = express();
    app.use(createSubgraphIpRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error).toContain("Too many requests");
  });
});

// ---------------------------------------------------------------------------
//  createAuthIpRateLimiter
// ---------------------------------------------------------------------------

describe("createAuthIpRateLimiter", () => {
  it("skips unauthenticated requests", async () => {
    const app = express();
    app.use(createAuthIpRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    // Should be skipped (no Bearer), so limit doesn't apply
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
  });

  it("rate limits authenticated requests", async () => {
    const app = express();
    app.use(createAuthIpRateLimiter(60_000, 1));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    await request(app)
      .get("/test")
      .set("Authorization", "Bearer key1");
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer key2");
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
//  createMethodAwareRateLimiter
// ---------------------------------------------------------------------------

describe("createMethodAwareRateLimiter", () => {
  it("routes GET to read limiter", async () => {
    const app = express();
    const readLimiter = createIpRateLimiter(60_000, 1);
    const writeLimiter = createIpRateLimiter(60_000, 100);
    app.use(createMethodAwareRateLimiter(readLimiter, writeLimiter));
    app.get("/test", (_req, res) => res.json({ ok: true }));
    app.post("/test", (_req, res) => res.json({ ok: true }));

    // Read budget of 1
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });

  it("routes POST to write limiter", async () => {
    const app = express();
    const readLimiter = createIpRateLimiter(60_000, 100);
    const writeLimiter = createIpRateLimiter(60_000, 1);
    app.use(express.json());
    app.use(createMethodAwareRateLimiter(readLimiter, writeLimiter));
    app.post("/test", (_req, res) => res.json({ ok: true }));

    await request(app).post("/test").send({});
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(429);
  });

  it("separates read and write budgets", async () => {
    const app = express();
    const readLimiter = createIpRateLimiter(60_000, 1);
    const writeLimiter = createIpRateLimiter(60_000, 1);
    app.use(express.json());
    app.use(createMethodAwareRateLimiter(readLimiter, writeLimiter));
    app.get("/test", (_req, res) => res.json({ ok: true }));
    app.post("/test", (_req, res) => res.json({ ok: true }));

    // One GET and one POST should each succeed (separate budgets)
    const getRes = await request(app).get("/test");
    const postRes = await request(app).post("/test").send({});
    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
  });
});
