import { describe, it, expect, vi } from "vitest";
import { PedigreeService } from "./pedigreeService.js";
import { createMockPool } from "../test/helpers.js";

const TEST_ADDRESS = "0xabcdef1234567890abcdef1234567890abcdef12";

// ---------------------------------------------------------------------------
//  computePedigree — no deployment
// ---------------------------------------------------------------------------

describe("PedigreeService — no deployment", () => {
  it("returns null pedigree when no deployment found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    expect(result.pedigree).toBeNull();
    expect(result.bundleQuality).toBeNull();
    expect(result.isSpawn).toBe(false);
    expect(result.contributors).toHaveLength(0);
    expect(result.ancestors).toHaveLength(0);
  });

  it("returns null when deployment has no bundle", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ parent_agent: null, is_spawn: false, bundle_id: null }],
      rowCount: 1,
    });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    expect(result.pedigree).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  computePedigree — non-spawn agent (bundle only)
// ---------------------------------------------------------------------------

describe("PedigreeService — non-spawn (bundle only)", () => {
  it("computes pedigree from bundle quality", async () => {
    const pool = createMockPool();

    // Deployment
    pool.query.mockResolvedValueOnce({
      rows: [{ parent_agent: null, is_spawn: false, bundle_id: "1" }],
      rowCount: 1,
    });
    // Bundle info
    pool.query.mockResolvedValueOnce({
      rows: [{ bundle_id: "1", name: "TestBundle" }],
      rowCount: 1,
    });
    // Contributors
    pool.query.mockResolvedValueOnce({
      rows: [
        { contributor_id: "0xcontrib1", weight_bps: 6000 },
        { contributor_id: "0xcontrib2", weight_bps: 4000 },
      ],
      rowCount: 2,
    });
    // Contribution scores batch
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "0xcontrib1", score: 5000 },
        { id: "0xcontrib2", score: 3000 },
      ],
      rowCount: 2,
    });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    expect(result.isSpawn).toBe(false);
    expect(result.bundle).toEqual({ bundleId: "1", name: "TestBundle" });
    expect(result.contributors).toHaveLength(2);
    expect(result.lineageQuality).toBeNull();
    expect(result.ancestors).toHaveLength(0);

    // bundleQuality = (5000*6000 + 3000*4000) / 10000 / 100 = (30000000 + 12000000) / 10000 / 100 = 42
    expect(result.bundleQuality).toBeCloseTo(42, 0);
    // Non-spawn: pedigree = bundleQuality
    expect(result.pedigree).toBeCloseTo(42, 0);
  });

  it("clamps pedigree to 0-100 range", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [{ parent_agent: null, is_spawn: false, bundle_id: "1" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ bundle_id: "1", name: "Bundle" }],
      rowCount: 1,
    });
    // Single contributor with max score
    pool.query.mockResolvedValueOnce({
      rows: [{ contributor_id: "0xmax", weight_bps: 10000 }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "0xmax", score: 10000 }],
      rowCount: 1,
    });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    // bundleQuality = (10000*10000) / 10000 / 100 = 100
    expect(result.bundleQuality).toBe(100);
    expect(result.pedigree).toBe(100);
  });
});

// ---------------------------------------------------------------------------
//  computePedigree — spawn agent (bundle + lineage)
// ---------------------------------------------------------------------------

describe("PedigreeService — spawn (bundle + lineage)", () => {
  it("computes combined pedigree with lineage walk", async () => {
    const pool = createMockPool();

    // Deployment (is_spawn = true)
    pool.query.mockResolvedValueOnce({
      rows: [{ parent_agent: "0xparent", is_spawn: true, bundle_id: "1" }],
      rowCount: 1,
    });
    // Bundle info
    pool.query.mockResolvedValueOnce({
      rows: [{ bundle_id: "1", name: "SpawnBundle" }],
      rowCount: 1,
    });
    // Contributors — empty for simplicity (bundleQuality = 0)
    // fetchContributionScores skips query when addresses is empty, so no mock needed
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Lineage walk — generation 1
    pool.query.mockResolvedValueOnce({
      rows: [{ parent_id: "0xparent" }],
      rowCount: 1,
    });
    // Lineage walk — generation 2 (no further parent)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // fetchContributionScores for ancestors
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "0xparent", score: 8000 }],
      rowCount: 1,
    });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    expect(result.isSpawn).toBe(true);
    expect(result.ancestors).toHaveLength(1);
    expect(result.ancestors[0].address).toBe("0xparent");
    expect(result.ancestors[0].generation).toBe(1);
    expect(result.lineageQuality).not.toBeNull();
    // lineageQuality = (8000/100) * 0.6^1 = 80 * 0.6 = 48
    expect(result.lineageQuality).toBeCloseTo(48, 0);
    // pedigree = 0 * 0.6 + 48 * 0.4 = 19.2
    expect(result.pedigree).toBeCloseTo(19.2, 0);
  });

  it("stops lineage walk at 5 generations", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [{ parent_agent: "0xp1", is_spawn: true, bundle_id: "1" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ bundle_id: "1", name: "Bundle" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // contributors (empty → no score query)

    // 5 generations of parents
    for (let i = 1; i <= 5; i++) {
      pool.query.mockResolvedValueOnce({
        rows: [{ parent_id: `0xp${i + 1}` }],
        rowCount: 1,
      });
    }

    // Ancestor contribution scores
    pool.query.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: `0xp${i + 2}`,
        score: 5000,
      })),
      rowCount: 5,
    });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    expect(result.ancestors).toHaveLength(5);
  });

  it("detects cycles in lineage walk", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({
      rows: [{ parent_agent: "0xparent", is_spawn: true, bundle_id: "1" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ bundle_id: "1", name: "Bundle" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // contributors (empty → no score query)

    // Generation 1: parent
    pool.query.mockResolvedValueOnce({
      rows: [{ parent_id: "0xparent" }],
      rowCount: 1,
    });
    // Generation 2: points back to self (cycle) — would be caught by visited set
    // But 0xparent is already visited after gen 1, so the mock for gen 2 pointing back
    // to the test address would stop. The code uses visited set.
    // Actually, first it visits normalizedAddr, then 0xparent → next query for 0xparent:
    pool.query.mockResolvedValueOnce({
      rows: [{ parent_id: TEST_ADDRESS.toLowerCase() }], // cycle back to original
      rowCount: 1,
    });

    // Ancestor scores
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "0xparent", score: 5000 }],
      rowCount: 1,
    });

    const svc = new PedigreeService(pool as any);
    const result = await svc.computePedigree(TEST_ADDRESS);

    // Only 1 ancestor (cycle detected at generation 2)
    expect(result.ancestors).toHaveLength(1);
  });
});
