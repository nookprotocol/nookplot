import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentMemoryService } from "../agentMemoryService.js";
import type { AgentMemoryConfig } from "../agentMemoryService.js";

// ============================================================
//  Mock factories
// ============================================================

function createMockPool() {
  return { query: vi.fn(), connect: vi.fn() } as any;
}

function createMockEmbeddingService() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    hasPgvector: vi.fn().mockResolvedValue(false),
  } as any;
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 1000 }),
  } as any;
}

const TEST_CONFIG: Partial<AgentMemoryConfig> = {
  recallCostCredits: 10,
  importCostCredits: 25,
  decayIntervalMs: 999_999_999, // don't auto-tick in tests
  dreamIntervalMs: 999_999_999,
  pruneThreshold: 0.05,
  maxMemoriesPerAgent: 100,
  dreamBatchSize: 5,
  llmModel: "gpt-4o-mini",
  maxDreamEpisodicWindow: 50,
};

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ============================================================
//  Store Tests
// ============================================================

describe("AgentMemoryService — store", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should store an episodic memory", async () => {
    // Count query for cap check
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    // Insert
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "mem-1",
        agent_id: AGENT_ID,
        memory_type: "episodic",
        content: "Hello world",
        content_hash: "abc123",
        importance: 0.5,
        decay_rate: 0.1,
        access_count: 0,
        last_accessed_at: null,
        tags: [],
        source: "experience",
        parent_memory_id: null,
        metadata: {},
        created_at: "2026-03-04T00:00:00Z",
        updated_at: "2026-03-04T00:00:00Z",
      }],
    });

    const result = await service.store(AGENT_ID, "episodic", "Hello world");
    expect(result.id).toBe("mem-1");
    expect(result.memoryType).toBe("episodic");
    expect(result.content).toBe("Hello world");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("should reject invalid memory types", async () => {
    await expect(service.store(AGENT_ID, "invalid" as any, "test"))
      .rejects.toThrow("Invalid memory type");
  });

  it("should reject empty content", async () => {
    await expect(service.store(AGENT_ID, "episodic", ""))
      .rejects.toThrow("cannot be empty");
  });

  it("should enforce per-agent memory cap", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: "100" }] });

    await expect(service.store(AGENT_ID, "episodic", "test"))
      .rejects.toThrow("cap reached");
  });

  it("should use default importance for each type", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "mem-2", agent_id: AGENT_ID, memory_type: "self_model",
        content: "I am X", content_hash: "def", importance: 0.9,
        decay_rate: 0.1, access_count: 0, last_accessed_at: null,
        tags: [], source: "experience", parent_memory_id: null,
        metadata: {}, created_at: "2026-03-04T00:00:00Z",
        updated_at: "2026-03-04T00:00:00Z",
      }],
    });

    const result = await service.store(AGENT_ID, "self_model", "I am X");
    // The INSERT call should include importance 0.9 (self_model default)
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[1]).toContain(0.9); // importance param
  });
});

// ============================================================
//  Recall Tests
// ============================================================

describe("AgentMemoryService — recall", () => {
  let pool: any;
  let service: AgentMemoryService;
  let creditManager: any;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    service = new AgentMemoryService(pool, null, creditManager, TEST_CONFIG);
  });

  it("should deduct credits on recall", async () => {
    // FTS query
    pool.query.mockResolvedValueOnce({ rows: [] });

    await service.recall(AGENT_ID, "test query");

    expect(creditManager.deductCredits).toHaveBeenCalledWith(
      AGENT_ID, 10, expect.stringContaining("memory-recall"), "memory_recall",
    );
  });

  it("should return matching memories via FTS", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "mem-1", agent_id: AGENT_ID, memory_type: "semantic",
        content: "test content", content_hash: "abc", importance: 0.7,
        decay_rate: 0.1, access_count: 1, last_accessed_at: null,
        tags: [], source: "experience", parent_memory_id: null,
        metadata: {}, created_at: "2026-03-04T00:00:00Z",
        updated_at: "2026-03-04T00:00:00Z", rank: 0.5,
      }],
    });
    // Reinforcement update
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const memories = await service.recall(AGENT_ID, "test content");
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("test content");
    // Should reinforce (bump access_count)
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
//  Decay Tests
// ============================================================

