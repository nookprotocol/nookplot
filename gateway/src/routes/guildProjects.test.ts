import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createGuildProjectsRouter } from "./guildProjects.js";
import { hashApiKey } from "../auth.js";
import {
  createTestApp,
  createMockPool,
  createMockAgent,
  TEST_HMAC_SECRET,
} from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr,
  },
}));

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({
  id: "agt_guild_test_001",
  address: "0x1111111111111111111111111111111111111111",
  api_key_hash: TEST_KEY_HASH,
  did_cid: "bafytest",
});

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createGuildProjectsRouter(pool as any, TEST_HMAC_SECRET);
  return { app: createTestApp(router) };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  // Auth middleware: agent lookup
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  // Credit headers: balance check
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

describe("POST /v1/guilds/:id/projects", () => {
  it("links a project to a guild (201)", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    // Resolve guild
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xproposer" }],
      rowCount: 1,
    });
    // Check membership (approved)
    pool.query.mockResolvedValueOnce({
      rows: [{ member_id: TEST_AGENT.address }],
      rowCount: 1,
    });
    // Resolve project
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "my-project", name: "My Project", agent_id: TEST_AGENT.id }],
      rowCount: 1,
    });
    // Insert link
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/guilds/1/projects")
      .set(authHeader())
      .send({ projectId: "my-project" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Project linked to guild.");
  });

  it("returns 200 for idempotent re-link", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xproposer" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [{ member_id: TEST_AGENT.address }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "my-project", name: "My Project", agent_id: TEST_AGENT.id }],
      rowCount: 1,
    });
    // ON CONFLICT DO NOTHING → rowCount 0
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/guilds/1/projects")
      .set(authHeader())
      .send({ projectId: "my-project" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Project already linked.");
  });

  it("returns 404 when guild not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/guilds/999/projects")
      .set(authHeader())
      .send({ projectId: "my-project" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Guild not found.");
  });

  it("returns 403 when caller is not guild member", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xproposer" }],
      rowCount: 1,
    });
    // Not a member
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/guilds/1/projects")
      .set(authHeader())
      .send({ projectId: "my-project" });

    expect(res.status).toBe(403);
  });

  it("returns 403 when caller is not project owner", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xproposer" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [{ member_id: TEST_AGENT.address }], rowCount: 1 });
    // Project owned by someone else
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1", project_id: "my-project", name: "My Project", agent_id: "other-agent-id" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/guilds/1/projects")
      .set(authHeader())
      .send({ projectId: "my-project" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the project owner can link it to a guild.");
  });

  it("returns 404 when project not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xproposer" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [{ member_id: TEST_AGENT.address }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/guilds/1/projects")
      .set(authHeader())
      .send({ projectId: "nonexistent" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project not found.");
  });

  it("returns 400 when projectId missing", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/guilds/1/projects")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/guilds/:id/projects/:projectId", () => {
  it("unlinks a project (original linker)", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xother" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1" }],
      rowCount: 1,
    });
    // Link exists, linked_by is the caller
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "link-1", linked_by: TEST_AGENT.id }],
      rowCount: 1,
    });
    // Delete
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .delete("/v1/guilds/1/projects/my-project")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Project unlinked from guild.");
  });

  it("returns 403 when caller is neither linker nor proposer", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xother" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "link-1", linked_by: "someone-else" }],
      rowCount: 1,
    });

    const res = await request(app)
      .delete("/v1/guilds/1/projects/my-project")
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("returns 404 when link does not exist", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1", guild_id: "1", proposer_id: "0xother" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .delete("/v1/guilds/1/projects/my-project")
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Project is not linked to this guild.");
  });
});

describe("GET /v1/guilds/:id/projects", () => {
  it("lists projects linked to a guild", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Resolve guild
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1" }],
      rowCount: 1,
    });
    // Projects list + count (parallel)
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          project_id: "proj-1",
          name: "Project Alpha",
          description: "Desc",
          languages: ["TypeScript"],
          tags: ["ai"],
          status: "active",
          created_at: new Date("2025-01-01"),
          creator_address: "0x1111",
          creator_name: "Alice",
          linked_at: new Date("2025-06-01"),
        },
      ],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ total: 1 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/guilds/1/projects");

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].projectId).toBe("proj-1");
    expect(res.body.total).toBe(1);
  });

  it("returns 404 when guild not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/guilds/999/projects");

    expect(res.status).toBe(404);
  });

  it("returns empty list when no projects linked", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "guild-entity-1" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 });

    const res = await request(app).get("/v1/guilds/1/projects");

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

describe("GET /v1/projects/:id/guilds", () => {
  it("lists guilds linked to a project", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    // Resolve project
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "proj-uuid-1" }],
      rowCount: 1,
    });
    // Guild list
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          guild_id: "1",
          name: "AI Guild",
          status: 1,
          member_count: 5,
          linked_at: new Date("2025-06-01"),
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/projects/my-project/guilds");

    expect(res.status).toBe(200);
    expect(res.body.guilds).toHaveLength(1);
    expect(res.body.guilds[0].guildId).toBe("1");
    expect(res.body.guilds[0].memberCount).toBe(5);
  });

  it("returns 404 when project not found", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/projects/nonexistent/guilds");

    expect(res.status).toBe(404);
  });
});
