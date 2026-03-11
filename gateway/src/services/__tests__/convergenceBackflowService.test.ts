import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../../test/helpers.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const { ConvergenceBackflowService } = await import("../convergenceBackflowService.js");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createService(pool?: ReturnType<typeof createMockPool>) {
  const p = pool ?? createMockPool();
  const service = new ConvergenceBackflowService(p as any);
  return { service, pool: p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  listConvergenceVerified
// ---------------------------------------------------------------------------

describe("ConvergenceBackflowService.listConvergenceVerified", () => {
  it("returns paginated results", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query
      // count query
      .mockResolvedValueOnce({ rows: [{ total: 2 }], rowCount: 1 })
      // data query
      .mockResolvedValueOnce({
        rows: [
          {
            resource_id: "r1",
            external_id: "researchhub:123",
            source_platform: "researchhub",
            title: "Paper A",
            url: "https://researchhub.com/paper/123",
            chain_count: 5,
            unique_agents: 4,
            convergence_score: 75,
            first_verified: "2025-01-01T00:00:00Z",
            last_updated: "2025-03-01T00:00:00Z",
            chain_details: [],
          },
        ],
        rowCount: 1,
      });

    const result = await service.listConvergenceVerified({ page: 1, limit: 10 });

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].externalId).toBe("researchhub:123");
    expect(result.resources[0].convergenceScore).toBe(75);
    expect(result.pagination.total).toBe(2);
  });

  it("filters by platform", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await service.listConvergenceVerified({ platform: "researchhub" });

    // The count query should have the platform filter
    const countQuery = pool.query.mock.calls[0][0];
    expect(countQuery).toContain("source_platform = $");
    expect(pool.query.mock.calls[0][1]).toContain("researchhub");
  });

  it("filters by minimum score", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await service.listConvergenceVerified({ minScore: 50 });

    const countQuery = pool.query.mock.calls[0][0];
    expect(countQuery).toContain("convergence_score >= $");
    expect(pool.query.mock.calls[0][1]).toContain(50);
  });
});

// ---------------------------------------------------------------------------
//  getConvergenceByExternalId
// ---------------------------------------------------------------------------

describe("ConvergenceBackflowService.getConvergenceByExternalId", () => {
  it("returns record for known external ID", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        resource_id: "r1",
        external_id: "arxiv:2301.12345",
        source_platform: "arxiv",
        title: "Test Paper",
        url: "https://arxiv.org/abs/2301.12345",
        chain_count: 3,
        unique_agents: 3,
        convergence_score: 60,
        first_verified: "2025-01-01",
        last_updated: "2025-03-01",
        chain_details: [{ agentId: "a1", agentName: "researcher-1" }],
      }],
      rowCount: 1,
    });

    const result = await service.getConvergenceByExternalId("arxiv:2301.12345");

    expect(result).not.toBeNull();
    expect(result!.externalId).toBe("arxiv:2301.12345");
    expect(result!.chainCount).toBe(3);
  });

  it("returns null for unknown external ID", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await service.getConvergenceByExternalId("nonexistent:999");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getStats
// ---------------------------------------------------------------------------

describe("ConvergenceBackflowService.getStats", () => {
  it("returns aggregate statistics", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query
      // total
      .mockResolvedValueOnce({ rows: [{ total: 15 }], rowCount: 1 })
      // byPlatform
      .mockResolvedValueOnce({
        rows: [
          { source_platform: "researchhub", cnt: 8 },
          { source_platform: "arxiv", cnt: 7 },
        ],
        rowCount: 2,
      })
      // averages
      .mockResolvedValueOnce({
        rows: [{ avg_chains: 4.2, avg_score: 55.3 }],
        rowCount: 1,
      })
      // top verified
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const stats = await service.getStats();

    expect(stats.totalVerifiedResources).toBe(15);
    expect(stats.byPlatform.researchhub).toBe(8);
    expect(stats.byPlatform.arxiv).toBe(7);
    expect(stats.avgChainCount).toBeCloseTo(4.2, 1);
  });
});

// ---------------------------------------------------------------------------
//  recompute
// ---------------------------------------------------------------------------

describe("ConvergenceBackflowService.recompute", () => {
  it("returns 0 when no resources qualify", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const count = await service.recompute();
    expect(count).toBe(0);
  });

  it("upserts convergence data for qualifying resources", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    // Main query: resources with >= 2 distinct agents
    pool.query.mockResolvedValueOnce({
      rows: [{
        resource_id: "r1",
        external_id: "researchhub:999",
        source_type: "researchhub_paper",
        title: "Multi-cited paper",
        url: "https://researchhub.com/paper/999",
        chain_count: 5,
        unique_agents: 3,
        avg_quality: 45,
      }],
      rowCount: 1,
    });

    // Chain details for r1
    pool.query.mockResolvedValueOnce({
      rows: [
        { agent_id: "a1", display_name: "Agent 1", source_id: "s1", citation_pattern: "researchhub:999", created_at: "2025-01-01" },
        { agent_id: "a2", display_name: "Agent 2", source_id: "s2", citation_pattern: "researchhub:999", created_at: "2025-01-02" },
      ],
      rowCount: 2,
    });

    // Upsert query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const count = await service.recompute();
    expect(count).toBe(1);

    // Verify upsert was called with correct params
    const upsertCall = pool.query.mock.calls[2];
    expect(upsertCall[0]).toContain("convergence_backflow");
    expect(upsertCall[0]).toContain("ON CONFLICT");
    expect(upsertCall[1]).toContain("r1"); // resource_id
    expect(upsertCall[1]).toContain("researchhub:999"); // external_id
    expect(upsertCall[1]).toContain("researchhub"); // platform
  });
});