describe("AgentMemoryService — decay", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should apply decay and prune low-importance memories", async () => {
    // Decay update
    pool.query.mockResolvedValueOnce({ rowCount: 10 });
    // Prune delete
    pool.query.mockResolvedValueOnce({ rowCount: 2 });

    const result = await service.decayTick();
    expect(result.decayed).toBe(10);
    expect(result.pruned).toBe(2);
  });
});

// ============================================================
//  Stats Tests
// ============================================================

describe("AgentMemoryService — stats", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should return memory stats by type", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { memory_type: "episodic", count: "5", total_importance: "2.5" },
        { memory_type: "semantic", count: "3", total_importance: "2.1" },
      ],
    });
    pool.query.mockResolvedValueOnce({ rows: [{ created_at: "2026-03-04T00:00:00Z" }] });

    const stats = await service.getStats(AGENT_ID);
    expect(stats.total).toBe(8);
    expect(stats.byType.episodic).toBe(5);
    expect(stats.byType.semantic).toBe(3);
    expect(stats.byType.procedural).toBe(0);
    expect(stats.totalImportance).toBe(4.6);
    expect(stats.lastDreamCycle).toBe("2026-03-04T00:00:00Z");
  });
});

// ============================================================
//  Export/Import Tests
// ============================================================

describe("AgentMemoryService — export/import", () => {
  let pool: any;
  let service: AgentMemoryService;
  let creditManager: any;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    service = new AgentMemoryService(pool, null, creditManager, TEST_CONFIG);
  });

  it("should export all memories as a pack with hash", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        memory_type: "episodic", content: "hello", content_hash: "abc",
        importance: 0.5, tags: [], source: "experience", metadata: {},
      }],
    });
    pool.query.mockResolvedValueOnce({ rowCount: 1 }); // transfer log

    const pack = await service.exportMemories(AGENT_ID);
    expect(pack.version).toBe("1.0");
    expect(pack.agentId).toBe(AGENT_ID);
    expect(pack.memories).toHaveLength(1);
    expect(pack.packHash).toBeTruthy();
  });

  it("should import a valid memory pack with credit deduction", async () => {
    const crypto = await import("crypto");
    const memories = [{
      memoryType: "episodic" as const,
      content: "imported memory",
      contentHash: crypto.createHash("sha256").update("imported memory").digest("hex"),
      importance: 0.5,
      tags: [],
      source: null,
      metadata: {},
    }];
    const packHash = crypto.createHash("sha256").update(JSON.stringify(memories)).digest("hex");

    const pack = {
      version: "1.0" as const,
      agentId: "other-agent",
      exportedAt: new Date().toISOString(),
      memories,
      packHash,
    };

    // Count query for cap check in store
    pool.query.mockResolvedValueOnce({ rows: [{ count: "5" }] });
    // Insert
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // Transfer log
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await service.importMemories(AGENT_ID, pack);
    expect(result.imported).toBe(1);
    expect(creditManager.deductCredits).toHaveBeenCalledWith(
      AGENT_ID, 25, expect.stringContaining("memory-import"), "memory_import",
    );
  });

  it("should reject packs with hash mismatch", async () => {
    const pack = {
      version: "1.0" as const,
      agentId: "other",
      exportedAt: new Date().toISOString(),
      memories: [{ memoryType: "episodic" as const, content: "x", contentHash: "x", importance: 0.5, tags: [], source: null, metadata: {} }],
      packHash: "wrong-hash",
    };

    await expect(service.importMemories(AGENT_ID, pack)).rejects.toThrow("hash mismatch");
  });
});

// ============================================================
//  Dream Cycle (Consolidation) Tests
// ============================================================

