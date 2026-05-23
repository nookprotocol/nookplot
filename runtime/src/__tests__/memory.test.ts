import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryBridge } from "../memory.js";
import * as signing from "../signing.js";

vi.mock("../signing.js", async () => {
  const actual = await vi.importActual<typeof import("../signing.js")>("../signing.js");
  return {
    ...actual,
    signForwardRequest: vi.fn().mockResolvedValue("0xSIGNED"),
  };
});

// ---------------------------------------------------------------------------
//  Mock ConnectionManager
// ---------------------------------------------------------------------------

function createMockConnection() {
  return {
    request: vi.fn(),
    privateKey: null as string | null,
  } as any;
}

describe("MemoryBridge — Agent Memory methods", () => {
  let conn: ReturnType<typeof createMockConnection>;
  let bridge: MemoryBridge;

  beforeEach(() => {
    conn = createMockConnection();
    bridge = new MemoryBridge(conn);
  });

  // -----------------------------------------------------------------------
  //  storeMemory
  // -----------------------------------------------------------------------

  describe("storeMemory", () => {
    it("POSTs to /v1/agent-memory/store with type and content", async () => {
      conn.request.mockResolvedValue({ id: "mem_1", type: "episodic" });

      const result = await bridge.storeMemory("episodic", "I saw a cat");

      expect(conn.request).toHaveBeenCalledWith("POST", "/v1/agent-memory/store", {
        type: "episodic",
        content: "I saw a cat",
      });
      expect(result.id).toBe("mem_1");
    });

    it("passes optional fields when provided", async () => {
      conn.request.mockResolvedValue({ id: "mem_2" });

      await bridge.storeMemory("semantic", "Cats are feline", {
        importance: 0.8,
        decayRate: 0.05,
        tags: ["animals", "facts"],
        source: "experience",
        parentMemoryId: "mem_0",
        metadata: { context: "learning" },
      });

      expect(conn.request).toHaveBeenCalledWith("POST", "/v1/agent-memory/store", {
        type: "semantic",
        content: "Cats are feline",
        importance: 0.8,
        decayRate: 0.05,
        tags: ["animals", "facts"],
        source: "experience",
        parentMemoryId: "mem_0",
        metadata: { context: "learning" },
      });
    });
  });

  // -----------------------------------------------------------------------
  //  recall
  // -----------------------------------------------------------------------

  describe("recall", () => {
    it("POSTs to /v1/agent-memory/recall with query", async () => {
      const memories = [{ id: "m1", content: "cat fact" }];
      conn.request.mockResolvedValue({ memories, count: 1 });

      const result = await bridge.recall("what do I know about cats?");

      expect(conn.request).toHaveBeenCalledWith("POST", "/v1/agent-memory/recall", {
        query: "what do I know about cats?",
      });
      expect(result.memories).toEqual(memories);
      expect(result.count).toBe(1);
    });

    it("passes optional filters", async () => {
      conn.request.mockResolvedValue({ memories: [], count: 0 });

      await bridge.recall("test", {
        types: ["semantic", "procedural"],
        limit: 5,
        minImportance: 0.3,
      });

      expect(conn.request).toHaveBeenCalledWith("POST", "/v1/agent-memory/recall", {
        query: "test",
        types: ["semantic", "procedural"],
        limit: 5,
        minImportance: 0.3,
      });
    });
  });

  // -----------------------------------------------------------------------
  //  listMemories
  // -----------------------------------------------------------------------

  describe("listMemories", () => {
    it("GETs /v1/agent-memory/list with no params by default", async () => {
      conn.request.mockResolvedValue({ memories: [], count: 0 });

      await bridge.listMemories();

      expect(conn.request).toHaveBeenCalledWith("GET", "/v1/agent-memory/list");
    });

    it("includes type, limit, and offset in query string", async () => {
      conn.request.mockResolvedValue({ memories: [], count: 0 });

      await bridge.listMemories("episodic", 10, 5);

      const [method, path] = conn.request.mock.calls[0];
      expect(method).toBe("GET");
      expect(path).toContain("type=episodic");
      expect(path).toContain("limit=10");
      expect(path).toContain("offset=5");
    });
  });

  // -----------------------------------------------------------------------
  //  getMemoryStats
  // -----------------------------------------------------------------------

  describe("getMemoryStats", () => {
    it("GETs /v1/agent-memory/stats", async () => {
      const stats = { totalMemories: 42 };
      conn.request.mockResolvedValue(stats);

      const result = await bridge.getMemoryStats();

      expect(conn.request).toHaveBeenCalledWith("GET", "/v1/agent-memory/stats");
      expect(result).toEqual(stats);
    });
  });

  // -----------------------------------------------------------------------
  //  exportMemories
  // -----------------------------------------------------------------------

  describe("exportMemories", () => {
    it("POSTs to /v1/agent-memory/export", async () => {
      const pack = { memories: [{ id: "m1" }], packHash: "abc" };
      conn.request.mockResolvedValue(pack);

      const result = await bridge.exportMemories();

      expect(conn.request).toHaveBeenCalledWith("POST", "/v1/agent-memory/export");
      expect(result).toEqual(pack);
    });
  });

  // -----------------------------------------------------------------------
  //  importMemories
  // -----------------------------------------------------------------------

  describe("importMemories", () => {
    it("POSTs pack to /v1/agent-memory/import", async () => {
      const pack = { memories: [{ id: "m1" }], packHash: "abc" };
      conn.request.mockResolvedValue({ imported: 1 });

      const result = await bridge.importMemories(pack);

      expect(conn.request).toHaveBeenCalledWith("POST", "/v1/agent-memory/import", pack);
      expect(result).toEqual({ imported: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
//  Existing MemoryBridge methods (smoke tests)
// ---------------------------------------------------------------------------

describe("MemoryBridge — existing methods", () => {
  let conn: ReturnType<typeof createMockConnection>;
  let bridge: MemoryBridge;

  beforeEach(() => {
    conn = createMockConnection();
    bridge = new MemoryBridge(conn);
    vi.clearAllMocks();
  });

  it("publishKnowledge relays with didCid when prepare response includes it", async () => {
    conn.privateKey = "0xabc";
    conn.request
      .mockResolvedValueOnce({
        cid: "QmPost",
        didCid: "QmDid",
        published: false,
        forwardRequest: { from: "0x1", to: "0x2", value: "0", gas: "1", nonce: "2", deadline: 3, data: "0x1234" },
        domain: { name: "Nook", version: "1", chainId: 8453, verifyingContract: "0x3" },
        types: { ForwardRequest: [] },
      })
      .mockResolvedValueOnce({ txHash: "0xTX", status: "ok" });

    const result = await bridge.publishKnowledge({ title: "T", body: "B", community: "engineering" });

    expect(signing.signForwardRequest).toHaveBeenCalled();
    expect(conn.request).toHaveBeenNthCalledWith(2, "POST", "/v1/relay", {
      from: "0x1",
      to: "0x2",
      value: "0",
      gas: "1",
      nonce: "2",
      deadline: 3,
      data: "0x1234",
      signature: "0xSIGNED",
      didCid: "QmDid",
    });
    expect(result).toEqual({ cid: "QmPost", txHash: "0xTX" });
  });

  it("publishComment relays with didCid when prepare response includes it", async () => {
    conn.privateKey = "0xabc";
    conn.request
      .mockResolvedValueOnce({
        cid: "QmComment",
        didCid: "QmDid",
        published: false,
        forwardRequest: { from: "0x1", to: "0x2", value: "0", gas: "1", nonce: "2", deadline: 3, data: "0x5678" },
        domain: { name: "Nook", version: "1", chainId: 8453, verifyingContract: "0x3" },
        types: { ForwardRequest: [] },
      })
      .mockResolvedValueOnce({ txHash: "0xTX2", status: "ok" });

    const result = await bridge.publishComment({ body: "B", community: "engineering", parentCid: "QmParent" });

    expect(signing.signForwardRequest).toHaveBeenCalled();
    expect(conn.request).toHaveBeenNthCalledWith(2, "POST", "/v1/relay", {
      from: "0x1",
      to: "0x2",
      value: "0",
      gas: "1",
      nonce: "2",
      deadline: 3,
      data: "0x5678",
      signature: "0xSIGNED",
      didCid: "QmDid",
    });
    expect(result).toEqual({ cid: "QmComment", txHash: "0xTX2" });
  });

  it("queryKnowledge sends POST to /v1/memory/query", async () => {
    conn.request.mockResolvedValue({ items: [] });
    await bridge.queryKnowledge({ community: "test" });
    expect(conn.request).toHaveBeenCalledWith("POST", "/v1/memory/query", { community: "test" });
  });

  it("syncFromNetwork sends GET with params", async () => {
    conn.request.mockResolvedValue({ items: [], cursor: "t1", hasMore: false });
    await bridge.syncFromNetwork("t0", { community: "ai", limit: 10 });
    const [method, path] = conn.request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toContain("since=t0");
    expect(path).toContain("community=ai");
    expect(path).toContain("limit=10");
  });

  it("getExpertise sends GET with topic", async () => {
    conn.request.mockResolvedValue({ experts: [], topic: "ml" });
    await bridge.getExpertise("ml", 5);
    const [method, path] = conn.request.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toContain("/v1/memory/expertise/ml");
    expect(path).toContain("limit=5");
  });

  it("getReputation sends GET for self", async () => {
    conn.request.mockResolvedValue({ score: 0.5 });
    await bridge.getReputation();
    expect(conn.request).toHaveBeenCalledWith("GET", "/v1/memory/reputation");
  });

  it("getReputation sends GET for specific address", async () => {
    conn.request.mockResolvedValue({ score: 0.7 });
    await bridge.getReputation("0xabc");
    expect(conn.request).toHaveBeenCalledWith("GET", "/v1/memory/reputation/0xabc");
  });

  it("listCommunities sends GET", async () => {
    conn.request.mockResolvedValue({ communities: [], default: "general" });
    await bridge.listCommunities(10);
    expect(conn.request).toHaveBeenCalledWith("GET", "/v1/memory/communities?limit=10");
  });

  it("semanticQuery sends POST to /v1/knowledge/query", async () => {
    conn.request.mockResolvedValue({ results: [], totalResults: 0 });
    await bridge.semanticQuery({ query: "test", limit: 5 });
    expect(conn.request).toHaveBeenCalledWith("POST", "/v1/knowledge/query", { query: "test", limit: 5 });
  });
});
