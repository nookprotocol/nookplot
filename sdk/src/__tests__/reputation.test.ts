import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReputationEngine } from "../reputation.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockContracts() {
  return {
    socialGraph: {
      filters: { AttestationCreated: () => ({}), AttestationRevoked: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([]),
    },
    contentIndex: {
      filters: { ContentPublished: () => ({}) },
      queryFilter: vi.fn().mockResolvedValue([]),
    },
    getAgent: vi.fn().mockResolvedValue({
      registeredAt: Math.floor(Date.now() / 1000) - 86400 * 30, // 30 days ago
    }),
    authorPostCount: vi.fn().mockResolvedValue(0),
    attestationCount: vi.fn().mockResolvedValue(0),
    followerCount: vi.fn().mockResolvedValue(0),
    getScore: vi.fn().mockResolvedValue(0),
  } as any;
}

function createMockProvider() {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(100_000),
  } as any;
}

function createMockGateway() {
  return {
    getAttestations: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    getVotingRelations: vi.fn().mockResolvedValue([]),
  } as any;
}

function createMockSubgraph() {
  return {
    query: vi.fn().mockResolvedValue({ attestations: [], agent: null }),
  } as any;
}

function createEngine(opts?: {
  gateway?: ReturnType<typeof createMockGateway>;
  subgraph?: ReturnType<typeof createMockSubgraph>;
  config?: any;
}) {
  return new ReputationEngine(
    createMockContracts(),
    createMockProvider(),
    opts?.config,
    opts?.subgraph,
    undefined, // names
    opts?.gateway,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ReputationEngine", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  //  runPageRank (private — tested via (engine as any))
  // ═══════════════════════════════════════════════════════════════════════════
  describe("runPageRank", () => {
    let engine: ReputationEngine;

    beforeEach(() => {
      engine = createEngine();
    });

    it("returns empty array for empty graph", () => {
      const result = (engine as any).runPageRank(new Set<string>(), new Map());
      expect(result).toEqual([]);
    });

    it("returns (1-d)/n for single isolated node (no outgoing edges)", () => {
      const nodes = new Set(["0xa"]);
      const edges = new Map<string, string[]>();
      const result = (engine as any).runPageRank(nodes, edges);
      expect(result).toHaveLength(1);
      expect(result[0].address).toBe("0xa");
      // Dangling node: score = (1-d)/n = 0.15/1 = 0.15
      expect(result[0].score).toBeCloseTo(0.15, 5);
    });

    it("gives equal scores for symmetric cycle (A→B→C→A)", () => {
      const nodes = new Set(["0xa", "0xb", "0xc"]);
      const edges = new Map([
        ["0xa", ["0xb"]],
        ["0xb", ["0xc"]],
        ["0xc", ["0xa"]],
      ]);
      const result = (engine as any).runPageRank(nodes, edges);
      expect(result).toHaveLength(3);
      // All three should converge to ~1/3
      for (const r of result) {
        expect(r.score).toBeCloseTo(1 / 3, 3);
      }
    });

    it("gives highest score to hub in star graph (A→B, A→C, A→D)", () => {
      // A attests B, C, D — so B, C, D receive links from A
      // A has no incoming links, B/C/D each have one from A
      const nodes = new Set(["0xa", "0xb", "0xc", "0xd"]);
      const edges = new Map([["0xa", ["0xb", "0xc", "0xd"]]]);
      const result = (engine as any).runPageRank(nodes, edges);

      // A has no incoming edges → gets only the teleport share
      // B, C, D each receive from A → should have higher scores than A
      const scoreA = result.find((r: any) => r.address === "0xa")!.score;
      const scoreB = result.find((r: any) => r.address === "0xb")!.score;
      expect(scoreB).toBeGreaterThan(scoreA);
      // B, C, D should be equal
      const scoreC = result.find((r: any) => r.address === "0xc")!.score;
      const scoreD = result.find((r: any) => r.address === "0xd")!.score;
      expect(scoreB).toBeCloseTo(scoreC, 5);
      expect(scoreC).toBeCloseTo(scoreD, 5);
    });

    it("scores sum to approximately 1.0", () => {
      const nodes = new Set(["0xa", "0xb", "0xc", "0xd", "0xe"]);
      const edges = new Map([
        ["0xa", ["0xb", "0xc"]],
        ["0xb", ["0xc"]],
        ["0xc", ["0xd"]],
        ["0xd", ["0xe"]],
        ["0xe", ["0xa"]],
      ]);
      const result = (engine as any).runPageRank(nodes, edges);
      const sum = result.reduce((s: number, r: any) => s + r.score, 0);
      expect(sum).toBeCloseTo(1.0, 3);
    });

    it("results are sorted descending by score", () => {
      const nodes = new Set(["0xa", "0xb", "0xc"]);
      const edges = new Map([
        ["0xa", ["0xb"]],
        ["0xc", ["0xb"]],
      ]);
      const result = (engine as any).runPageRank(nodes, edges);
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
      }
    });

    it("respects custom damping factor", () => {
      // With d=0 (no link following), all nodes get equal 1/N
      const lowDampEngine = createEngine({ config: { pageRankDampingFactor: 0 } });
      const nodes = new Set(["0xa", "0xb"]);
      const edges = new Map([["0xa", ["0xb"]]]);
      const result = (lowDampEngine as any).runPageRank(nodes, edges);
      // With d=0, every node gets (1-0)/2 = 0.5 regardless of links
      expect(result[0].score).toBeCloseTo(0.5, 3);
      expect(result[1].score).toBeCloseTo(0.5, 3);
    });

    it("produces results even with maxPageRankIterations=1", () => {
      const fastEngine = createEngine({ config: { maxPageRankIterations: 1 } });
      const nodes = new Set(["0xa", "0xb"]);
      const edges = new Map([["0xa", ["0xb"]]]);
      const result = (fastEngine as any).runPageRank(nodes, edges);
      expect(result).toHaveLength(2);
      // B receives a link from A → B should have higher score
      const scoreA = result.find((r: any) => r.address === "0xa")!.score;
      const scoreB = result.find((r: any) => r.address === "0xb")!.score;
      expect(scoreB).toBeGreaterThan(scoreA);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  computeWeightedTrust (private)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("computeWeightedTrust", () => {
    let engine: ReputationEngine;

    beforeEach(() => {
      engine = createEngine();
    });

    it("returns 0 when no attestations", () => {
      const result = (engine as any).computeWeightedTrust(
        "0xagent",
        [],
        new Map(),
        0.01,
      );
      expect(result).toBe(0);
    });

    it("filters attesters below influence floor", () => {
      const pageRankMap = new Map([
        ["0xhigh", 0.3],
        ["0xlow", 0.001],
      ]);
      const attestations = [
        { attester: "0xhigh", subject: "0xagent" },
        { attester: "0xlow", subject: "0xagent" },
      ];
      const result = (engine as any).computeWeightedTrust(
        "0xagent",
        attestations,
        pageRankMap,
        0.01, // floor — 0xlow (0.001) is below
      );
      // Only 0xhigh (0.3) contributes → 0.3 / 0.5 = 0.6 → 60
      expect(result).toBeCloseTo(60, 1);
    });

    it("sums PageRank of qualifying attesters", () => {
      const pageRankMap = new Map([
        ["0xa", 0.2],
        ["0xb", 0.15],
      ]);
      const attestations = [
        { attester: "0xa", subject: "0xagent" },
        { attester: "0xb", subject: "0xagent" },
      ];
      const result = (engine as any).computeWeightedTrust(
        "0xagent",
        attestations,
        pageRankMap,
        0.01,
      );
      // (0.2 + 0.15) / 0.5 = 0.7 → 70
      expect(result).toBeCloseTo(70, 1);
    });

    it("caps at 100 when sum exceeds threshold", () => {
      const pageRankMap = new Map([
        ["0xa", 0.4],
        ["0xb", 0.3],
      ]);
      const attestations = [
        { attester: "0xa", subject: "0xagent" },
        { attester: "0xb", subject: "0xagent" },
      ];
      const result = (engine as any).computeWeightedTrust(
        "0xagent",
        attestations,
        pageRankMap,
        0.01,
      );
      // (0.4 + 0.3) / 0.5 = 1.4, capped to 1.0 → 100
      expect(result).toBe(100);
    });

    it("only counts attestations for target agent", () => {
      const pageRankMap = new Map([
        ["0xa", 0.2],
        ["0xb", 0.15],
      ]);
      const attestations = [
        { attester: "0xa", subject: "0xagent" },
        { attester: "0xb", subject: "0xother" }, // wrong subject
      ];
      const result = (engine as any).computeWeightedTrust(
        "0xagent",
        attestations,
        pageRankMap,
        0.01,
      );
      // Only 0xa counts → 0.2 / 0.5 = 0.4 → 40
      expect(result).toBeCloseTo(40, 1);
    });

    it("uses custom trustThreshold from config", () => {
      const customEngine = createEngine({ config: { trustThreshold: 1.0 } });
      const pageRankMap = new Map([["0xa", 0.3]]);
      const attestations = [{ attester: "0xa", subject: "0xagent" }];
      const result = (customEngine as any).computeWeightedTrust(
        "0xagent",
        attestations,
        pageRankMap,
        0.01,
      );
      // 0.3 / 1.0 = 0.3 → 30
      expect(result).toBeCloseTo(30, 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  computeWeightedQuality (private)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("computeWeightedQuality", () => {
    let engine: ReputationEngine;

    beforeEach(() => {
      engine = createEngine();
    });

    it("returns 50 (neutral) for zero posts", () => {
      const result = (engine as any).computeWeightedQuality(
        [],
        0,
        new Map(),
        0.01,
      );
      expect(result).toBe(50);
    });

    it("returns 50 when no voters above floor", () => {
      const pageRankMap = new Map([["0xvoter", 0.001]]);
      const votingRelations = [
        { voter: "0xvoter", upvoteCount: 10, downvoteCount: 0 },
      ];
      const result = (engine as any).computeWeightedQuality(
        votingRelations,
        5,
        pageRankMap,
        0.01, // voter is below floor
      );
      // Weighted sum = 0 → 50 + 0 = 50
      expect(result).toBe(50);
    });

    it("positive votes increase quality above 50", () => {
      const pageRankMap = new Map([["0xvoter", 0.1]]);
      const votingRelations = [
        { voter: "0xvoter", upvoteCount: 5, downvoteCount: 0 },
      ];
      const result = (engine as any).computeWeightedQuality(
        votingRelations,
        5,
        pageRankMap,
        0.01,
      );
      // weightedVoteSum = 0.1 * 5 = 0.5, weightedAvg = 0.5/5 = 0.1
      // quality = 50 + 0.1 * 500 = 100
      expect(result).toBeGreaterThan(50);
    });

    it("negative votes decrease quality below 50", () => {
      const pageRankMap = new Map([["0xvoter", 0.1]]);
      const votingRelations = [
        { voter: "0xvoter", upvoteCount: 0, downvoteCount: 5 },
      ];
      const result = (engine as any).computeWeightedQuality(
        votingRelations,
        5,
        pageRankMap,
        0.01,
      );
      // weightedVoteSum = 0.1 * (-5) = -0.5, weightedAvg = -0.1
      // quality = 50 + (-0.1) * 500 = 0
      expect(result).toBeLessThan(50);
    });

    it("clamps at 0 for very negative votes", () => {
      const pageRankMap = new Map([["0xvoter", 0.5]]);
      const votingRelations = [
        { voter: "0xvoter", upvoteCount: 0, downvoteCount: 100 },
      ];
      const result = (engine as any).computeWeightedQuality(
        votingRelations,
        1,
        pageRankMap,
        0.01,
      );
      expect(result).toBe(0);
    });

    it("clamps at 100 for very positive votes", () => {
      const pageRankMap = new Map([["0xvoter", 0.5]]);
      const votingRelations = [
        { voter: "0xvoter", upvoteCount: 100, downvoteCount: 0 },
      ];
      const result = (engine as any).computeWeightedQuality(
        votingRelations,
        1,
        pageRankMap,
        0.01,
      );
      expect(result).toBe(100);
    });

    it("uses custom qualityScalingFactor", () => {
      const customEngine = createEngine({ config: { qualityScalingFactor: 100 } });
      const pageRankMap = new Map([["0xvoter", 0.1]]);
      const votingRelations = [
        { voter: "0xvoter", upvoteCount: 5, downvoteCount: 0 },
      ];
      const result = (customEngine as any).computeWeightedQuality(
        votingRelations,
        5,
        pageRankMap,
        0.01,
      );
      // weightedAvg = 0.1, quality = 50 + 0.1 * 100 = 60
      expect(result).toBeCloseTo(60, 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  applyExternalBoosts (private)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("applyExternalBoosts", () => {
    let engine: ReputationEngine;

    beforeEach(() => {
      engine = createEngine();
    });

    function baseScore(): any {
      return {
        address: "0xtest",
        overall: 50,
        components: {
          tenure: 50,
          quality: 50,
          trust: 50,
          influence: 50,
          activity: 50,
          breadth: 50,
          teaching: 0,
        },
      };
    }

    it("adds boosts to specified dimensions", () => {
      const score = baseScore();
      (engine as any).applyExternalBoosts(score, { activity: 20, quality: 10 });
      expect(score.components.activity).toBe(70);
      expect(score.components.quality).toBe(60);
    });

    it("clamps components at 100", () => {
      const score = baseScore();
      (engine as any).applyExternalBoosts(score, { activity: 80 }); // 50 + 80 = 130 → 100
      expect(score.components.activity).toBe(100);
    });

    it("recomputes overall after boosting", () => {
      const score = baseScore();
      const originalOverall = score.overall;
      (engine as any).applyExternalBoosts(score, { teaching: 70 });
      expect(score.overall).toBeGreaterThan(originalOverall);
      // (50+50+50+50+50+50+70)/7 = 370/7 ≈ 52.86
      expect(score.overall).toBeCloseTo(52.86, 1);
    });

    it("handles all boost dimensions", () => {
      const score = baseScore();
      (engine as any).applyExternalBoosts(score, {
        activity: 10,
        quality: 10,
        influence: 10,
        breadth: 10,
        teaching: 10,
      });
      expect(score.components.activity).toBe(60);
      expect(score.components.quality).toBe(60);
      expect(score.components.influence).toBe(60);
      expect(score.components.breadth).toBe(60);
      expect(score.components.teaching).toBe(10);
    });

    it("does nothing when no boosts specified", () => {
      const score = baseScore();
      (engine as any).applyExternalBoosts(score, {});
      expect(score.components.activity).toBe(50);
      expect(score.components.quality).toBe(50);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  getInfluenceFloor (private)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("getInfluenceFloor", () => {
    it("defaults to 0.5/N", () => {
      const engine = createEngine();
      const floor = (engine as any).getInfluenceFloor(100);
      expect(floor).toBeCloseTo(0.005, 5);
    });

    it("returns 0 when totalAgents is 0", () => {
      const engine = createEngine();
      const floor = (engine as any).getInfluenceFloor(0);
      expect(floor).toBe(0);
    });

    it("uses custom minPageRankForInfluence when configured", () => {
      const engine = createEngine({ config: { minPageRankForInfluence: 0.02 } });
      const floor = (engine as any).getInfluenceFloor(100);
      expect(floor).toBe(0.02);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  PageRank Cache
  // ═══════════════════════════════════════════════════════════════════════════
  describe("PageRank cache", () => {
    it("caches results within TTL", async () => {
      const gateway = createMockGateway();
      gateway.getAttestations.mockResolvedValue([
        { attester_id: "0xa", subject_id: "0xb" },
      ]);
      const engine = createEngine({ gateway });

      // First call — computes
      const result1 = await (engine as any).getPageRankMap();
      expect(result1.totalAgents).toBe(2);
      expect(gateway.getAttestations).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      const result2 = await (engine as any).getPageRankMap();
      expect(result2.totalAgents).toBe(2);
      // getAttestations called once for computePageRank, the second getPageRankMap reads cache
      // BUT computePageRank internally calls getAttestations in a while loop — first batch returns 1 item (< 1000), loop ends
      // So total calls should be 1 (from first getPageRankMap) + 0 (from cached second) = 1
      expect(gateway.getAttestations).toHaveBeenCalledTimes(1);
    });

    it("recomputes after cache expires", async () => {
      const gateway = createMockGateway();
      gateway.getAttestations.mockResolvedValue([
        { attester_id: "0xa", subject_id: "0xb" },
      ]);
      const engine = createEngine({ gateway });

      // First call
      await (engine as any).getPageRankMap();

      // Manually expire the cache
      (engine as any).pageRankCache!.expiresAt = Date.now() - 1;

      // Should recompute
      await (engine as any).getPageRankMap();
      expect(gateway.getAttestations).toHaveBeenCalledTimes(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Fallback chain (computePageRank)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("computePageRank fallback chain", () => {
    it("uses gateway when available", async () => {
      const gateway = createMockGateway();
      gateway.getAttestations.mockResolvedValue([]);
      const subgraph = createMockSubgraph();
      const engine = createEngine({ gateway, subgraph });

      await engine.computePageRank();
      expect(gateway.getAttestations).toHaveBeenCalled();
      expect(subgraph.query).not.toHaveBeenCalled();
    });

    it("falls back to subgraph when gateway fails", async () => {
      const gateway = createMockGateway();
      gateway.getAttestations.mockRejectedValue(new Error("gateway down"));
      const subgraph = createMockSubgraph();
      subgraph.query.mockResolvedValue({ attestations: [] });
      const engine = createEngine({ gateway, subgraph });

      await engine.computePageRank();
      expect(gateway.getAttestations).toHaveBeenCalled();
      expect(subgraph.query).toHaveBeenCalled();
    });

    it("falls back to events when both gateway and subgraph fail", async () => {
      const gateway = createMockGateway();
      gateway.getAttestations.mockRejectedValue(new Error("down"));
      const subgraph = createMockSubgraph();
      subgraph.query.mockRejectedValue(new Error("down"));

      const contracts = createMockContracts();
      const provider = createMockProvider();
      const engine = new ReputationEngine(contracts, provider, undefined, subgraph, undefined, gateway);

      await engine.computePageRank();
      // Should have attempted event scanning via socialGraph.queryFilter
      expect(contracts.socialGraph.queryFilter).toHaveBeenCalled();
    });

    it("works with no gateway or subgraph (events only)", async () => {
      const contracts = createMockContracts();
      const provider = createMockProvider();
      const engine = new ReputationEngine(contracts, provider);

      const result = await engine.computePageRank();
      expect(result).toEqual([]);
      expect(contracts.socialGraph.queryFilter).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  computeReputationScore (public)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("computeReputationScore", () => {
    it("returns zeroed score when agent not found via gateway", async () => {
      const gateway = createMockGateway();
      gateway.getAgent.mockResolvedValue(null);
      gateway.getAttestations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xunknown");
      expect(score.overall).toBe(0);
      expect(score.components.quality).toBe(50); // neutral default
      expect(score.components.tenure).toBe(0);
    });

    it("computes all components via gateway", async () => {
      const gateway = createMockGateway();
      const now = Math.floor(Date.now() / 1000);
      gateway.getAgent.mockResolvedValue({
        registered_at: now - 86400 * 365, // 1 year ago
        post_count: 50,
        total_upvotes_received: 20,
        total_downvotes_received: 5,
        follower_count: 25,
        attestation_count: 5,
        communities_active: ["c1", "c2", "c3", "c4", "c5"],
      });
      gateway.getAttestations.mockResolvedValue([]);
      gateway.getVotingRelations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xagent");
      expect(score.address).toBe("0xagent");
      expect(score.components.tenure).toBeCloseTo(100, 0); // 365 days / 365 = 1.0
      expect(score.components.activity).toBe(50); // 50 posts
      expect(score.components.influence).toBe(50); // 25/50 = 0.5 → 50
      expect(score.components.breadth).toBe(50); // 5/10 = 0.5 → 50
      expect(score.overall).toBeGreaterThan(0);
    });

    it("applies external boosts to final score", async () => {
      const gateway = createMockGateway();
      gateway.getAgent.mockResolvedValue(null);
      gateway.getAttestations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xagent", false, {
        activity: 30,
        teaching: 50,
      });
      expect(score.components.activity).toBe(30); // 0 + 30
      expect(score.components.teaching).toBe(50); // 0 + 50
    });

    it("falls back to event-based when gateway fails", async () => {
      const gateway = createMockGateway();
      gateway.getAgent.mockRejectedValue(new Error("gateway error"));
      gateway.getAttestations.mockRejectedValue(new Error("gateway error"));

      const contracts = createMockContracts();
      contracts.getAgent.mockResolvedValue({
        registeredAt: Math.floor(Date.now() / 1000) - 86400 * 10,
      });
      contracts.authorPostCount.mockResolvedValue(0);
      contracts.followerCount.mockResolvedValue(0);

      const provider = createMockProvider();
      const engine = new ReputationEngine(contracts, provider, undefined, undefined, undefined, gateway);

      const score = await engine.computeReputationScore("0xagent");
      // Should get result from events path
      expect(score.address).toBe("0xagent");
      expect(score.components.tenure).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  hasSubgraph / hasGateway
  // ═══════════════════════════════════════════════════════════════════════════
  describe("accessor properties", () => {
    it("hasGateway returns true when gateway configured", () => {
      const engine = createEngine({ gateway: createMockGateway() });
      expect(engine.hasGateway).toBe(true);
    });

    it("hasGateway returns false when no gateway", () => {
      const engine = createEngine();
      expect(engine.hasGateway).toBe(false);
    });

    it("hasSubgraph returns true when subgraph configured", () => {
      const engine = createEngine({ subgraph: createMockSubgraph() });
      expect(engine.hasSubgraph).toBe(true);
    });

    it("hasSubgraph returns false when no subgraph", () => {
      const engine = createEngine();
      expect(engine.hasSubgraph).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  Component normalization
  // ═══════════════════════════════════════════════════════════════════════════
  describe("component normalization", () => {
    it("tenure caps at 100 for 365+ days", async () => {
      const gateway = createMockGateway();
      const now = Math.floor(Date.now() / 1000);
      gateway.getAgent.mockResolvedValue({
        registered_at: now - 86400 * 730, // 2 years
        post_count: 0,
        total_upvotes_received: 0,
        total_downvotes_received: 0,
        follower_count: 0,
        attestation_count: 0,
        communities_active: [],
      });
      gateway.getAttestations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xold");
      expect(score.components.tenure).toBe(100);
    });

    it("activity equals post count when under 100", async () => {
      const gateway = createMockGateway();
      const now = Math.floor(Date.now() / 1000);
      gateway.getAgent.mockResolvedValue({
        registered_at: now,
        post_count: 42,
        total_upvotes_received: 0,
        total_downvotes_received: 0,
        follower_count: 0,
        attestation_count: 0,
        communities_active: [],
      });
      gateway.getAttestations.mockResolvedValue([]);
      gateway.getVotingRelations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xactive");
      expect(score.components.activity).toBe(42);
    });

    it("influence caps at 100 for 50+ followers", async () => {
      const gateway = createMockGateway();
      const now = Math.floor(Date.now() / 1000);
      gateway.getAgent.mockResolvedValue({
        registered_at: now,
        post_count: 0,
        total_upvotes_received: 0,
        total_downvotes_received: 0,
        follower_count: 200,
        attestation_count: 0,
        communities_active: [],
      });
      gateway.getAttestations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xfamous");
      expect(score.components.influence).toBe(100);
    });

    it("breadth caps at 100 for 10+ communities", async () => {
      const gateway = createMockGateway();
      const now = Math.floor(Date.now() / 1000);
      gateway.getAgent.mockResolvedValue({
        registered_at: now,
        post_count: 0,
        total_upvotes_received: 0,
        total_downvotes_received: 0,
        follower_count: 0,
        attestation_count: 0,
        communities_active: Array.from({ length: 15 }, (_, i) => `c${i}`),
      });
      gateway.getAttestations.mockResolvedValue([]);
      const engine = createEngine({ gateway });

      const score = await engine.computeReputationScore("0xbroad");
      expect(score.components.breadth).toBe(100);
    });
  });
});
