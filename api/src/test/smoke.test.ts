import { describe, it, expect } from "vitest";
import { Router } from "express";
import request from "supertest";
import { createTestApp } from "./helpers.js";

describe("test infrastructure", () => {
  it("vitest framework works", () => {
    expect(1 + 1).toBe(2);
  });

  it("supertest can make requests to a mounted router", async () => {
    const router = Router();
    router.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    const app = createTestApp(router);
    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("unmounted routes return 404", async () => {
    const router = Router();
    const app = createTestApp(router);

    const res = await request(app).get("/api/v1/nonexistent");
    expect(res.status).toBe(404);
  });
});
