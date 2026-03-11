import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { Router } from "express";
import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";
import { createAgentMemoryRouter } from "./agentMemory.js";
import { createMockPool, createMockAgent } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  Mocks
// ---------------------------------------------------------------------------

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  createAuthMiddleware: () =>
    (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      // Auth is injected per-test via req.agent
      next();
    },
  registeredMiddleware: (_req: AuthenticatedRequest, _res: Response, next: NextFunction) => next(),
}));

const AGENT = createMockAgent({ id: "agt_mem_test", did_cid: "bafytest" });

function mockMemoryService() {
  return {
    store: vi.fn(),
    recall: vi.fn(),
    list: vi.fn(),
    getStats: vi.fn(),
    exportMemories: vi.fn(),
    importMemories: vi.fn(),
    proveMemory: vi.fn(),
    deleteMemory: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as any;
}

function buildApp(memService: ReturnType<typeof mockMemoryService>, agent = AGENT) {
  const pool = createMockPool();
  const router = createAgentMemoryRouter(pool as any, "secret", memService);

  const app = express();
  app.use(express.json());
  // Inject agent before router
  app.use((req: any, _res: Response, next: NextFunction) => {
    req.agent = agent;
    next();
  });
  app.use("/v1", router);
  return app;
}

function buildUnauthApp(memService: ReturnType<typeof mockMemoryService>) {
  const pool = createMockPool();
  const router = createAgentMemoryRouter(pool as any, "secret", memService);
  const app = express();
  app.use(express.json());
  // No agent injected — simulates unauthenticated request
  app.use("/v1", router);
  return app;
}

// ---------------------------------------------------------------------------
//  POST /v1/agent-memory/store
// ---------------------------------------------------------------------------

describe("POST /v1/agent-memory/store", () => {
  it("stores a memory and returns 201", async () => {
    const svc = mockMemoryService();
    const stored = { id: "mem_1", type: "episodic", content: "I learned something" };
    svc.store.mockResolvedValue(stored);
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ type: "episodic", content: "I learned something" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(stored);
    expect(svc.store).toHaveBeenCalledWith(AGENT.id, "episodic", "I learned something", {
      importance: undefined, decayRate: undefined, tags: undefined,
      source: undefined, parentMemoryId: undefined, metadata: undefined,
    });
  });

  it("returns 400 when type is missing", async () => {
    const svc = mockMemoryService();
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ content: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("type and content are required");
  });

  it("returns 400 when content is missing", async () => {
    const svc = mockMemoryService();
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ type: "semantic" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("type and content are required");
  });

  it("returns 400 for invalid memory type from service", async () => {
    const svc = mockMemoryService();
    svc.store.mockRejectedValue(new Error("Invalid memory type: banana"));
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ type: "banana", content: "test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid memory type");
  });

  it("returns 400 when cap reached", async () => {
    const svc = mockMemoryService();
    svc.store.mockRejectedValue(new Error("Memory cap reached"));
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ type: "episodic", content: "test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("cap reached");
  });

  it("returns 500 on unexpected service error", async () => {
    const svc = mockMemoryService();
    svc.store.mockRejectedValue(new Error("DB connection lost"));
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ type: "episodic", content: "test" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to store memory.");
  });

  it("returns 401 when unauthenticated", async () => {
    const svc = mockMemoryService();
    const app = buildUnauthApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/store")
      .send({ type: "episodic", content: "test" });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agent-memory/recall
// ---------------------------------------------------------------------------

describe("POST /v1/agent-memory/recall", () => {
  it("returns memories matching query", async () => {
    const svc = mockMemoryService();
    const memories = [{ id: "m1", content: "relevant memory" }];
    svc.recall.mockResolvedValue(memories);
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/recall")
      .send({ query: "what do I know about dogs?" });

    expect(res.status).toBe(200);
    expect(res.body.memories).toEqual(memories);
    expect(res.body.count).toBe(1);
  });

  it("returns 400 when query is missing", async () => {
    const svc = mockMemoryService();
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/recall")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("query is required");
  });

  it("returns 402 on insufficient credits", async () => {
    const svc = mockMemoryService();
    svc.recall.mockRejectedValue(new Error("Insufficient credits"));
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/recall")
      .send({ query: "test" });

    expect(res.status).toBe(402);
    expect(res.body.error).toContain("Insufficient credits");
  });

  it("passes optional filters to service", async () => {
    const svc = mockMemoryService();
    svc.recall.mockResolvedValue([]);
    const app = buildApp(svc);

    await request(app)
      .post("/v1/agent-memory/recall")
      .send({ query: "test", types: ["semantic"], limit: 5, minImportance: 0.5 });

    expect(svc.recall).toHaveBeenCalledWith(AGENT.id, "test", {
      types: ["semantic"], limit: 5, minImportance: 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agent-memory/list
// ---------------------------------------------------------------------------

describe("GET /v1/agent-memory/list", () => {
  it("returns memories with defaults", async () => {
    const svc = mockMemoryService();
    const memories = [{ id: "m1" }];
    svc.list.mockResolvedValue(memories);
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/list");

    expect(res.status).toBe(200);
    expect(res.body.memories).toEqual(memories);
    expect(res.body.count).toBe(1);
    expect(svc.list).toHaveBeenCalledWith(AGENT.id, { type: undefined, limit: 50, offset: 0 });
  });

  it("passes type, limit, and offset query params", async () => {
    const svc = mockMemoryService();
    svc.list.mockResolvedValue([]);
    const app = buildApp(svc);

    await request(app).get("/v1/agent-memory/list?type=semantic&limit=10&offset=5");

    expect(svc.list).toHaveBeenCalledWith(AGENT.id, { type: "semantic", limit: 10, offset: 5 });
  });

  it("returns 500 on service error", async () => {
    const svc = mockMemoryService();
    svc.list.mockRejectedValue(new Error("DB error"));
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/list");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agent-memory/stats
// ---------------------------------------------------------------------------

describe("GET /v1/agent-memory/stats", () => {
  it("returns memory stats", async () => {
    const svc = mockMemoryService();
    const stats = { totalMemories: 42, byType: { episodic: 30, semantic: 12 } };
    svc.getStats.mockResolvedValue(stats);
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/stats");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stats);
  });

  it("returns 500 on service error", async () => {
    const svc = mockMemoryService();
    svc.getStats.mockRejectedValue(new Error("fail"));
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/stats");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agent-memory/export
// ---------------------------------------------------------------------------

describe("POST /v1/agent-memory/export", () => {
  it("returns memory pack", async () => {
    const svc = mockMemoryService();
    const pack = { memories: [{ id: "m1" }], packHash: "abc123" };
    svc.exportMemories.mockResolvedValue(pack);
    const app = buildApp(svc);

    const res = await request(app).post("/v1/agent-memory/export");

    expect(res.status).toBe(200);
    expect(res.body.packHash).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agent-memory/import
// ---------------------------------------------------------------------------

describe("POST /v1/agent-memory/import", () => {
  it("imports a valid memory pack", async () => {
    const svc = mockMemoryService();
    svc.importMemories.mockResolvedValue({ imported: 3 });
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/import")
      .send({ memories: [{ id: "m1" }], packHash: "abc123" });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(3);
  });

  it("returns 400 when pack is missing memories", async () => {
    const svc = mockMemoryService();
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/import")
      .send({ packHash: "abc123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Valid memory pack");
  });

  it("returns 400 when packHash is missing", async () => {
    const svc = mockMemoryService();
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/import")
      .send({ memories: [{ id: "m1" }] });

    expect(res.status).toBe(400);
  });

  it("returns 402 on insufficient credits", async () => {
    const svc = mockMemoryService();
    svc.importMemories.mockRejectedValue(new Error("Insufficient credits"));
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/import")
      .send({ memories: [{ id: "m1" }], packHash: "abc123" });

    expect(res.status).toBe(402);
  });

  it("returns 400 on hash mismatch", async () => {
    const svc = mockMemoryService();
    svc.importMemories.mockRejectedValue(new Error("Pack hash mismatch"));
    const app = buildApp(svc);

    const res = await request(app)
      .post("/v1/agent-memory/import")
      .send({ memories: [{ id: "m1" }], packHash: "wrong" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("hash mismatch");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agent-memory/proof/:memoryId
// ---------------------------------------------------------------------------

describe("GET /v1/agent-memory/proof/:memoryId", () => {
  it("returns proof for existing memory", async () => {
    const svc = mockMemoryService();
    const proof = { memoryId: "m1", contentHash: "sha256abc" };
    svc.proveMemory.mockResolvedValue(proof);
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/proof/m1");

    expect(res.status).toBe(200);
    expect(res.body.contentHash).toBe("sha256abc");
  });

  it("returns 404 when memory not found", async () => {
    const svc = mockMemoryService();
    svc.proveMemory.mockResolvedValue(null);
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/proof/nonexistent");

    expect(res.status).toBe(404);
  });

  it("returns 500 on service error", async () => {
    const svc = mockMemoryService();
    svc.proveMemory.mockRejectedValue(new Error("DB error"));
    const app = buildApp(svc);

    const res = await request(app).get("/v1/agent-memory/proof/m1");

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  DELETE /v1/agent-memory/:id
// ---------------------------------------------------------------------------

describe("DELETE /v1/agent-memory/:id", () => {
  it("deletes a memory and returns success", async () => {
    const svc = mockMemoryService();
    svc.deleteMemory.mockResolvedValue(true);
    const app = buildApp(svc);

    const res = await request(app).delete("/v1/agent-memory/m1");

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(svc.deleteMemory).toHaveBeenCalledWith(AGENT.id, "m1");
  });

  it("returns 404 when memory not found", async () => {
    const svc = mockMemoryService();
    svc.deleteMemory.mockResolvedValue(false);
    const app = buildApp(svc);

    const res = await request(app).delete("/v1/agent-memory/nonexistent");

    expect(res.status).toBe(404);
  });

  it("returns 500 on service error", async () => {
    const svc = mockMemoryService();
    svc.deleteMemory.mockRejectedValue(new Error("DB error"));
    const app = buildApp(svc);

    const res = await request(app).delete("/v1/agent-memory/m1");

    expect(res.status).toBe(500);
  });
});
