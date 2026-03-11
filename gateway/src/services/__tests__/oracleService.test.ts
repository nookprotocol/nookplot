import { describe, it, expect, vi, beforeEach } from "vitest";
import { OracleService } from "../oracleService.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockWallet() {
  return {
    signTypedData: vi.fn().mockResolvedValue("0xmocksignature"),
    address: "0xRelayerAddress",
    provider: {
      getBlockNumber: vi.fn().mockResolvedValue(12345678),
    },
  } as any;
}

function createMockProvider() {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(12345678),
  } as any;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_ID = "project-1";
const AGENT_ADDRESS = "0x1234567890123456789012345678901234567890";
const INTENT_ID = "intent-1";
const GUILD_ID = "guild-1";
const CHAIN_ID = 8453;

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService(opts?: { noWallet?: boolean }) {
  const pool = createMockPool();
  const wallet = opts?.noWallet ? null : createMockWallet();
  const provider = createMockProvider();
  const service = new OracleService(pool, wallet, provider, CHAIN_ID);
  return { pool, wallet, provider, service };
}

/** Stub pool.query to resolve sequentially for the INSERT snapshot persist. */
function stubSnapshotPersist(pool: any) {
  pool.query.mockResolvedValueOnce({ rowCount: 1 }); // INSERT INTO oracle_snapshots
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("OracleService", () => {

  // ─── getProjectSignals ────────────────────────────────────────

  describe("getProjectSignals", () => {
    it("returns signed snapshot with all project signals", async () => {
      const { pool, wallet, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ name: "TestProject", status: "active", created_at: "2025-01-01" }] })
        .mockResolvedValueOnce({ rows: [{ total: "5", completed: "3" }] })
        .mockResolvedValueOnce({ rows: [{ avg_score: "72" }] })
        .mockResolvedValueOnce({ rows: [{ count: "4" }] })
        .mockResolvedValueOnce({ rows: [{ total: "10", completed: "7" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getProjectSignals(PROJECT_ID);

      expect(snapshot.entityType).toBe("project");
      expect(snapshot.entityId).toBe(PROJECT_ID);
      expect(snapshot.signals.name).toBe("TestProject");
      expect(snapshot.signals.status).toBe("active");
      expect(snapshot.signals.milestonesTotal).toBe(5);
      expect(snapshot.signals.milestonesCompleted).toBe(3);
      expect(snapshot.signals.qualityScore).toBe(72);
      expect(snapshot.signals.contributorCount).toBe(4);
      expect(snapshot.signals.bountiesTotal).toBe(10);
      expect(snapshot.signals.bountiesCompleted).toBe(7);
      expect(snapshot.signature).toBe("0xmocksignature");
      expect(snapshot.blockNumber).toBe(12345678);
      expect(snapshot.dataHash).toMatch(/^0x/);
      expect(wallet.signTypedData).toHaveBeenCalledOnce();
    });

    it("throws when project not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.getProjectSignals("nonexistent")).rejects.toThrow("Project not found");
    });
  });

  // ─── getAgentSignals ──────────────────────────────────────────

  describe("getAgentSignals", () => {
    it("returns signed snapshot with all agent signals", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: "a-001", display_name: "TestAgent", created_at: "2025-01-01" }] })
        .mockResolvedValueOnce({ rows: [{ total_score: "1500", velocity_multiplier: "1.2" }] })
        .mockResolvedValueOnce({ rows: [{ completed: "3", total_claimed: "2" }] })
        .mockResolvedValueOnce({ rows: [{ total: "8", completed: "5" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getAgentSignals(AGENT_ADDRESS);

      expect(snapshot.entityType).toBe("agent");
      expect(snapshot.entityId).toBe(AGENT_ADDRESS.toLowerCase());
      expect(snapshot.signals.displayName).toBe("TestAgent");
      expect(snapshot.signals.contributionScore).toBe(1500);
      expect(snapshot.signals.velocityMultiplier).toBe(1.2);
      expect(snapshot.signals.bountiesCompleted).toBe(3);
      expect(snapshot.signals.agreementsTotal).toBe(8);
      expect(snapshot.signals.agreementsSettled).toBe(5);
      expect(snapshot.signature).toBe("0xmocksignature");
    });

    it("normalizes address to lowercase", async () => {
      const { pool, service } = createService();
      const mixedCase = "0xAbCdEf1234567890123456789012345678901234";
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: "a-001", display_name: null, created_at: "2025-01-01" }] })
        .mockResolvedValueOnce({ rows: [{ total_score: "0", velocity_multiplier: "1.0" }] })
        .mockResolvedValueOnce({ rows: [{ completed: "0", total_claimed: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", completed: "0" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getAgentSignals(mixedCase);

      expect(snapshot.entityId).toBe(mixedCase.toLowerCase());
    });

    it("throws when agent not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.getAgentSignals(AGENT_ADDRESS)).rejects.toThrow("Agent not found");
    });
  });

  // ─── getIntentSignals ─────────────────────────────────────────

  describe("getIntentSignals", () => {
    it("returns signed snapshot with intent signals", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ title: "Build API", status: "open", created_at: "2025-02-01", budget_amount: "500" }] })
        .mockResolvedValueOnce({ rows: [{ total: "3", accepted: "1", rejected: "1" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getIntentSignals(INTENT_ID);

      expect(snapshot.entityType).toBe("intent");
      expect(snapshot.entityId).toBe(INTENT_ID);
      expect(snapshot.signals.title).toBe("Build API");
      expect(snapshot.signals.status).toBe("open");
      expect(snapshot.signals.budgetAmount).toBe(500);
      expect(snapshot.signals.proposalCount).toBe(3);
      expect(snapshot.signals.proposalsAccepted).toBe(1);
      expect(snapshot.signals.proposalsRejected).toBe(1);
      expect(snapshot.signature).toBe("0xmocksignature");
    });

    it("throws when intent not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.getIntentSignals("nonexistent")).rejects.toThrow("Intent not found");
    });
  });

  // ─── getGuildSignals ──────────────────────────────────────────

  describe("getGuildSignals", () => {
    it("returns signed snapshot with guild signals", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ name: "Alpha Guild", member_count: "12" }] })
        .mockResolvedValueOnce({ rows: [{ balance: "50000" }] })
        .mockResolvedValueOnce({ rows: [{ count: "3" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getGuildSignals(GUILD_ID);

      expect(snapshot.entityType).toBe("guild");
      expect(snapshot.entityId).toBe(GUILD_ID);
      expect(snapshot.signals.name).toBe("Alpha Guild");
      expect(snapshot.signals.memberCount).toBe(12);
      expect(snapshot.signals.treasuryBalance).toBe(50000);
      expect(snapshot.signals.projectCount).toBe(3);
      expect(snapshot.signature).toBe("0xmocksignature");
    });

    it("throws when guild not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.getGuildSignals("nonexistent")).rejects.toThrow("Guild not found");
    });
  });

  // ─── EIP-712 Signing ──────────────────────────────────────────

  describe("EIP-712 signing", () => {
    it("calls signTypedData with correct domain and type structure", async () => {
      const { pool, wallet, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ title: "T", status: "open", created_at: "2025-01-01", budget_amount: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", accepted: "0", rejected: "0" }] });
      stubSnapshotPersist(pool);

      await service.getIntentSignals(INTENT_ID);

      expect(wallet.signTypedData).toHaveBeenCalledWith(
        { name: "NookplotOracle", version: "1", chainId: CHAIN_ID },
        {
          OracleSnapshot: [
            { name: "entityType", type: "string" },
            { name: "entityId", type: "string" },
            { name: "dataHash", type: "bytes32" },
            { name: "blockNumber", type: "uint256" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        expect.objectContaining({
          entityType: "intent",
          entityId: INTENT_ID,
          dataHash: expect.stringMatching(/^0x/),
          blockNumber: 0,
          timestamp: expect.any(Number),
        }),
      );
    });

    it("returns null signature when no wallet provided", async () => {
      const { pool, service } = createService({ noWallet: true });
      pool.query
        .mockResolvedValueOnce({ rows: [{ title: "T", status: "open", created_at: "2025-01-01", budget_amount: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", accepted: "0", rejected: "0" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getIntentSignals(INTENT_ID);

      expect(snapshot.signature).toBeNull();
      expect(snapshot.blockNumber).toBeNull();
    });
  });

  // ─── Caching ──────────────────────────────────────────────────

  describe("caching", () => {
    it("returns cached snapshot on second call within TTL", async () => {
      const { pool, wallet, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ name: "G", member_count: "5" }] })
        .mockResolvedValueOnce({ rows: [{ balance: "100" }] })
        .mockResolvedValueOnce({ rows: [{ count: "1" }] });
      stubSnapshotPersist(pool);

      const first = await service.getGuildSignals(GUILD_ID);
      const second = await service.getGuildSignals(GUILD_ID);

      expect(first).toBe(second); // exact same reference
      // Only one set of DB queries + one persist — the second call hits cache
      expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Snapshot Persistence ─────────────────────────────────────

  describe("snapshot persistence", () => {
    it("persists snapshot to oracle_snapshots table", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ title: "T", status: "open", created_at: "2025-01-01", budget_amount: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", accepted: "0", rejected: "0" }] })
        .mockResolvedValueOnce({ rowCount: 1 }); // snapshot persist

      await service.getIntentSignals(INTENT_ID);

      // The persist call is the 3rd pool.query invocation (after 2 signal queries)
      const persistCall = pool.query.mock.calls[2];
      expect(persistCall[0]).toContain("INSERT INTO oracle_snapshots");
      expect(persistCall[1][0]).toBe("intent");     // entity_type
      expect(persistCall[1][1]).toBe(INTENT_ID);    // entity_id
      expect(persistCall[1][3]).toMatch(/^0x/);      // data_hash
      expect(persistCall[1][4]).toBe("0xmocksignature"); // signature
      expect(persistCall[1][5]).toBe(12345678);      // block_number
    });

    it("does not throw when persist fails", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ title: "T", status: "open", created_at: "2025-01-01", budget_amount: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", accepted: "0", rejected: "0" }] })
        .mockRejectedValueOnce(new Error("DB write failed")); // persist fails

      // Should still succeed — persist failure is swallowed
      const snapshot = await service.getIntentSignals(INTENT_ID);
      expect(snapshot.entityType).toBe("intent");
    });
  });

  // ─── Error Handling ───────────────────────────────────────────

  describe("error handling", () => {
    it("gracefully handles quality_assessments table missing (project)", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ name: "P", status: "active", created_at: "2025-01-01" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", completed: "0" }] })
        .mockRejectedValueOnce(new Error("relation does not exist")) // quality_assessments
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", completed: "0" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getProjectSignals(PROJECT_ID);

      expect(snapshot.signals.qualityScore).toBe(0);
    });

    it("gracefully handles contribution_scores table missing (agent)", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: "a-001", display_name: null, created_at: "2025-01-01" }] })
        .mockRejectedValueOnce(new Error("relation does not exist")) // contribution_scores
        .mockResolvedValueOnce({ rows: [{ completed: "0", total_claimed: "0" }] })
        .mockResolvedValueOnce({ rows: [{ total: "0", completed: "0" }] });
      stubSnapshotPersist(pool);

      const snapshot = await service.getAgentSignals(AGENT_ADDRESS);

      expect(snapshot.signals.contributionScore).toBe(0);
      expect(snapshot.signals.velocityMultiplier).toBe(1.0);
    });
  });
});
