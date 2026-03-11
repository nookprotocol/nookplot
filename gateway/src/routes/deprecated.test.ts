import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createVotesRouter } from "./votes.js";
import { createPostsRouter } from "./posts.js";
import { createSocialRouter } from "./social.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ethers mock for validation middleware
vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({
  id: "agt_deprecated_test",
  api_key_hash: TEST_KEY_HASH,
  did_cid: "bafytest",
});

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  // Auth middleware: agent lookup + credit balance pre-fetch
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

const SDK_CONFIG = {
  rpcUrl: "https://mainnet.base.org",
  contracts: {},
};

// ---------------------------------------------------------------------------
//  Votes — 410 Gone
// ---------------------------------------------------------------------------

describe("Votes — 410 Gone", () => {
  it("POST /v1/votes returns 410 with prepare+relay instructions", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createVotesRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .post("/v1/votes")
      .set(authHeader())
      .send({ cid: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenosa7776", type: "up" });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/vote");
    expect(res.body.relayEndpoint).toContain("relay");
  });

  it("DELETE /v1/votes/:cid returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createVotesRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const cid = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenosa7776";

    const res = await request(app)
      .delete(`/v1/votes/${cid}`)
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("vote/remove");
  });
});

// ---------------------------------------------------------------------------
//  Posts — 410 Gone
// ---------------------------------------------------------------------------

describe("Posts — 410 Gone", () => {
  it("POST /v1/posts returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createPostsRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .post("/v1/posts")
      .set(authHeader())
      .send({
        title: "Hello",
        body: "World",
        community: "test-community",
      });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/post");
  });

  it("POST /v1/comments returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createPostsRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .post("/v1/comments")
      .set(authHeader())
      .send({
        parentCid: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenosa7776",
        body: "Nice post",
        community: "test-community",
      });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/comment");
  });
});

// ---------------------------------------------------------------------------
//  Social — 410 Gone
// ---------------------------------------------------------------------------

describe("Social — 410 Gone", () => {
  it("POST /v1/follows returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createSocialRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .post("/v1/follows")
      .set(authHeader())
      .send({ target: "0x1111111111111111111111111111111111111111" });

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/follow");
  });

  it("DELETE /v1/follows/:target returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createSocialRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .delete("/v1/follows/0x1111111111111111111111111111111111111111")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/unfollow");
  });

  it("POST /v1/attestations returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createSocialRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .post("/v1/attestations")
      .set(authHeader())
      .send({
        target: "0x2222222222222222222222222222222222222222",
        reason: "Good agent",
      });

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/attest");
  });

  it("DELETE /v1/attestations/:target returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createSocialRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .delete("/v1/attestations/0x2222222222222222222222222222222222222222")
      .set(authHeader());

    expect(res.status).toBe(410);
  });

  it("POST /v1/blocks returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createSocialRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .post("/v1/blocks")
      .set(authHeader())
      .send({ target: "0x3333333333333333333333333333333333333333" });

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/block");
  });

  it("DELETE /v1/blocks/:target returns 410", async () => {
    const pool = createMockPool();
    setupAuth(pool);
    const router = createSocialRouter(pool as any, SDK_CONFIG as any, TEST_HMAC_SECRET);
    const app = createTestApp(router);

    const res = await request(app)
      .delete("/v1/blocks/0x3333333333333333333333333333333333333333")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/block");
  });
});
