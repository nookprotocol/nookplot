import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileManager } from "../fileManager.js";

// ============================================================
//  Mock pool
// ============================================================

function createMockPool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  } as any;
}

// ============================================================
//  Fixtures
// ============================================================

const SRC_PROJECT = {
  id: "uuid-src-001",
  project_id: "my-cool-project",
  name: "My Cool Project",
  description: "desc",
  languages: ["typescript"],
  tags: ["test"],
  license: "MIT",
};

const AGENT_ID = "agent-001";
const AGENT_ADDR = "0xABC123";

// ============================================================
//  Tests
// ============================================================

describe("FileManager fork/merge project lookup fallback", () => {
  let pool: ReturnType<typeof createMockPool>;
  let fm: FileManager;

  beforeEach(() => {
    pool = createMockPool();
    fm = new FileManager(pool);
  });

  // ── forkProject ──

  describe("forkProject", () => {
    it("finds project by exact slug on first query", async () => {
      // First query returns the project
      pool.query.mockResolvedValueOnce({ rows: [SRC_PROJECT] });
      // Slug uniqueness check
      pool.query.mockResolvedValueOnce({ rows: [] });

      // Transaction queries
      const client = pool._client;
      client.query.mockResolvedValueOnce(undefined); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ id: "fork-uuid", created_at: new Date() }] }); // INSERT project
      client.query.mockResolvedValueOnce({ rowCount: 3 }); // Copy files
      client.query.mockResolvedValueOnce(undefined); // Update fork_count
      client.query.mockResolvedValueOnce({ rows: [{ id: "commit-uuid" }] }); // Insert commit
      client.query.mockResolvedValueOnce(undefined); // Activity on source
      client.query.mockResolvedValueOnce(undefined); // Activity on fork
      client.query.mockResolvedValueOnce(undefined); // commit_log
      client.query.mockResolvedValueOnce(undefined); // COMMIT

      const result = await fm.forkProject("my-cool-project", AGENT_ID, AGENT_ADDR);

      expect(result.forkedFrom).toBe("my-cool-project");
      expect(result.filesCount).toBe(3);
      // Only 2 pool.query calls: exact match + slug uniqueness
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("falls back to case-insensitive slug match", async () => {
      // First query (exact) returns nothing
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Second query (ILIKE/LOWER) returns the project
      pool.query.mockResolvedValueOnce({ rows: [SRC_PROJECT] });
      // Slug uniqueness check
      pool.query.mockResolvedValueOnce({ rows: [] });

      const client = pool._client;
      client.query.mockResolvedValueOnce(undefined); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ id: "fork-uuid", created_at: new Date() }] });
      client.query.mockResolvedValueOnce({ rowCount: 2 });
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce({ rows: [{ id: "commit-uuid" }] });
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce(undefined);

      const result = await fm.forkProject("My-Cool-Project", AGENT_ID, AGENT_ADDR);

      expect(result.forkedFrom).toBe("My-Cool-Project");
      // 3 pool.query calls: exact miss + case-insensitive hit + slug uniqueness
      expect(pool.query).toHaveBeenCalledTimes(3);
      const secondCall = pool.query.mock.calls[1];
      expect(secondCall[0]).toContain("LOWER");
    });

    it("falls back to UUID match", async () => {
      // First two queries return nothing
      pool.query.mockResolvedValueOnce({ rows: [] }); // exact
      pool.query.mockResolvedValueOnce({ rows: [] }); // case-insensitive
      // Third query (UUID) returns the project
      pool.query.mockResolvedValueOnce({ rows: [SRC_PROJECT] });
      // Slug uniqueness check
      pool.query.mockResolvedValueOnce({ rows: [] });

      const client = pool._client;
      client.query.mockResolvedValueOnce(undefined); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ id: "fork-uuid", created_at: new Date() }] });
      client.query.mockResolvedValueOnce({ rowCount: 1 });
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce({ rows: [{ id: "commit-uuid" }] });
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce(undefined);
      client.query.mockResolvedValueOnce(undefined);

      const result = await fm.forkProject("uuid-src-001", AGENT_ID, AGENT_ADDR);

      // 4 pool.query calls: exact miss + case-insensitive miss + UUID hit + slug uniqueness
      expect(pool.query).toHaveBeenCalledTimes(4);
      const thirdCall = pool.query.mock.calls[2];
      expect(thirdCall[0]).toContain("id::text");
    });

    it("throws descriptive error when all lookups fail", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // exact
      pool.query.mockResolvedValueOnce({ rows: [] }); // case-insensitive
      pool.query.mockResolvedValueOnce({ rows: [] }); // UUID

      await expect(fm.forkProject("nonexistent", AGENT_ID, AGENT_ADDR))
        .rejects.toThrow('Source project not found: "nonexistent"');
    });

    it("error message suggests using slug format", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      pool.query.mockResolvedValueOnce({ rows: [] });
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(fm.forkProject("My Display Name", AGENT_ID, AGENT_ADDR))
        .rejects.toThrow("lowercase-with-hyphens");
    });
  });

  // ── createMergeRequest ──

  describe("createMergeRequest", () => {
    const FORK_PROJECT = {
      ...SRC_PROJECT,
      id: "uuid-fork-001",
      project_id: "my-cool-project-fork-abc123",
      name: "Fork of My Cool Project",
      forked_from: "uuid-src-001",
      target_slug: "my-cool-project",
      target_name: "My Cool Project",
    };

    // Helper to add the common tail queries for createMergeRequest
    function mockMrTail() {
      pool.query.mockResolvedValueOnce({ rows: [{ id: "c1" }] }); // verify commits
      pool.query.mockResolvedValueOnce({ rows: [] }); // no existing open MR
      pool.query.mockResolvedValueOnce({ rows: [{ id: "mr-001", created_at: new Date(), updated_at: new Date() }] }); // insert MR
      pool.query.mockResolvedValueOnce({ rows: [{ address: AGENT_ADDR, display_name: "Test" }] }); // author lookup
      pool.query.mockResolvedValueOnce(undefined); // activity insert
    }

    it("finds fork by exact slug on first query", async () => {
      pool.query.mockResolvedValueOnce({ rows: [FORK_PROJECT] }); // exact match
      mockMrTail();

      const result = await fm.createMergeRequest(
        "my-cool-project-fork-abc123", AGENT_ID, "My PR", null, ["c1"],
      );

      expect(result.id).toBe("mr-001");
      // 1 lookup + 5 tail queries
      expect(pool.query).toHaveBeenCalledTimes(6);
    });

    it("falls back to case-insensitive lookup for merge request", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // exact miss
      pool.query.mockResolvedValueOnce({ rows: [FORK_PROJECT] }); // case-insensitive hit
      mockMrTail();

      const result = await fm.createMergeRequest(
        "My-Cool-Project-Fork-Abc123", AGENT_ID, "My PR", null, ["c1"],
      );

      expect(result.id).toBe("mr-001");
      const secondCall = pool.query.mock.calls[1];
      expect(secondCall[0]).toContain("LOWER");
    });

    it("falls back to UUID lookup for merge request", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // exact
      pool.query.mockResolvedValueOnce({ rows: [] }); // case-insensitive
      pool.query.mockResolvedValueOnce({ rows: [FORK_PROJECT] }); // UUID
      mockMrTail();

      const result = await fm.createMergeRequest(
        "uuid-fork-001", AGENT_ID, "My PR", null, ["c1"],
      );

      expect(result.id).toBe("mr-001");
      const thirdCall = pool.query.mock.calls[2];
      expect(thirdCall[0]).toContain("id::text");
    });

    it("throws descriptive error when fork not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      pool.query.mockResolvedValueOnce({ rows: [] });
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(fm.createMergeRequest("nope", AGENT_ID, "PR", null, ["c1"]))
        .rejects.toThrow('Source project not found: "nope"');
    });

    it("rejects missing title", async () => {
      await expect(fm.createMergeRequest("proj", AGENT_ID, "", null, ["c1"]))
        .rejects.toThrow("Title is required");
    });

    it("rejects empty commitIds", async () => {
      await expect(fm.createMergeRequest("proj", AGENT_ID, "PR", null, []))
        .rejects.toThrow("At least one commit");
    });
  });
});
