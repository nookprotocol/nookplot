import { describe, it, expect, vi } from "vitest";
import { OnChainSync } from "./onChainSync.js";
import { createMockPool } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockIpfs() {
  return {
    uploadJson: vi.fn().mockResolvedValue({ cid: "bafybreakdown123" }),
  };
}

function createMockRegistry() {
  return {
    batchSetScores: vi.fn().mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xtxhash1" }),
    }),
    setExpertiseTags: vi.fn().mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ hash: "0xtagtx1" }),
    }),
  };
}

function createContributionRow(overrides?: Record<string, unknown>) {
  return {
    id: "cs-1",
    agent_id: "agt_test",
    address: "0x1111111111111111111111111111111111111111",
    overall_score: 75,
    commits_score: 20,
    exec_score: 15,
    projects_score: 10,
    lines_score: 20,
    collab_score: 10,
    computed_at: new Date("2025-06-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  runSyncCycle
// ---------------------------------------------------------------------------

describe("OnChainSync.runSyncCycle", () => {
  it("returns early when no scores need syncing", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    const registry = createMockRegistry();
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await sync.runSyncCycle();

    expect(result.agentsSynced).toBe(0);
    expect(result.txHashes).toHaveLength(0);
    expect(registry.batchSetScores).not.toHaveBeenCalled();
  });

  it("syncs single agent: IPFS upload, on-chain batch, expertise tags", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    const registry = createMockRegistry();
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    const row = createContributionRow();

    // 1. Query un-synced scores
    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    // 2. IPFS upload → UPDATE breakdown_cid
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // 3. batchSetScores → UPDATE synced_at for the agent
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // 4. Query expertise tags
    pool.query.mockResolvedValueOnce({
      rows: [
        { agent_id: "agt_test", address: "0x1111111111111111111111111111111111111111", tag: "typescript", confidence: 0.9 },
        { agent_id: "agt_test", address: "0x1111111111111111111111111111111111111111", tag: "solidity", confidence: 0.7 },
      ],
      rowCount: 2,
    });

    const result = await sync.runSyncCycle();

    expect(result.agentsSynced).toBe(1);
    expect(result.txHashes).toContain("0xtxhash1");
    expect(result.txHashes).toContain("0xtagtx1");

    // Verify IPFS upload was called with correct breakdown
    expect(ipfs.uploadJson).toHaveBeenCalledOnce();
    const uploadCall = ipfs.uploadJson.mock.calls[0];
    expect(uploadCall[0].agentAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(uploadCall[0].overallScore).toBe(75);
    expect(uploadCall[0].components.commits).toBe(20);

    // Verify batchSetScores called with correct arrays
    expect(registry.batchSetScores).toHaveBeenCalledWith(
      ["0x1111111111111111111111111111111111111111"],
      [75],
      ["bafybreakdown123"],
    );

    // Verify setExpertiseTags called with tags + confidences in basis points
    expect(registry.setExpertiseTags).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      ["typescript", "solidity"],
      [9000, 7000], // 0.9 * 10000, 0.7 * 10000
    );
  });

  it("syncs multiple agents in a single batch", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    const registry = createMockRegistry();
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    const row1 = createContributionRow({ agent_id: "agt_1", address: "0x1111111111111111111111111111111111111111", overall_score: 90 });
    const row2 = createContributionRow({ agent_id: "agt_2", address: "0x2222222222222222222222222222222222222222", overall_score: 60 });

    // Query un-synced
    pool.query.mockResolvedValueOnce({ rows: [row1, row2], rowCount: 2 });
    // IPFS uploads + UPDATE breakdown_cid (one per agent)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // cid for agt_1
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // cid for agt_2
    // batchSetScores → UPDATE synced_at for each
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // agt_1
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // agt_2
    // Query expertise tags (none)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await sync.runSyncCycle();

    expect(result.agentsSynced).toBe(2);
    expect(ipfs.uploadJson).toHaveBeenCalledTimes(2);
    expect(registry.batchSetScores).toHaveBeenCalledWith(
      ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
      [90, 60],
      ["bafybreakdown123", "bafybreakdown123"],
    );
  });

  it("continues when IPFS upload fails for one agent", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    ipfs.uploadJson.mockRejectedValueOnce(new Error("IPFS timeout"));
    const registry = createMockRegistry();
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    const row = createContributionRow();

    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    // No UPDATE breakdown_cid since IPFS failed
    // batchSetScores (with empty CID since IPFS failed)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // synced_at update
    // Tags query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await sync.runSyncCycle();

    expect(result.agentsSynced).toBe(1);
    // CID should be empty string when IPFS failed
    expect(registry.batchSetScores).toHaveBeenCalledWith(
      ["0x1111111111111111111111111111111111111111"],
      [75],
      [""], // empty CID
    );
  });

  it("continues when batchSetScores fails for a batch", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    const registry = createMockRegistry();
    registry.batchSetScores.mockRejectedValueOnce(new Error("Gas limit exceeded"));
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    const row = createContributionRow();

    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // breakdown_cid
    // Tags query (batchSetScores failed but sync continues)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await sync.runSyncCycle();

    expect(result.agentsSynced).toBe(0); // no agents synced due to batch failure
    expect(result.txHashes).toHaveLength(0);
  });

  it("continues when setExpertiseTags fails", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    const registry = createMockRegistry();
    registry.setExpertiseTags.mockRejectedValueOnce(new Error("tx reverted"));
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    const row = createContributionRow();

    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // breakdown_cid
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // synced_at
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_test", address: "0x1111111111111111111111111111111111111111", tag: "python", confidence: 0.8 }],
      rowCount: 1,
    });

    const result = await sync.runSyncCycle();

    // Scores synced even though tags failed
    expect(result.agentsSynced).toBe(1);
    expect(result.txHashes).toContain("0xtxhash1");
    // No tag tx hash since it failed
    expect(result.txHashes).not.toContain("0xtagtx1");
  });

  it("handles agents with no expertise tags", async () => {
    const pool = createMockPool();
    const ipfs = createMockIpfs();
    const registry = createMockRegistry();
    const sync = new OnChainSync(pool as any, ipfs as any, registry as any);

    const row = createContributionRow();

    pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // breakdown_cid
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // synced_at
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no tags

    const result = await sync.runSyncCycle();

    expect(result.agentsSynced).toBe(1);
    expect(registry.setExpertiseTags).not.toHaveBeenCalled();
  });
});
