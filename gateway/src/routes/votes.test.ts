import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createVotesRouter } from "./votes.js";
import { createMockPool, createTestApp, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auth.js", () => ({
  createAuthMiddleware: () => (_req: any, _res: any, next: any) => {
    _req.agent = { id: "agt_test", did_cid: "bafytest" };
    next();
  },
  registeredMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/validation.js", () => ({
  validateVoteBody: (_req: any, _res: any, next: any) => next(),
  validateCidParam: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  Votes routes — all return 410 Gone
// ---------------------------------------------------------------------------

describe("Votes routes — 410 Gone", () => {
  function createApp() {
    const pool = createMockPool();
    const router = createVotesRouter(pool as any, {} as any, TEST_HMAC_SECRET);
    return createTestApp(router);
  }

  it("POST /v1/votes returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/votes").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/vote");
    expect(res.body.relayEndpoint).toContain("/v1/relay");
  });

  it("DELETE /v1/votes/:cid returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).delete("/v1/votes/QmtestCid");

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/vote/remove");
    expect(res.body.relayEndpoint).toContain("/v1/relay");
  });
});
