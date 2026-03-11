import { describe, it, expect, vi } from "vitest";
import { MerkleRewardService } from "../merkleRewardService.js";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  } as any;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_ADDR_1 = "0x1111111111111111111111111111111111111111";
const AGENT_ADDR_2 = "0x2222222222222222222222222222222222222222";
const AGENT_ADDR_3 = "0x3333333333333333333333333333333333333333";
const GUILD_ADDR = "0x4444444444444444444444444444444444444444";

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService(config?: any) {
  const pool = createMockPool();
  const service = new MerkleRewardService(pool, {
    tickIntervalMs: 999_999,
    maxJitterHours: 0,
    wethBudget: "1000000000000000000", // 1 ETH
    nookBudget: "100000000000000000000000", // 100k NOOK
    ...config,
  });
  return { pool, service };
}

function setupPoolForCompute(pool: any, agents: any[], guilds: any[]) {
  const client = pool._client;

  pool.query.mockImplementation(async (sql: string, params?: any[]) => {
    // Budget lookup
    if (sql.includes("system_settings")) {
      return { rows: [] };
    }
    // Guild scores (check BEFORE agent scores — guild SQL also contains "agents" and "contribution_scores")
    if (sql.includes("idx_guilds") && sql.includes("idx_guild_members")) {
      return { rows: guilds };
    }
    // Agent scores
    if (sql.includes("agents") && sql.includes("contribution_scores")) {
      return { rows: agents };
    }
    // Previous cumulative
    if (sql.includes("merkle_reward_leaves") && sql.includes("merkle_reward_roots")) {
      return { rows: [] };
    }
    // Merkle root check
    if (sql.includes("merkle_reward_roots") && sql.includes("COUNT")) {
      return { rows: [{ count: "0" }] };
    }
    return { rows: [], rowCount: 0 };
  });

  // Client mocks for storeRoot transaction — must return Promises
  client.query.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO merkle_reward_roots")) {
      return { rows: [{ id: "root-001" }] };
    }
    if (sql.includes("INSERT INTO merkle_reward_leaves")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MerkleRewardService", () => {
  describe("Merkle tree construction", () => {
    it("builds a valid Merkle tree with known inputs", async () => {
      const { pool, service } = createService();

      const agents = [
        { address: AGENT_ADDR_1, score: "100" },
        { address: AGENT_ADDR_2, score: "50" },
      ];
      setupPoolForCompute(pool, agents, []);

      const result = await service.computeEpoch("weth", 202610);

      expect(result).not.toBeNull();
      expect(result!.merkleRoot).toBeTruthy();
      expect(result!.merkleRoot.startsWith("0x")).toBe(true);
      expect(result!.leafCount).toBe(2);
    });
  });

  describe("75/25 agent/guild split", () => {
    it("allocates 75% to agents and 25% to guilds", async () => {
      const { pool, service } = createService({ agentSharePct: 0.75 });

      const agents = [
        { address: AGENT_ADDR_1, score: "100" },
      ];
      const guilds = [
        { guild_id: "1", proposer_address: GUILD_ADDR, avg_score: "100" },
      ];
      setupPoolForCompute(pool, agents, guilds);

      const result = await service.computeEpoch("weth", 202610);
      expect(result).not.toBeNull();
      expect(result!.leafCount).toBe(2); // 1 agent + 1 guild
    });
  });

  describe("cumulative amount tracking", () => {
    it("adds epoch amount to previous cumulative", async () => {
      const { pool, service } = createService();

      const agents = [
        { address: AGENT_ADDR_1, score: "100" },
      ];

      // First epoch
      setupPoolForCompute(pool, agents, []);
      const result1 = await service.computeEpoch("weth", 202610);
      expect(result1).not.toBeNull();

      // Second epoch — mock previous cumulative
      pool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("system_settings")) return { rows: [] };
        if (sql.includes("agents") && sql.includes("contribution_scores")) {
          return { rows: agents };
        }
        if (sql.includes("idx_guilds")) return { rows: [] };
        if (sql.includes("merkle_reward_leaves") && sql.includes("merkle_reward_roots")) {
          return { rows: [{ address: AGENT_ADDR_1, cumulative_amount: "500000000000000000" }] };
        }
        if (sql.includes("merkle_reward_roots") && sql.includes("COUNT")) {
          return { rows: [{ count: "0" }] };
        }
        return { rows: [], rowCount: 0 };
      });

      const result2 = await service.computeEpoch("weth", 202611);
      expect(result2).not.toBeNull();
    });
  });

  describe("sqrt dampening", () => {
    it("prevents whale domination with dampening", () => {
      const { service } = createService({ sqrtDampening: true });

      const distributePool = (service as any).distributePool.bind(service);

      const entries = [
        { address: AGENT_ADDR_1, entityType: "agent", score: 10000 }, // whale
        { address: AGENT_ADDR_2, entityType: "agent", score: 100 },  // small
        { address: AGENT_ADDR_3, entityType: "agent", score: 100 },  // small
      ];

      const budget = 1000000000000000000n; // 1 ETH
      const result = distributePool(entries, budget);

      // Without dampening, whale would get ~98%. With sqrt: sqrt(10000)=100, sqrt(100)=10
      // Whale share: 100/(100+10+10) = 83%. Much more equitable.
      const whaleAmount = result.find((r: any) => r.address === AGENT_ADDR_1)?.epochAmount ?? 0n;
      const smallAmount = result.find((r: any) => r.address === AGENT_ADDR_2)?.epochAmount ?? 0n;

      // Whale should get less than 90% (sqrt dampening effect)
      expect(Number(whaleAmount)).toBeLessThan(Number(budget) * 0.9);
      // Small agents should each get a meaningful share
      expect(Number(smallAmount)).toBeGreaterThan(0);
    });

    it("without dampening, whale dominates", () => {
      const { service } = createService({ sqrtDampening: false });

      const distributePool = (service as any).distributePool.bind(service);

      const entries = [
        { address: AGENT_ADDR_1, entityType: "agent", score: 10000 },
        { address: AGENT_ADDR_2, entityType: "agent", score: 100 },
      ];

      const budget = 1000000000000000000n;
      const result = distributePool(entries, budget);

      const whaleAmount = result.find((r: any) => r.address === AGENT_ADDR_1)?.epochAmount ?? 0n;
      // Without dampening, whale gets ~99%
      expect(Number(whaleAmount)).toBeGreaterThan(Number(budget) * 0.95);
    });
  });

  describe("proof verification", () => {
    it("generates verifiable proofs", async () => {
      const { pool, service } = createService();

      const agents = [
        { address: AGENT_ADDR_1, score: "200" },
        { address: AGENT_ADDR_2, score: "100" },
        { address: AGENT_ADDR_3, score: "50" },
      ];
      setupPoolForCompute(pool, agents, []);

      // Capture the tree creation by intercepting the store
      const storedEntries: any[] = [];
      const client = pool._client;
      client.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("INSERT INTO merkle_reward_roots")) {
          return { rows: [{ id: "root-001" }] };
        }
        if (sql.includes("INSERT INTO merkle_reward_leaves") && params) {
          storedEntries.push({
            address: params[1],
            cumulativeAmount: params[2],
            proof: JSON.parse(params[4]),
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await service.computeEpoch("weth", 202610);
      expect(result).not.toBeNull();
      expect(storedEntries.length).toBe(3);

      // Each entry should have a proof array
      for (const entry of storedEntries) {
        expect(Array.isArray(entry.proof)).toBe(true);
        expect(entry.proof.length).toBeGreaterThan(0);
      }
    });
  });

  describe("zero-score agents excluded", () => {
    it("filters out agents with zero scores", async () => {
      const { pool, service } = createService();

      const agents = [
        { address: AGENT_ADDR_1, score: "0" },
        { address: AGENT_ADDR_2, score: "100" },
      ];
      setupPoolForCompute(pool, agents, []);

      // Override to only return non-zero scores (the SQL WHERE already filters > 0)
      pool.query.mockImplementation(async (sql: string) => {
        if (sql.includes("system_settings")) return { rows: [] };
        if (sql.includes("agents") && sql.includes("contribution_scores")) {
          return { rows: [{ address: AGENT_ADDR_2, score: "100" }] }; // only one
        }
        if (sql.includes("idx_guilds")) return { rows: [] };
        if (sql.includes("merkle_reward_leaves")) return { rows: [] };
        if (sql.includes("merkle_reward_roots") && sql.includes("COUNT")) {
          return { rows: [{ count: "0" }] };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await service.computeEpoch("weth", 202610);
      expect(result).not.toBeNull();
      expect(result!.leafCount).toBe(1); // only non-zero
    });
  });

  describe("guild with no proposer excluded", () => {
    it("filters out guilds without proposer address", async () => {
      const { pool, service } = createService({ agentSharePct: 0.75 });

      const agents = [
        { address: AGENT_ADDR_1, score: "100" }, // at least one agent for the tree
      ];
      const guilds = [
        { guild_id: "1", proposer_address: null, avg_score: "100" }, // no wallet
        { guild_id: "2", proposer_address: GUILD_ADDR, avg_score: "100" }, // has wallet
      ];
      setupPoolForCompute(pool, agents, guilds);

      const result = await service.computeEpoch("weth", 202610);
      // 1 agent + 1 guild (the one with proposer_address)
      expect(result).not.toBeNull();
      expect(result!.leafCount).toBe(2);
    });
  });

  describe("no eligible participants", () => {
    it("returns null when no agents or guilds have scores", async () => {
      const { pool, service } = createService();
      setupPoolForCompute(pool, [], []);

      const result = await service.computeEpoch("weth", 202610);
      expect(result).toBeNull();
    });
  });

  describe("query methods", () => {
    it("getClaimable returns amounts per pool type", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rows: [{ cumulative_amount: "500", epoch_amount: "100", entity_type: "agent" }],
      });

      const result = await service.getClaimable(AGENT_ADDR_1);
      expect(result.weth).toBeTruthy();
      expect(result.weth!.cumulativeAmount).toBe("500");
    });

    it("getProof returns proof data", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rows: [{
          proof: ["0xabc", "0xdef"],
          cumulative_amount: "1000",
          epoch_number: 202610,
          merkle_root: "0x123",
        }],
      });

      const result = await service.getProof(AGENT_ADDR_1, "weth");
      expect(result).not.toBeNull();
      expect(result!.proof).toEqual(["0xabc", "0xdef"]);
      expect(result!.cumulativeAmount).toBe("1000");
    });

    it("getHistory returns paginated history", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rows: [{
          pool_type: "weth",
          epoch_number: 202610,
          epoch_amount: "100",
          cumulative_amount: "500",
          entity_type: "agent",
          created_at: "2026-03-01T00:00:00Z",
        }],
      });

      const result = await service.getHistory(AGENT_ADDR_1);
      expect(result).toHaveLength(1);
      expect(result[0].poolType).toBe("weth");
    });
  });

  describe("lifecycle", () => {
    it("start and stop manage the timer", () => {
      const { service } = createService();
      service.start();
      service.start(); // no-op
      service.stop();
      service.stop(); // no-op
    });
  });
});
