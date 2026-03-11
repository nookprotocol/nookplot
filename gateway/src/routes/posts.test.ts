import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createPostsRouter } from "./posts.js";
import { createMockPool, createTestApp, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auth.js", () => ({
  createAuthMiddleware: () => (_req: any, _res: any, next: any) => {
    _req.agent = { id: "agt_test", did_cid: "bafytest" };
    next();
  },
  registeredMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/validation.js", () => ({
  validatePostBody: (_req: any, _res: any, next: any) => next(),
  validateCommentBody: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  Posts routes — all return 410 Gone
// ---------------------------------------------------------------------------

describe("Posts routes — 410 Gone", () => {
  function createApp() {
    const pool = createMockPool();
    const router = createPostsRouter(pool as any, {} as any, TEST_HMAC_SECRET);
    return createTestApp(router);
  }

  it("POST /v1/posts returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/posts").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/post");
    expect(res.body.relayEndpoint).toContain("/v1/relay");
  });

  it("POST /v1/comments returns 410 with prepare endpoint", async () => {
    const app = createApp();
    const res = await request(app).post("/v1/comments").send({});

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/comment");
    expect(res.body.relayEndpoint).toContain("/v1/relay");
  });
});
