import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createProjectsRouter } from "./projects.js";
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
const TEST_AGENT = createMockAgent({ id: "agt_proj", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} };

function buildApp(pool: ReturnType<typeof createMockPool>, searchService?: any) {
  const router = createProjectsRouter(
    pool as any,
    SDK_CONFIG as any,
    TEST_HMAC_SECRET,
    undefined,
    undefined,
    searchService,
  );
  return { app: createTestApp(router) };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  POST /v1/projects — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/projects — 410 Gone", () => {
  it("returns 410 with prepare+relay instructions", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects")
      .set(authHeader())
      .send({ projectId: "test-proj", name: "Test Project", description: "A project", repoUrl: "https://github.com/test/repo" });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/project");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects — List my projects
// ---------------------------------------------------------------------------

describe("GET /v1/projects", () => {
  it("returns agent's projects", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        project_id: "proj-1", name: "My Project", description: "desc",
        repo_url: "https://github.com/test", default_branch: "main",
        languages: ["typescript"], tags: ["ai"], license: "MIT",
        metadata_cid: "Qm123", status: "active", created_at: new Date("2025-06-01"),
        creator_address: "0x1111111111111111111111111111111111111111",
        creator_name: "Test Agent",
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/projects")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].projectId).toBe("proj-1");
    expect(res.body.projects[0].name).toBe("My Project");
    expect(res.body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/network — Browse all active projects
// ---------------------------------------------------------------------------

describe("GET /v1/projects/network", () => {
  it("returns paginated projects", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Two parallel queries: data + count
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          project_id: "proj-1", name: "Network Project", description: "public",
          repo_url: null, default_branch: "main", languages: [],
          tags: [], license: null, metadata_cid: null, status: "active",
          created_at: new Date(), creator_address: "0xaaa", creator_name: "Alice",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ total: 1 }],
        rowCount: 1,
      });

    const res = await request(app).get("/v1/projects/network");

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(20);
  });

  it("applies search query filter", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 });

    const res = await request(app).get("/v1/projects/network?q=test&limit=5");

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    // Verify search was applied in query
    const queryStr = pool.query.mock.calls[0][0];
    expect(queryStr).toContain("ILIKE");
  });

  it("supports sort parameter", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 });

    const res = await request(app).get("/v1/projects/network?sort=oldest");

    expect(res.status).toBe(200);
    const queryStr = pool.query.mock.calls[0][0];
    expect(queryStr).toContain("ASC");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id — Project detail (public)
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id", () => {
  it("returns project with collaborators", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project query
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1, project_id: "proj-1", name: "My Project", description: "desc",
        repo_url: "https://github.com/test", default_branch: "main",
        languages: ["ts"], tags: ["ai"], license: "MIT",
        metadata_cid: "Qm123", on_chain_tx: "0xabc", status: "active",
        created_at: new Date(), updated_at: new Date(),
        creator_address: "0x1111111111111111111111111111111111111111",
        creator_name: "Test Agent",
      }],
      rowCount: 1,
    });
    // Collaborators query
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0x2222222222222222222222222222222222222222", display_name: "Bob", role: 1 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/projects/proj-1");

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe("proj-1");
    expect(res.body.collaborators).toHaveLength(1);
    expect(res.body.collaborators[0].role).toBe(1);
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/projects/missing");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  PATCH /v1/projects/:id — 410 Gone
// ---------------------------------------------------------------------------

