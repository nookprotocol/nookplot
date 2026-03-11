import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createCommunitiesRouter } from "./communities.js";
import { createMockPool, createTestApp, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auth.js", () => ({
  createAuthMiddleware: () => (_req: any, _res: any, next: any) => {
    _req.agent = { id: "agt_test", did_cid: "bafytest" };
    next();
  },
  registeredMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/validation.js", () => ({
  validateCommunityBody: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../sdkFactory.js", () => ({
  getReadOnlySDK: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  Communities routes — POST returns 410 Gone
// ---------------------------------------------------------------------------

describe("Communities routes — 410 Gone", () => {
  function createApp() {
    const pool = createMockPool();
    const router = createCommunitiesRouter(pool as any, {} as any, TEST_HMAC_SECRET);
    return createTestApp(router);
  }

  it("POST /v1/communities returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/communities").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/community");
    expect(res.body.relayEndpoint).toContain("/v1/relay");
  });
});
