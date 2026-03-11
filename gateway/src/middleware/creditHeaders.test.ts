import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { creditHeadersMiddleware, setCreditCharge } from "./creditHeaders.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(creditHeadersMiddleware());

  // Route that sets credit charge
  app.get("/charged", (_req, res) => {
    setCreditCharge(res, 25, 975);
    res.json({ ok: true });
  });

  // Route with only remaining (set by auth middleware typically)
  app.get("/remaining-only", (_req, res) => {
    res.locals.creditsRemaining = 500;
    res.json({ ok: true });
  });

  // Route with no credit info
  app.get("/no-credits", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
//  creditHeadersMiddleware
// ---------------------------------------------------------------------------

describe("creditHeadersMiddleware", () => {
  it("injects both headers when setCreditCharge is called", async () => {
    const app = buildApp();
    const res = await request(app).get("/charged");

    expect(res.status).toBe(200);
    expect(res.headers["x-nookplot-credits-remaining"]).toBe("975");
    expect(res.headers["x-nookplot-credits-charged"]).toBe("25");
    expect(res.body.ok).toBe(true);
  });

  it("injects only remaining header when only creditsRemaining is set", async () => {
    const app = buildApp();
    const res = await request(app).get("/remaining-only");

    expect(res.status).toBe(200);
    expect(res.headers["x-nookplot-credits-remaining"]).toBe("500");
    expect(res.headers["x-nookplot-credits-charged"]).toBeUndefined();
  });

  it("injects no credit headers when res.locals is empty", async () => {
    const app = buildApp();
    const res = await request(app).get("/no-credits");

    expect(res.status).toBe(200);
    expect(res.headers["x-nookplot-credits-remaining"]).toBeUndefined();
    expect(res.headers["x-nookplot-credits-charged"]).toBeUndefined();
  });

  it("passes through response body unchanged", async () => {
    const app = buildApp();
    const res = await request(app).get("/charged");
    expect(res.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
//  setCreditCharge helper
// ---------------------------------------------------------------------------

describe("setCreditCharge", () => {
  it("sets both res.locals values", () => {
    const res = { locals: {} } as express.Response;
    setCreditCharge(res, 50, 450);

    expect(res.locals.creditsCharged).toBe(50);
    expect(res.locals.creditsRemaining).toBe(450);
  });

  it("handles zero values", () => {
    const res = { locals: {} } as express.Response;
    setCreditCharge(res, 0, 0);

    expect(res.locals.creditsCharged).toBe(0);
    expect(res.locals.creditsRemaining).toBe(0);
  });
});
