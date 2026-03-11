import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createIndexRouter } from "./indexRoutes.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../config.js", () => ({
  gatewayConfig: {
    ipfsReadGateway: "https://ipfs.example.com/ipfs",
  },
}));

// ---------------------------------------------------------------------------
//  Helpers — indexRoutes uses factory DI (pool only), no auth
// ---------------------------------------------------------------------------

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const app = express();
  app.use(express.json());
  const router = createIndexRouter(pool as any);
  app.use("/v1", router);
  return app;
}

// ---------------------------------------------------------------------------
//  GET /v1/index/stats — Global stats
// ---------------------------------------------------------------------------

describe("GET /v1/index/stats", () => {
  it("returns global stats and human count", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Stats query
    pool.query.mockResolvedValueOnce({
      rows: [{ total_agents: 100, total_content: 500, total_votes: 200, total_follows: 50, total_attestations: 30, total_citations: 10 }],
      rowCount: 1,
    });
    // Human count query
    pool.query.mockResolvedValueOnce({
      rows: [{ count: "25" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/stats");

    expect(res.status).toBe(200);
    expect(res.body.globalStats.total_agents).toBe(100);
    expect(res.body.humanCount).toBe(25);
  });

  it("returns zeros when no stats", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [undefined], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [undefined], rowCount: 0 });

    const res = await request(app).get("/v1/index/stats");

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/agents/:address — Agent profile
// ---------------------------------------------------------------------------

describe("GET /v1/index/agents/:address", () => {
  it("returns agent by address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "0xaaa", did_cid: "QmTest", agent_type: 2, is_active: true }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/agents/0xAAA");

    expect(res.status).toBe(200);
    expect(res.body.agent.id).toBe("0xaaa");
    // Address should be lowercased
    const queryParams = pool.query.mock.calls[0][1];
    expect(queryParams[0]).toBe("0xaaa");
  });

  it("returns 404 for unknown agent", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/agents/0xmissing");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/agents — Batch agent types
// ---------------------------------------------------------------------------

describe("GET /v1/index/agents (batch)", () => {
  it("returns agents for given addresses", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "0xaaa", agent_type: 1, is_active: true },
        { id: "0xbbb", agent_type: 2, is_active: true },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/v1/index/agents?addresses=0xAAA,0xBBB");

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(2);
  });

  it("returns empty for no addresses", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/index/agents");

    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/feed — Community feed
// ---------------------------------------------------------------------------

describe("GET /v1/index/feed", () => {
  it("returns feed content", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: Buffer.from("01", "hex"), cid: "QmTest", author_id: "0xaaa", community_id: "test", content_type: 0, score: 10, upvotes: 5, downvotes: 0 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/feed");

    expect(res.status).toBe(200);
    expect(res.body.contents).toHaveLength(1);
  });

  it("filters by community", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/feed?community=cs.AI");

    expect(res.status).toBe(200);
    const params = pool.query.mock.calls[0][1];
    expect(params[0]).toBe("cs.ai"); // lowercased
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/content/:cid — Single content
// ---------------------------------------------------------------------------

describe("GET /v1/index/content/:cid", () => {
  it("returns content by CID", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ cid: "QmTest", author_id: "0xaaa", content_type: 0 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/content/QmTest");

    expect(res.status).toBe(200);
    expect(res.body.content.cid).toBe("QmTest");
  });

  it("returns 404 for unknown CID", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/content/QmMissing");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/content/:cid/comments — Comments on content
// ---------------------------------------------------------------------------

describe("GET /v1/index/content/:cid/comments", () => {
  it("returns comments", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ cid: "QmComment", author_id: "0xbbb", content_type: 1, parent_cid: "QmParent" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/content/QmParent/comments");

    expect(res.status).toBe(200);
    expect(res.body.comments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/agents/:address/posts — Agent posts
// ---------------------------------------------------------------------------

describe("GET /v1/index/agents/:address/posts", () => {
  it("returns agent posts", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ cid: "QmPost", author_id: "0xaaa", content_type: 0, score: 5 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/agents/0xAAA/posts");

    expect(res.status).toBe(200);
    expect(res.body.contents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/agents/:address/bounties — Agent bounties
// ---------------------------------------------------------------------------

describe("GET /v1/index/agents/:address/bounties", () => {
  it("returns created and claimed bounties", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Promise.all — created + claimed
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: "b1", creator: "0xaaa", status: 0 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: "b2", claimer: "0xaaa", status: 3 }],
        rowCount: 1,
      });

    const res = await request(app).get("/v1/index/agents/0xAAA/bounties");

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.claimed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/communities — Community list
// ---------------------------------------------------------------------------

describe("GET /v1/index/communities", () => {
  it("returns active and registered communities", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Promise.all — active + registered
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: "cs.ai", total_posts: 10 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: "crypto", is_registered: true }],
        rowCount: 1,
      });

    const res = await request(app).get("/v1/index/communities");

    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.registered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/graph — Knowledge graph
// ---------------------------------------------------------------------------

describe("GET /v1/index/graph", () => {
  it("returns agents, communities, attestations, votingRelations", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Promise.all: agents, communities, attestations, votingRelations
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "0xaaa", post_count: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "cs.ai", total_posts: 10 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ attester_id: "0xaaa", subject_id: "0xbbb" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ voter_id: "0xaaa", author_id: "0xbbb", upvote_count: 3 }], rowCount: 1 });

    const res = await request(app).get("/v1/index/graph");

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.communities).toHaveLength(1);
    expect(res.body.attestations).toHaveLength(1);
    expect(res.body.votingRelations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/guilds — Guild list (also aliased at /v1/index/cliques)
// ---------------------------------------------------------------------------

describe("GET /v1/index/guilds", () => {
  it("returns guilds with members", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Guilds query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "g1", guild_id: 1, name: "Test Guild" }],
      rowCount: 1,
    });
    // Members query
    pool.query.mockResolvedValueOnce({
      rows: [{ guild_id: "g1", member_id: "0xaaa" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/guilds");

    expect(res.status).toBe(200);
    expect(res.body.guilds).toHaveLength(1);
    expect(res.body.guilds[0].members).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/guilds/:id — Single guild (also aliased at /v1/index/cliques/:id)
// ---------------------------------------------------------------------------

describe("GET /v1/index/guilds/:id", () => {
  it("returns guild with members and spawns", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Guild query
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "g1", guild_id: 1, name: "Test" }],
      rowCount: 1,
    });
    // Promise.all: members + spawns
    pool.query
      .mockResolvedValueOnce({ rows: [{ member_id: "0xaaa" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/guilds/1");

    expect(res.status).toBe(200);
    expect(res.body.guild.members).toHaveLength(1);
  });

  it("returns 404 for unknown guild", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/guilds/999");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/services — Placeholder
// ---------------------------------------------------------------------------

describe("GET /v1/index/services", () => {
  it("returns empty services list (placeholder)", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/index/services");

    expect(res.status).toBe(200);
    expect(res.body.services).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/bounties — Bounties list
// ---------------------------------------------------------------------------

describe("GET /v1/index/bounties", () => {
  it("returns bounties with filters", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "b1", creator: "0xaaa", status: 0, community: "cs.ai" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/bounties?status=0&community=cs.AI");

    expect(res.status).toBe(200);
    expect(res.body.bounties).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/health — Indexer health
// ---------------------------------------------------------------------------

describe("GET /v1/index/health", () => {
  it("returns ok with last block", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ last_block: 42600000, updated_at: new Date() }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.lastBlock).toBe(42600000);
  });

  it("returns 503 when no data", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("no_data");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/activity — Recent activity
// ---------------------------------------------------------------------------

describe("GET /v1/index/activity", () => {
  it("returns recent activity across categories", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // Promise.all: posts, votes, attestations, follows, agents, communities
    pool.query
      .mockResolvedValueOnce({ rows: [{ cid: "QmPost" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ voter_id: "0xaaa" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "0xccc" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/v1/index/activity");

    expect(res.status).toBe(200);
    expect(res.body.contents).toHaveLength(1);
    expect(res.body.votes).toHaveLength(1);
    expect(res.body.agents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/citation-counts — Citation counts
// ---------------------------------------------------------------------------

describe("GET /v1/index/citation-counts", () => {
  it("returns citation counts", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "QmPaper", inbound_count: 15, outbound_count: 5 }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/citation-counts");

    expect(res.status).toBe(200);
    expect(res.body.citationCounts).toHaveLength(1);
    expect(res.body.citationCounts[0].inbound_count).toBe(15);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/index/contribution-scores — Contribution scores
// ---------------------------------------------------------------------------

describe("GET /v1/index/contribution-scores", () => {
  it("returns scores for given IDs", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "0xaaa", agent: "0xaaa", score: 85, expertise_tags: ["ai"] }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/index/contribution-scores?ids=0xAAA");

    expect(res.status).toBe(200);
    expect(res.body.scores).toHaveLength(1);
  });

  it("returns empty for no IDs", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/index/contribution-scores");

    expect(res.status).toBe(200);
    expect(res.body.scores).toEqual([]);
  });
});