describe("PATCH /v1/projects/:id — 410 Gone", () => {
  it("returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .patch("/v1/projects/proj-1")
      .set(authHeader())
      .send({ description: "updated" });

    expect(res.status).toBe(410);
    expect(res.body.prepareEndpoint).toContain("prepare/project");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/collaborators — Add collaborator
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/collaborators", () => {
  it("adds a collaborator", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup (owner check)
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: "MyProject", project_id: "proj-1", agent_id: TEST_AGENT.id, owner_address: TEST_AGENT.address }],
      rowCount: 1,
    });
    // Collaborator agent lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_collab", address: "0x2222222222222222222222222222222222222222", display_name: "Bob" }],
      rowCount: 1,
    });
    // INSERT collaborator
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Channel lookup (auto-join)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Activity log
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/projects/proj-1/collaborators")
      .set(authHeader())
      .send({ collaborator: "0x2222222222222222222222222222222222222222", role: "editor" });

    expect(res.status).toBe(201);
    expect(res.body.collaborator.address).toBe("0x2222222222222222222222222222222222222222");
    expect(res.body.collaborator.roleName).toBe("editor");
  });

  it("rejects invalid role", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: "P", project_id: "proj-1", agent_id: TEST_AGENT.id, owner_address: TEST_AGENT.address }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/collaborators")
      .set(authHeader())
      .send({ collaborator: "0x2222222222222222222222222222222222222222", role: "superadmin" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("role");
  });

  it("rejects missing collaborator address", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: "P", project_id: "proj-1", agent_id: TEST_AGENT.id, owner_address: TEST_AGENT.address }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/collaborators")
      .set(authHeader())
      .send({ role: "editor" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("collaborator");
  });

  it("prevents adding self as collaborator", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: "P", project_id: "proj-1", agent_id: TEST_AGENT.id, owner_address: TEST_AGENT.address }],
      rowCount: 1,
    });
    // Agent lookup returns self
    pool.query.mockResolvedValueOnce({
      rows: [{ id: TEST_AGENT.id, address: TEST_AGENT.address, display_name: "Self" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/collaborators")
      .set(authHeader())
      .send({ collaborator: TEST_AGENT.address, role: "editor" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("yourself");
  });

  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/projects/missing/collaborators")
      .set(authHeader())
      .send({ collaborator: "0x2222222222222222222222222222222222222222", role: "viewer" });

    expect(res.status).toBe(404);
  });

  it("rejects non-owner", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup — different owner
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: "P", project_id: "proj-1", agent_id: "agt_other", owner_address: "0x9999999999999999999999999999999999999999" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/proj-1/collaborators")
      .set(authHeader())
      .send({ collaborator: "0x2222222222222222222222222222222222222222", role: "editor" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/projects/:id/collaborators/:target — Remove collaborator
// ---------------------------------------------------------------------------

describe("DELETE /v1/projects/:id/collaborators/:target", () => {
  it("removes a collaborator", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, agent_id: TEST_AGENT.id }],
      rowCount: 1,
    });
    // Target agent lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_collab" }],
      rowCount: 1,
    });
    // DELETE
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .delete("/v1/projects/proj-1/collaborators/0x2222222222222222222222222222222222222222")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("removed");
  });

  it("returns 404 for non-collaborator", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, agent_id: TEST_AGENT.id }],
      rowCount: 1,
    });
    // Target agent lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_other" }],
      rowCount: 1,
    });
    // DELETE — no rows affected
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .delete("/v1/projects/proj-1/collaborators/0x2222222222222222222222222222222222222222")
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not a collaborator");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/:id/versions — 410 Gone
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/versions — 410 Gone", () => {
  it("returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/proj-1/versions")
      .set(authHeader())
      .send({ commitHash: "a".repeat(40) });

    expect(res.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/projects/:id — 410 Gone
// ---------------------------------------------------------------------------

describe("DELETE /v1/projects/:id — 410 Gone", () => {
  it("returns 410", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .delete("/v1/projects/proj-1")
      .set(authHeader());

    expect(res.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/projects/discover — Mandatory pre-creation discovery
// ---------------------------------------------------------------------------

describe("POST /v1/projects/discover", () => {
  it("returns similarProjects and discoveryId", async () => {
    const mockSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [{
          type: "project",
          id: "existing-proj",
          title: "Existing Project",
          snippet: "An existing project",
          relevance: 0.8,
          metadata: { languages: ["typescript"], tags: ["ai"] },
          createdAt: "2025-06-01T00:00:00.000Z",
        }],
        total: 1,
        limit: 20,
        offset: 0,
        query: "image classifier",
      }),
    };

    const pool = createMockPool();
    const { app } = buildApp(pool, mockSearchService);
    setupAuth(pool);

    // Tag overlap query — no additional results
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT discovery record
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "disc-uuid-1234" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/discover")
      .set(authHeader())
      .send({ name: "image classifier", tags: ["ml"] });

    expect(res.status).toBe(200);
    expect(res.body.discoveryId).toBe("disc-uuid-1234");
    expect(res.body.similarProjects).toHaveLength(1);
    expect(res.body.similarProjects[0].projectId).toBe("existing-proj");
    expect(res.body.total).toBe(1);
  });

  it("handles no matches (empty results, still returns discoveryId)", async () => {
    const mockSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
        limit: 20,
        offset: 0,
        query: "something unique",
      }),
    };

    const pool = createMockPool();
    const { app } = buildApp(pool, mockSearchService);
    setupAuth(pool);

    // INSERT discovery record
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "disc-uuid-empty" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/projects/discover")
      .set(authHeader())
      .send({ name: "something unique" });

    expect(res.status).toBe(200);
    expect(res.body.discoveryId).toBe("disc-uuid-empty");
    expect(res.body.similarProjects).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("validates name is required", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/projects/discover")
      .set(authHeader())
      .send({ tags: ["ml"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("name");
  });

  it("requires auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/projects/discover")
      .send({ name: "test" });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/projects/:id/related-bundles — Algorithmic bundle suggestions
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/related-bundles", () => {
  it("returns 404 for nonexistent project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/projects/missing/related-bundles");

    expect(res.status).toBe(404);
  });

  it("returns empty bundles when no matches", async () => {
    const mockSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [],
        total: 0,
        limit: 20,
        offset: 0,
        query: "test project",
      }),
    };

    const pool = createMockPool();
    const { app } = buildApp(pool, mockSearchService);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "proj-1", name: "Test Project", description: "desc", tags: [], languages: [], agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Collaborator addresses
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Tag match query — no results (no search terms)

    const res = await request(app).get("/v1/projects/proj-1/related-bundles");

    expect(res.status).toBe(200);
    expect(res.body.bundles).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("returns bundles from contributor overlap", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "proj-1", name: "Test Project", description: "desc", tags: [], languages: [], agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Collaborator addresses
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0xAAA" }],
      rowCount: 1,
    });
    // Contributor overlap query
    pool.query.mockResolvedValueOnce({
      rows: [{
        bundle_id: 5,
        name: "AI Patterns Bundle",
        cid_count: 12,
        contributor_count: 3,
        creator_id: "0xAAA",
        created_at: "1700000000",
      }],
      rowCount: 1,
    });
    // No FTS (no searchService passed)
    // No tag match (empty tags/languages)

    const res = await request(app).get("/v1/projects/proj-1/related-bundles");

    expect(res.status).toBe(200);
    expect(res.body.bundles).toHaveLength(1);
    expect(res.body.bundles[0].bundleId).toBe("5");
    expect(res.body.bundles[0].name).toBe("AI Patterns Bundle");
    expect(res.body.bundles[0].matchReasons).toContain("contributor_overlap");
    expect(res.body.bundles[0].relevanceScore).toBe(1);
  });

  it("merges and deduplicates across strategies", async () => {
    const mockSearchService = {
      search: vi.fn().mockResolvedValue({
        results: [
          {
            type: "bundle",
            id: "5",
            title: "AI Patterns Bundle",
            snippet: "...",
            relevance: 0.8,
            metadata: { cidCount: 12, contributorCount: 3, creatorId: "0xAAA" },
            createdAt: "2025-01-01T00:00:00.000Z",
          },
          {
            type: "bundle",
            id: "10",
            title: "ML Fundamentals",
            snippet: "...",
            relevance: 0.5,
            metadata: { cidCount: 8, contributorCount: 2, creatorId: "0xBBB" },
            createdAt: "2025-02-01T00:00:00.000Z",
          },
        ],
        total: 2,
        limit: 20,
        offset: 0,
        query: "Test Project desc",
      }),
    };

    const pool = createMockPool();
    const { app } = buildApp(pool, mockSearchService);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "proj-1", name: "Test Project", description: "desc", tags: ["ai"], languages: [], agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Collaborator addresses
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0xAAA" }],
      rowCount: 1,
    });
    // Contributor overlap — bundle 5 found here too
    pool.query.mockResolvedValueOnce({
      rows: [{
        bundle_id: 5,
        name: "AI Patterns Bundle",
        cid_count: 12,
        contributor_count: 3,
        creator_id: "0xAAA",
        created_at: "1700000000",
      }],
      rowCount: 1,
    });
    // FTS called by searchService mock (handled above)
    // Tag match query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/projects/proj-1/related-bundles");

    expect(res.status).toBe(200);
    // Bundle 5 should appear once with combined score (1.0 + 0.8*0.7 = 1.56)
    const bundle5 = res.body.bundles.find((b: any) => b.bundleId === "5");
    expect(bundle5).toBeDefined();
    expect(bundle5.matchReasons).toContain("contributor_overlap");
    expect(bundle5.matchReasons).toContain("text_similarity");
    expect(bundle5.relevanceScore).toBeGreaterThan(1.0);
    // Bundle 10 should also be present (FTS only)
    const bundle10 = res.body.bundles.find((b: any) => b.bundleId === "10");
    expect(bundle10).toBeDefined();
  });

  it("respects limit parameter", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Project lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "proj-1", name: "Test", description: null, tags: [], languages: [], agent_id: "agt_1" }],
      rowCount: 1,
    });
    // Collaborator addresses
    pool.query.mockResolvedValueOnce({
      rows: [{ address: "0xAAA" }],
      rowCount: 1,
    });
    // Contributor overlap — multiple bundles
    pool.query.mockResolvedValueOnce({
      rows: [
        { bundle_id: 1, name: "B1", cid_count: 1, contributor_count: 1, creator_id: "0xAAA", created_at: "1700000000" },
        { bundle_id: 2, name: "B2", cid_count: 2, contributor_count: 1, creator_id: "0xAAA", created_at: "1700000000" },
        { bundle_id: 3, name: "B3", cid_count: 3, contributor_count: 1, creator_id: "0xAAA", created_at: "1700000000" },
      ],
      rowCount: 3,
    });

    const res = await request(app).get("/v1/projects/proj-1/related-bundles?limit=2");

    expect(res.status).toBe(200);
    expect(res.body.bundles).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });
});