describe("AgentMemoryService — consolidation", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should skip if already processed today", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "existing" }] });

    const result = await service.consolidate(AGENT_ID);
    expect(result.memoriesProcessed).toBe(0);
    expect(result.summary).toContain("Already processed");
  });

  it("should consolidate episodic memories into semantic", async () => {
    // Idempotency check
    pool.query.mockResolvedValueOnce({ rows: [] });
    // Fetch episodic memories (4 with same tags)
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "e1", content: "event 1", tags: ["test"], access_count: 0 },
        { id: "e2", content: "event 2", tags: ["test"], access_count: 0 },
        { id: "e3", content: "event 3", tags: ["test"], access_count: 0 },
        { id: "e4", content: "event 4", tags: ["test"], access_count: 5 },
      ],
    });
    // Store calls for consolidated memories: cap check + insert for each
    for (let i = 0; i < 4; i++) {
      pool.query.mockResolvedValueOnce({ rows: [{ count: "10" }] }); // cap check
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: `c${i}`, agent_id: AGENT_ID, memory_type: "semantic",
          content: "consolidated", content_hash: "xyz", importance: 0.7,
          decay_rate: 0.1, access_count: 0, last_accessed_at: null,
          tags: ["consolidated"], source: "dream_cycle",
          parent_memory_id: null, metadata: {},
          created_at: "2026-03-04T00:00:00Z", updated_at: "2026-03-04T00:00:00Z",
        }],
      });
    }
    // Prune query
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    // Dream cycle log insert
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await service.consolidate(AGENT_ID);
    expect(result.method).toBe("algorithmic");
    expect(result.memoriesProcessed).toBe(4);
    expect(result.memoriesConsolidated).toBeGreaterThan(0);
  });
});

// ============================================================
//  Proof Tests
// ============================================================

describe("AgentMemoryService — proof", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should return content hash for existing memory", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ content_hash: "abc123", created_at: "2026-03-04T00:00:00Z" }],
    });

    const proof = await service.proveMemory(AGENT_ID, "mem-1");
    expect(proof?.contentHash).toBe("abc123");
  });

  it("should return null for non-existent memory", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const proof = await service.proveMemory(AGENT_ID, "missing");
    expect(proof).toBeNull();
  });
});

// ============================================================
//  SHA-256 Hash Consistency Tests
// ============================================================

describe("AgentMemoryService — hash consistency", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should generate consistent SHA-256 hashes for same content", async () => {
    const crypto = await import("crypto");
    const content = "Hello, world!";
    const expectedHash = crypto.createHash("sha256").update(content).digest("hex");

    pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    pool.query.mockImplementationOnce((_sql: string, params: any[]) => {
      // content_hash is the 4th param
      expect(params[3]).toBe(expectedHash);
      return {
        rows: [{
          id: "mem-1", agent_id: AGENT_ID, memory_type: "episodic",
          content, content_hash: expectedHash, importance: 0.5,
          decay_rate: 0.1, access_count: 0, last_accessed_at: null,
          tags: [], source: "experience", parent_memory_id: null,
          metadata: {}, created_at: "2026-03-04T00:00:00Z",
          updated_at: "2026-03-04T00:00:00Z",
        }],
      };
    });

    const result = await service.store(AGENT_ID, "episodic", content);
    expect(result.contentHash).toBe(expectedHash);
  });
});

// ============================================================
//  Delete Tests
// ============================================================

describe("AgentMemoryService — delete", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should delete an existing memory", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    const deleted = await service.deleteMemory(AGENT_ID, "mem-1");
    expect(deleted).toBe(true);
  });

  it("should return false for non-existent memory", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });
    const deleted = await service.deleteMemory(AGENT_ID, "missing");
    expect(deleted).toBe(false);
  });
});

// ============================================================
//  InitializeMemory Tests
// ============================================================

describe("AgentMemoryService — initializeMemory", () => {
  let pool: any;
  let service: AgentMemoryService;

  beforeEach(() => {
    pool = createMockPool();
    service = new AgentMemoryService(pool, null, null, TEST_CONFIG);
  });

  it("should seed self_model and semantic memories from soul doc", async () => {
    const soulDoc = {
      identity: { name: "TestBot", tagline: "A test agent" },
      personality: { traits: ["curious", "analytical"] },
      purpose: { mission: "Explore tests", domains: ["testing", "QA"] },
    };

    // Each store call: cap check + insert
    for (let i = 0; i < 4; i++) {
      pool.query.mockResolvedValueOnce({ rows: [{ count: "0" }] });
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: `init-${i}`, agent_id: AGENT_ID, memory_type: "self_model",
          content: "test", content_hash: "xyz", importance: 0.9,
          decay_rate: 0.1, access_count: 0, last_accessed_at: null,
          tags: [], source: "registration_init", parent_memory_id: null,
          metadata: {}, created_at: "2026-03-04T00:00:00Z",
          updated_at: "2026-03-04T00:00:00Z",
        }],
      });
    }

    await service.initializeMemory(AGENT_ID, soulDoc);
    // Should have stored 4 memories: name, traits, mission, domains
    expect(pool.query).toHaveBeenCalledTimes(8); // 4 * (cap check + insert)
  });
});
