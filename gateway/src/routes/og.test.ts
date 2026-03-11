import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createMockPool } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  Mocks — must come before importing the router
// ---------------------------------------------------------------------------

// Mock satori — returns minimal SVG string
vi.mock("satori", () => ({
  default: vi.fn().mockResolvedValue(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect fill="#08080f" width="1200" height="630"/></svg>',
  ),
}));

// Mock @resvg/resvg-js — returns a fake PNG buffer
const FAKE_PNG = Buffer.from("fake-png-data");
vi.mock("@resvg/resvg-js", () => ({
  Resvg: vi.fn().mockImplementation(() => ({
    render: () => ({
      asPng: () => new Uint8Array(FAKE_PNG),
    }),
  })),
}));

// Mock fs.readFileSync for font loading
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-font-data")),
    },
    readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-font-data")),
  };
});

// Mock audit log
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Now import the router
import { createOgRouter } from "./og.js";

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

const TEST_ADDRESS = "0x1234567890123456789012345678901234567890";

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const app = express();
  app.use("/og", createOgRouter(pool as any));
  return app;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("OG image routes", () => {
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
  });

  // ── Agent card ──────────────────────────────────────────────────

  describe("GET /og/agent/:address", () => {
    it("returns PNG for a known agent", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_type: "autonomous", post_count: 5, follower_count: 12 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ display_name: "TestAgent" }], rowCount: 1 });

      const app = buildApp(pool);
      const res = await request(app).get(`/og/agent/${TEST_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["cache-control"]).toContain("public");
      expect(res.headers["cache-control"]).toContain("s-maxage=86400");
    });

    it("302 redirects to fallback for unknown agent", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(pool);
      const res = await request(app).get(`/og/agent/${TEST_ADDRESS}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/nookplot.png");
    });

    it("serves cached PNG on second request", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_type: "autonomous", post_count: 5, follower_count: 12 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ display_name: "TestAgent" }], rowCount: 1 });

      const app = buildApp(pool);

      // First request — cache miss
      await request(app).get(`/og/agent/${TEST_ADDRESS}`);

      // Second request — should be cached (no additional DB queries)
      const res = await request(app).get(`/og/agent/${TEST_ADDRESS}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");

      // pool.query should only have been called twice (for the first request)
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  // ── Post card ───────────────────────────────────────────────────

  describe("GET /og/post/:cid", () => {
    it("returns PNG for a known post", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ author: TEST_ADDRESS, community_id: "test-com", upvotes: 10, downvotes: 2 }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ display_name: "PostAuthor" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ name: "TestCommunity" }], rowCount: 1 });

      // Mock global fetch for IPFS
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

      const app = buildApp(pool);
      const res = await request(app).get("/og/post/QmTestCid123");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");

      globalThis.fetch = originalFetch;
    });

    it("302 redirects for unknown post", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/post/QmUnknown");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/nookplot.png");
    });
  });

  // ── Community card ──────────────────────────────────────────────

  describe("GET /og/community/:id", () => {
    it("returns PNG for a known community", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ name: "TestCommunity", total_posts: 42 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ cnt: 7 }], rowCount: 1 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/community/test-community");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
    });

    it("302 redirects for unknown community", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/community/unknown");

      expect(res.status).toBe(302);
    });
  });

  // ── Bounty card ─────────────────────────────────────────────────

  describe("GET /og/bounty/:id", () => {
    it("returns PNG for a known bounty", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ title: "Fix the bug", reward_amount: "10 USDC", status: "open" }],
        rowCount: 1,
      });

      const app = buildApp(pool);
      const res = await request(app).get("/og/bounty/1");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
    });

    it("falls back to idx_bounties when bounties table miss", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // bounties table miss
        .mockResolvedValueOnce({ rows: [{ metadata_cid: "QmTest", reward: "5 USDC", is_active: true }], rowCount: 1 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/bounty/1");

      expect(res.status).toBe(200);
    });

    it("302 redirects when bounty not found anywhere", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/bounty/999");

      expect(res.status).toBe(302);
    });
  });

  // ── Project card ────────────────────────────────────────────────

  describe("GET /og/project/:id", () => {
    it("returns PNG for a known project", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ name: "My Project", description: "A cool project", languages: ["TypeScript", "Rust"] }],
        rowCount: 1,
      });

      const app = buildApp(pool);
      const res = await request(app).get("/og/project/proj_abc123");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
    });

    it("302 redirects for unknown project", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/project/unknown");

      expect(res.status).toBe(302);
    });
  });

  // ── Guild card ──────────────────────────────────────────────────

  describe("GET /og/guild/:id", () => {
    it("returns PNG for a known guild", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ name: "AI Builders", member_count: 15, status: "active" }],
        rowCount: 1,
      });

      const app = buildApp(pool);
      const res = await request(app).get("/og/guild/1");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
    });

    it("302 redirects for unknown guild", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const app = buildApp(pool);
      const res = await request(app).get("/og/guild/999");

      expect(res.status).toBe(302);
    });
  });

  // ── Error handling ──────────────────────────────────────────────

  describe("error handling", () => {
    it("302 redirects when DB throws", async () => {
      pool.query.mockRejectedValue(new Error("DB connection failed"));

      const app = buildApp(pool);
      const res = await request(app).get(`/og/agent/${TEST_ADDRESS}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/nookplot.png");
    });
  });
});
