import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createSocialRouter } from "./social.js";
import { createMockPool, createTestApp, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auth.js", () => ({
  createAuthMiddleware: () => (_req: any, _res: any, next: any) => {
    _req.agent = { id: "agt_test", did_cid: "bafytest" };
    next();
  },
  registeredMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/validation.js", () => ({
  validateTargetBody: (_req: any, _res: any, next: any) => next(),
  validateTargetParam: (_req: any, _res: any, next: any) => next(),
  validateAttestBody: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  Social routes — all return 410 Gone
// ---------------------------------------------------------------------------

describe("Social routes — 410 Gone", () => {
  function createApp() {
    const pool = createMockPool();
    const router = createSocialRouter(pool as any, {} as any, TEST_HMAC_SECRET);
    return createTestApp(router);
  }

  it("POST /v1/follows returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/follows").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/follow");
    expect(res.body.relayEndpoint).toContain("/v1/relay");
  });

  it("DELETE /v1/follows/:target returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).delete("/v1/follows/0x1");

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/unfollow");
  });

  it("POST /v1/attestations returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/attestations").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/attest");
  });

  it("DELETE /v1/attestations/:target returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).delete("/v1/attestations/0x1");

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/attest");
  });

  it("POST /v1/blocks returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/blocks").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/block");
  });

  it("DELETE /v1/blocks/:target returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).delete("/v1/blocks/0x1");

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/block");
  });
});
