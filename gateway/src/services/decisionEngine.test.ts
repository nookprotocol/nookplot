import { describe, it, expect, vi } from "vitest";
import { DecisionEngine } from "./decisionEngine.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockRegistry() {
  return {
    mapOpportunityToAction: vi.fn().mockReturnValue("create_post"),
    getCost: vi.fn().mockReturnValue(100),
    getAutonomyLevel: vi.fn().mockReturnValue("autonomous"),
    checkBoundaryViolation: vi.fn().mockReturnValue(false),
    getHandler: vi.fn(),
    getRateLimit: vi.fn().mockReturnValue({ maxPerHour: 10, maxPerDay: 50 }),
    get: vi.fn(),
  };
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: 10000, status: "active" }),
    addCredits: vi.fn(),
    deductCredits: vi.fn(),
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    purpose: {
      mission: "Build AI tools",
      domains: ["artificial-intelligence", "machine-learning"],
      goals: ["Create open-source ML models"],
    },
    autonomy: { level: "semi-autonomous", boundaries: [] },
    ...overrides,
  } as any;
}

function makeOpportunity(overrides: Record<string, unknown> = {}) {
  return {
    type: "bounty",
    sourceId: "bounty_1",
    title: "Build an AI classifier",
    description: "Create a machine learning classifier for text",
    estimatedValue: 500,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
//  getReputationAdjustment
// ---------------------------------------------------------------------------

describe("DecisionEngine — getReputationAdjustment", () => {
  it("returns 1.0 when no feedback", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ upvotes: "0", downvotes: "0" }],
      rowCount: 1,
    });

    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, createMockRegistry() as any);
    const mult = await engine.getReputationAdjustment("agt_1");

    expect(mult).toBe(1.0);
  });

  it("returns >1.0 for mostly positive feedback", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ upvotes: "8", downvotes: "2" }],
      rowCount: 1,
    });

    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, createMockRegistry() as any);
    const mult = await engine.getReputationAdjustment("agt_1");

    // ratio = 8/10 = 0.8, mult = 0.5 + 0.8 = 1.3
    expect(mult).toBeCloseTo(1.3);
  });

  it("returns <1.0 for mostly negative feedback", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ upvotes: "1", downvotes: "9" }],
      rowCount: 1,
    });

    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, createMockRegistry() as any);
    const mult = await engine.getReputationAdjustment("agt_1");

    // ratio = 1/10 = 0.1, mult = 0.5 + 0.1 = 0.6
    expect(mult).toBeCloseTo(0.6);
  });

  it("returns 1.0 on query failure", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("table not found"));

    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, createMockRegistry() as any);
    const mult = await engine.getReputationAdjustment("agt_1");

    expect(mult).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
//  evaluate — keyword alignment
// ---------------------------------------------------------------------------

describe("DecisionEngine — evaluate (keyword alignment)", () => {
  it("includes opportunities matching agent domains", async () => {
    const pool = createMockPool();
    // getReputationAdjustment
    pool.query.mockResolvedValueOnce({ rows: [{ upvotes: "0", downvotes: "0" }], rowCount: 1 });

    const registry = createMockRegistry();
    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);

    const result = await engine.evaluate("agt_1", makeContext(), [
      makeOpportunity({ title: "Build an artificial-intelligence tool" }),
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].actionType).toBe("create_post");
    expect(result.candidates[0].alignmentScore).toBeGreaterThan(0);
    expect(result.skippedCount).toBe(0);
  });

  it("skips opportunities below alignment threshold", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ upvotes: "0", downvotes: "0" }], rowCount: 1 });

    const registry = createMockRegistry();
    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);

    const result = await engine.evaluate("agt_1", makeContext(), [
      makeOpportunity({ title: "Cook a gourmet meal", description: "Culinary arts competition" }),
    ]);

    expect(result.candidates).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
  });

  it("returns 0.5 alignment for agents with no domains", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ upvotes: "0", downvotes: "0" }], rowCount: 1 });

    const registry = createMockRegistry();
    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);

    const context = makeContext({ purpose: { mission: "General", domains: [], goals: [] } });
    const result = await engine.evaluate("agt_1", context, [makeOpportunity()]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].alignmentScore).toBe(0.5);
  });

  it("sorts candidates by value efficiency", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ upvotes: "0", downvotes: "0" }], rowCount: 1 });

    const registry = createMockRegistry();
    registry.getCost.mockReturnValue(100);

    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);

    const result = await engine.evaluate("agt_1", makeContext(), [
      makeOpportunity({ sourceId: "low", title: "AI task", estimatedValue: 100 }),
      makeOpportunity({ sourceId: "high", title: "AI machine-learning task", estimatedValue: 1000 }),
    ]);

    // Higher value should be first
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    if (result.candidates.length >= 2) {
      expect(result.candidates[0].opportunityId).toBe("high");
    }
  });
});

// ---------------------------------------------------------------------------
//  recordOpportunity / createAction
// ---------------------------------------------------------------------------

describe("DecisionEngine — recordOpportunity", () => {
  it("inserts opportunity and returns ID", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "opp_1" }], rowCount: 1 });

    const registry = createMockRegistry();
    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);
    const id = await engine.recordOpportunity("agt_1", makeOpportunity(), 0.8, "pending");

    expect(id).toBe("opp_1");
  });
});

describe("DecisionEngine — createAction", () => {
  it("creates approved action when no approval required", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "act_1" }], rowCount: 1 });

    const registry = createMockRegistry();
    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);

    const candidate = {
      opportunityId: "opp_1",
      actionType: "create_post",
      payload: {},
      estimatedCost: 100,
      alignmentScore: 0.8,
      requiresApproval: false,
    };
    const id = await engine.createAction("agt_1", candidate, "opp_db_1");

    expect(id).toBe("act_1");
    // Status should be "approved"
    const insertCall = pool.query.mock.calls[0];
    expect(insertCall[1][4]).toBe("approved");
  });

  it("creates pending action when approval required", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "act_2" }], rowCount: 1 });

    const registry = createMockRegistry();
    const engine = new DecisionEngine(pool as any, null, createMockCreditManager() as any, registry as any);

    const candidate = {
      opportunityId: "opp_1",
      actionType: "claim_bounty",
      payload: {},
      estimatedCost: 500,
      alignmentScore: 0.9,
      requiresApproval: true,
    };
    const id = await engine.createAction("agt_1", candidate);

    expect(id).toBe("act_2");
    const insertCall = pool.query.mock.calls[0];
    expect(insertCall[1][4]).toBe("pending");
  });
});
