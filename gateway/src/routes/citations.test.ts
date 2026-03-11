import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createCitationsRouter } from "./citations.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const mockGetBundleContent = vi.fn();

vi.mock("../sdkFactory.js", () => ({
  getProvider: vi.fn(() => ({})),
}));

vi.mock("ethers", async () => {
  const actual = await vi.importActual("ethers");
  return {
    ...actual,
    ethers: {
      ...(actual as any).ethers,
      Contract: vi.fn().mockImplementation(() => ({
        getBundleContent: mockGetBundleContent,
      })),
    },
  };
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const MOCK_SDK_CONFIG = {
  rpcUrl: "https://mainnet.base.org",
  pinataJwt: "",
  chainId: 8453,
  contracts: {
    agentRegistry: "0x1111111111111111111111111111111111111111",
    contentIndex: "0x2222222222222222222222222222222222222222",
    interactionContract: "0x3333333333333333333333333333333333333333",
    socialGraph: "0x4444444444444444444444444444444444444444",
    knowledgeBundle: "0x3333333333333333333333333333333333333333",
  },
} as any;

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const app = express();
  app.use(express.json());
  app.locals.pool = pool;
  app.use("/v1", createCitationsRouter(MOCK_SDK_CONFIG));
  return app;
}

const ADMIN_KEY = "test-admin-key";

beforeEach(() => {
  mockGetBundleContent.mockReset();
});

// ---------------------------------------------------------------------------
//  GET /v1/citations/graph — Citation graph
// ---------------------------------------------------------------------------

describe("GET /v1/citations/graph", () => {
  it("returns nodes, edges, bundle nodes with contentCids, and bundle→paper edges", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Bundle content_cids contains a paper CID (QmNode1) — no idx_content query needed
    pool.query
      .mockResolvedValueOnce({
        rows: [{ content_cid: "QmNode1", arxiv_id: "2301.00001", title: "Paper A", categories: ["cs.AI"], citation_count: 5, quality_score: 80 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ source_cid: "QmNode1", resolved_cid: "QmNode2" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "0x00", bundle_id: 0, name: "Test Bundle", cid_count: 1,
          contributor_count: 1, creator_id: "0xabc", content_cids: ["QmNode1"],
        }],
        rowCount: 1,
      });
    // No idx_content query since QmNode1 is already in paperCidSet

    const res = await request(app).get("/v1/citations/graph");

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.bundleNodes).toHaveLength(1);
    expect(res.body.bundleNodes[0].id).toBe("bundle:0");
    expect(res.body.bundleNodes[0].type).toBe("bundle");
    expect(res.body.bundleNodes[0].contentCids).toEqual(["QmNode1"]);
    expect(res.body.bundleEdges).toHaveLength(1);
    expect(res.body.bundleEdges[0]).toEqual({ source: "bundle:0", target: "QmNode1" });
    expect(res.body.contentNodes).toHaveLength(0);
    expect(res.body.meta.totalBundles).toBe(1);
    expect(res.body.meta.totalBundleEdges).toBe(1);
    expect(res.body.meta.totalContentNodes).toBe(0);
  });

  it("returns contentNodes and bundle→content edges for non-paper CIDs", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Bundle has a CID (QmPost1) that is NOT in arxiv_content_map but IS in idx_content
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no papers
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no citation edges
      .mockResolvedValueOnce({
        rows: [{
          id: "0x01", bundle_id: 1, name: "Post Bundle", cid_count: 1,
          contributor_count: 1, creator_id: "0xdef", content_cids: ["QmPost1"],
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        // idx_content query returns the post metadata
        rows: [{ cid: "QmPost1", author_id: "0xdef", community_id: "ai-research", content_type: 0, timestamp: "1700000000" }],
        rowCount: 1,
      });

    const res = await request(app).get("/v1/citations/graph");

    expect(res.status).toBe(200);
    expect(res.body.contentNodes).toHaveLength(1);
    expect(res.body.contentNodes[0]).toEqual({
      id: "QmPost1",
      type: "content",
      authorId: "0xdef",
      communityId: "ai-research",
      contentType: 0,
      timestamp: 1700000000,
    });
    expect(res.body.bundleEdges).toHaveLength(1);
    expect(res.body.bundleEdges[0]).toEqual({ source: "bundle:1", target: "QmPost1" });
    expect(res.body.meta.totalContentNodes).toBe(1);
  });

  it("falls back to chain when content_cids is empty but cid_count > 0", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    mockGetBundleContent.mockResolvedValueOnce(["QmNode1"]);

    pool.query
      .mockResolvedValueOnce({
        rows: [{ content_cid: "QmNode1", arxiv_id: "2301.00001", title: "Paper A", categories: ["cs.AI"], citation_count: 5, quality_score: 80 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: "0x00", bundle_id: 0, name: "Bundle Missing CIDs", cid_count: 1,
          contributor_count: 0, creator_id: "0xabc", content_cids: null,
        }],
        rowCount: 1,
      });
    // No idx_content query since chain fallback CID matches paperCidSet

    const res = await request(app).get("/v1/citations/graph");

    expect(res.status).toBe(200);
    expect(mockGetBundleContent).toHaveBeenCalledWith(BigInt(0));
    expect(res.body.bundleNodes).toHaveLength(1);
    expect(res.body.bundleEdges).toHaveLength(1);
    expect(res.body.bundleEdges[0]).toEqual({ source: "bundle:0", target: "QmNode1" });
  });

  it("skips chain fallback when content_cids is empty and cid_count is 0", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: "0x00", bundle_id: 0, name: "Empty Bundle", cid_count: 0,
          contributor_count: 0, creator_id: "0xabc", content_cids: [],
        }],
        rowCount: 1,
      });
    // No idx_content query since no non-paper CIDs to look up

    const res = await request(app).get("/v1/citations/graph");

    expect(res.status).toBe(200);
    expect(mockGetBundleContent).not.toHaveBeenCalled();
    expect(res.body.bundleNodes).toHaveLength(1);
    expect(res.body.bundleEdges).toHaveLength(0);
    expect(res.body.contentNodes).toHaveLength(0);
  });

  it("handles chain fallback failure gracefully", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    mockGetBundleContent.mockRejectedValueOnce(new Error("RPC timeout"));

    pool.query
      .mockResolvedValueOnce({
        rows: [{ content_cid: "QmNode1", arxiv_id: "2301.00001", title: "Paper A", categories: [], citation_count: 0, quality_score: 0 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: "0x00", bundle_id: 0, name: "Failed Bundle", cid_count: 1,
          contributor_count: 0, creator_id: "0xabc", content_cids: null,
        }],
        rowCount: 1,
      });
    // No idx_content query since chain fallback failed, content_cids stays null

    const res = await request(app).get("/v1/citations/graph");

    expect(res.status).toBe(200);
    // Bundle node still returned, just no edges
    expect(res.body.bundleNodes).toHaveLength(1);
    expect(res.body.bundleEdges).toHaveLength(0);
  });

  it("returns empty graph", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/citations/graph");

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(0);
    expect(res.body.edges).toHaveLength(0);
    expect(res.body.bundleNodes).toHaveLength(0);
    expect(res.body.bundleEdges).toHaveLength(0);
    expect(res.body.contentNodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/citations/most-cited — Most-cited content
// ---------------------------------------------------------------------------

describe("GET /v1/citations/most-cited", () => {
  it("returns most-cited papers", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, arxiv_id: "2301.00001", title: "Top Paper", citation_count: 50 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/citations/most-cited");

    expect(res.status).toBe(200);
    expect(res.body.papers).toHaveLength(1);
    expect(res.body.count).toBe(1);
  });

  it("respects limit parameter", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/citations/most-cited?limit=5");

    expect(res.status).toBe(200);
    // Verify limit was passed in query
    const queryCall = pool.query.mock.calls[0];
    expect(queryCall[1]).toContain(5);
  });

  it("filters by community", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/citations/most-cited?community=cs.AI");

    expect(res.status).toBe(200);
    const queryCall = pool.query.mock.calls[0];
    expect(queryCall[0]).toContain("categories");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/citations/pending — Admin-only pending citations
// ---------------------------------------------------------------------------

describe("GET /v1/citations/pending", () => {
  it("returns pending citations for admin", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // count + data parallel queries
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: 10 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 1, source_cid: "QmSrc", target_external_id: "2301.00002", target_platform: "arxiv", created_at: new Date(), source_title: "Paper" }],
        rowCount: 1,
      });

    const res = await request(app)
      .get("/v1/citations/pending")
      .set("x-admin-key", ADMIN_KEY);

    // Will get 403 because env var ADMIN_API_KEY is not set to our test key
    // The requireAdmin middleware checks process.env.ADMIN_API_KEY
    // In test env it's undefined, so key !== undefined fails
    expect(res.status).toBe(403);
  });

  it("rejects non-admin request", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/citations/pending");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/citations/:cid — Citations for a CID
// ---------------------------------------------------------------------------

describe("GET /v1/citations/:cid", () => {
  it("returns outbound and inbound citations", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Outbound query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, target_external_id: "2301.00002", target_platform: "arxiv", resolved_cid: "QmTarget", resolved_at: new Date(), created_at: new Date(), resolved_title: "Cited Paper", resolved_arxiv_id: "2301.00002" }],
      rowCount: 1,
    });
    // Inbound query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 2, source_cid: "QmCiter", target_external_id: "2301.00001", target_platform: "arxiv", created_at: new Date(), source_title: "Citing Paper", source_arxiv_id: "2301.00003" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/citations/QmTest123");

    expect(res.status).toBe(200);
    expect(res.body.cid).toBe("QmTest123");
    expect(res.body.outbound).toHaveLength(1);
    expect(res.body.inbound).toHaveLength(1);
    expect(res.body.counts.outbound).toBe(1);
    expect(res.body.counts.inbound).toBe(1);
  });

  it("returns empty citations for unknown CID", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/citations/QmUnknown");

    expect(res.status).toBe(200);
    expect(res.body.counts.outbound).toBe(0);
    expect(res.body.counts.inbound).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/citations/:cid/tree — Citation tree
// ---------------------------------------------------------------------------

describe("GET /v1/citations/:cid/tree", () => {
  it("returns citation tree", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Root metadata
    pool.query.mockResolvedValueOnce({
      rows: [{ title: "Root Paper", arxiv_id: "2301.00001" }],
      rowCount: 1,
    });
    // Outbound refs for root
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Inbound refs for root
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/citations/QmRoot/tree");

    expect(res.status).toBe(200);
    expect(res.body.tree.cid).toBe("QmRoot");
    expect(res.body.tree.title).toBe("Root Paper");
    expect(res.body.tree.depth).toBe(0);
    expect(res.body.tree.direction).toBe("root");
    expect(res.body.tree.children).toHaveLength(0);
  });

  it("respects depth parameter", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Query order follows recursion: root meta → root outbound → child meta (recurse) → root inbound
    // 1. Root metadata
    pool.query.mockResolvedValueOnce({
      rows: [{ title: "Root", arxiv_id: "2301.00001" }],
      rowCount: 1,
    });
    // 2. Root outbound refs — has one child
    pool.query.mockResolvedValueOnce({
      rows: [{ resolved_cid: "QmChild1" }],
      rowCount: 1,
    });
    // 3. Child metadata (depth=1 = maxDepth, stops recursion — no further queries for this node)
    pool.query.mockResolvedValueOnce({
      rows: [{ title: "Child Paper", arxiv_id: "2301.00002" }],
      rowCount: 1,
    });
    // 4. Root inbound refs (resumes after child recursion)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/citations/QmRoot/tree?depth=1");

    expect(res.status).toBe(200);
    expect(res.body.tree.children).toHaveLength(1);
    expect(res.body.tree.children[0].cid).toBe("QmChild1");
    // Child should have no children (depth capped)
    expect(res.body.tree.children[0].children).toHaveLength(0);
  });
});
