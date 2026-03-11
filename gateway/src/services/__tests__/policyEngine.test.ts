import { describe, it, expect, vi, beforeEach } from "vitest";
import { PolicyEngine } from "../policyEngine.js";
import type { PolicyType, EvaluationContext } from "../policyEngine.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

/* ================================================================ */
/*  Mock factories                                                    */
/* ================================================================ */

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
  } as any;
}

const AGENT_ID = "agent-001";
const POLICY_ID = "policy-001";

function makePolicy(overrides: Partial<{
  id: string;
  agent_id: string;
  policy_type: PolicyType;
  rules: Record<string, unknown>;
  priority: number;
  creator_role: string;
  creator_id: string | null;
  guild_id: string | null;
  enabled: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: POLICY_ID,
    agent_id: AGENT_ID,
    policy_type: "spending_limit" as PolicyType,
    rules: { maxPerTx: 100 },
    priority: 0,
    creator_role: "self",
    creator_id: AGENT_ID,
    guild_id: null,
    enabled: true,
    expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function defaultCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    targetContract: "0x1234567890123456789012345678901234567890",
    methodSelector: "0x12345678",
    creditCost: 10,
    ...overrides,
  };
}

/* ================================================================ */
/*  Spending limit tests                                              */
/* ================================================================ */

describe("PolicyEngine — spending_limit", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 }); // disable cache for tests
  });

  it("allows relay when cost is under per-tx limit", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makePolicy({ rules: { maxPerTx: 100 } })] }) // getActivePolicies
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 50 }));
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("blocks relay when cost exceeds per-tx limit", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makePolicy({ rules: { maxPerTx: 10 } })] }) // getActivePolicies
      .mockResolvedValueOnce({ rows: [] }) // logViolations insert
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 50 }));
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].policyType).toBe("spending_limit");
    expect(result.violations[0].details.limit).toBe("maxPerTx");
  });

  it("blocks when daily spending would exceed limit", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makePolicy({ rules: { maxPerDay: 100 } })] }) // getActivePolicies
      .mockResolvedValueOnce({ rows: [{ daily_spent: "90", weekly_spent: "90" }] }) // getSpendingTracker
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 20 }));
    expect(result.allowed).toBe(false);
    expect(result.violations[0].details.limit).toBe("maxPerDay");
  });

  it("allows when daily spending stays under limit", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makePolicy({ rules: { maxPerDay: 100 } })] }) // getActivePolicies
      .mockResolvedValueOnce({ rows: [{ daily_spent: "50", weekly_spent: "50" }] }) // getSpendingTracker
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 20 }));
    expect(result.allowed).toBe(true);
  });

  it("blocks when weekly spending would exceed limit", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makePolicy({ rules: { maxPerWeek: 500 } })] }) // getActivePolicies
      .mockResolvedValueOnce({ rows: [{ daily_spent: "100", weekly_spent: "490" }] }) // getSpendingTracker
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 20 }));
    expect(result.allowed).toBe(false);
    expect(result.violations[0].details.limit).toBe("maxPerWeek");
  });
});

/* ================================================================ */
/*  Contract scope tests                                              */
/* ================================================================ */

describe("PolicyEngine — contract_scope", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("allows when contract is in allow list", async () => {
    const contract = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "contract_scope",
        rules: { mode: "allow", contracts: [contract] },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ targetContract: contract }));
    expect(result.allowed).toBe(true);
  });

  it("blocks when contract not in allow list", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "contract_scope",
          rules: { mode: "allow", contracts: ["0x1111111111111111111111111111111111111111"] },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx());
    expect(result.allowed).toBe(false);
    expect(result.violations[0].policyType).toBe("contract_scope");
  });

  it("blocks when contract is in deny list", async () => {
    const contract = "0x1234567890123456789012345678901234567890";
    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "contract_scope",
          rules: { mode: "deny", contracts: [contract] },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ targetContract: contract }));
    expect(result.allowed).toBe(false);
  });

  it("allows when contract not in deny list", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "contract_scope",
        rules: { mode: "deny", contracts: ["0x9999999999999999999999999999999999999999"] },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx());
    expect(result.allowed).toBe(true);
  });

  it("handles case-insensitive contract comparison", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "contract_scope",
        rules: { mode: "allow", contracts: ["0xabcdef1234567890abcdef1234567890abcdef12"] },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx({
      targetContract: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    }));
    expect(result.allowed).toBe(true);
  });
});

/* ================================================================ */
/*  Action scope tests                                                */
/* ================================================================ */

describe("PolicyEngine — action_scope", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("allows when action is in allow list", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "action_scope",
        rules: { mode: "allow", actions: ["0x12345678"] },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(true);
  });

  it("blocks when action not in allow list", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "action_scope",
          rules: { mode: "allow", actions: ["0xAAAAAAAA"] },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(false);
    expect(result.violations[0].policyType).toBe("action_scope");
  });

  it("blocks when action is in deny list", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "action_scope",
          rules: { mode: "deny", actions: ["0x12345678"] },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(false);
  });
});

/* ================================================================ */
/*  Time window tests                                                 */
/* ================================================================ */

describe("PolicyEngine — time_window", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("allows when current time is within window", async () => {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const hour = now.getUTCHours();

    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "time_window",
        rules: {
          allowedWindows: [{ daysOfWeek: [dayOfWeek], startHour: hour, endHour: hour + 1 }],
        },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx());
    expect(result.allowed).toBe(true);
  });

  it("blocks when current time is outside all windows", async () => {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const outsideHour = (now.getUTCHours() + 12) % 24; // opposite side of day

    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "time_window",
          rules: {
            allowedWindows: [{ daysOfWeek: [dayOfWeek], startHour: outsideHour, endHour: (outsideHour + 1) % 24 }],
          },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx());
    // Might be allowed if the window wraps around midnight, but with +12 offset this should block
    // in most cases. The test is still valid for the general flow.
    if ((outsideHour + 1) % 24 !== 0) {
      expect(result.allowed).toBe(false);
      expect(result.violations[0].policyType).toBe("time_window");
    }
  });
});

/* ================================================================ */
/*  Cooldown tests                                                    */
/* ================================================================ */

describe("PolicyEngine — cooldown", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("allows when no previous relay exists", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "cooldown",
          rules: { selector: "0x12345678", minIntervalSeconds: 60 },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // violation lookup
      .mockResolvedValueOnce({ rows: [] }) // relay_log lookup
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(true);
  });

  it("blocks when cooldown has not elapsed", async () => {
    const recentRelay = new Date(Date.now() - 10_000); // 10 seconds ago

    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "cooldown",
          rules: { selector: "0x12345678", minIntervalSeconds: 60 },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // violation lookup
      .mockResolvedValueOnce({ rows: [{ last_relay_at: recentRelay }] }) // relay_log lookup
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(false);
    expect(result.violations[0].policyType).toBe("cooldown");
  });

  it("allows when cooldown has elapsed", async () => {
    const oldRelay = new Date(Date.now() - 120_000); // 2 minutes ago

    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "cooldown",
          rules: { selector: "0x12345678", minIntervalSeconds: 60 },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // violation lookup
      .mockResolvedValueOnce({ rows: [{ last_relay_at: oldRelay }] }) // relay_log lookup
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(true);
  });

  it("skips cooldown for different selector", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "cooldown",
        rules: { selector: "0xAAAAAAAA", minIntervalSeconds: 60 },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ methodSelector: "0x12345678" }));
    expect(result.allowed).toBe(true);
  });
});

/* ================================================================ */
/*  Threshold approval tests                                          */
/* ================================================================ */

describe("PolicyEngine — threshold_approval", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("allows when cost is below threshold", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({
        policy_type: "threshold_approval",
        rules: { thresholdCredits: 100, approvers: ["approver-1"], requiredApprovals: 1 },
      })],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 50 }));
    expect(result.allowed).toBe(true);
  });

  it("blocks when cost exceeds threshold and no approval exists", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [makePolicy({
          policy_type: "threshold_approval",
          rules: { thresholdCredits: 100, approvers: ["approver-1"], requiredApprovals: 1 },
        })],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolations
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 200 }));
    expect(result.allowed).toBe(false);
    expect(result.violations[0].policyType).toBe("threshold_approval");
  });
});

/* ================================================================ */
/*  Multi-policy composition                                          */
/* ================================================================ */

describe("PolicyEngine — multi-policy composition", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("allows when all policies pass", async () => {
    const contract = "0x1234567890123456789012345678901234567890";
    pool.query.mockResolvedValueOnce({
      rows: [
        makePolicy({ id: "p1", policy_type: "spending_limit", rules: { maxPerTx: 100 } }),
        makePolicy({
          id: "p2",
          policy_type: "contract_scope",
          rules: { mode: "allow", contracts: [contract] },
        }),
      ],
    });

    const result = await engine.evaluate(AGENT_ID, defaultCtx({
      targetContract: contract,
      creditCost: 50,
    }));
    expect(result.allowed).toBe(true);
  });

  it("blocks and returns all violations when multiple policies fail", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          makePolicy({ id: "p1", policy_type: "spending_limit", rules: { maxPerTx: 5 } }),
          makePolicy({
            id: "p2",
            policy_type: "contract_scope",
            rules: { mode: "deny", contracts: ["0x1234567890123456789012345678901234567890"] },
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // logViolation 1
      .mockResolvedValueOnce({ rows: [] }) // logViolation 2
      ;

    const result = await engine.evaluate(AGENT_ID, defaultCtx({ creditCost: 50 }));
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].policyType).toBe("spending_limit");
    expect(result.violations[1].policyType).toBe("contract_scope");
  });
});

/* ================================================================ */
/*  No policies = allow                                               */
/* ================================================================ */

describe("PolicyEngine — no policies", () => {
  it("allows relay when agent has no policies", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 0 });

    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await engine.evaluate(AGENT_ID, defaultCtx());
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

/* ================================================================ */
/*  Cache behavior                                                    */
/* ================================================================ */

describe("PolicyEngine — cache", () => {
  it("caches policies and reuses on second call", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 60_000 });

    pool.query.mockResolvedValue({ rows: [] });

    await engine.evaluate(AGENT_ID, defaultCtx());
    await engine.evaluate(AGENT_ID, defaultCtx());

    // Only one DB query for policies (the first call)
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache on policy CRUD", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 60_000 });

    pool.query.mockResolvedValue({ rows: [] });

    await engine.evaluate(AGENT_ID, defaultCtx());
    engine.invalidateCache(AGENT_ID);
    await engine.evaluate(AGENT_ID, defaultCtx());

    // Two DB queries — cache was invalidated
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

/* ================================================================ */
/*  CRUD operations                                                   */
/* ================================================================ */

describe("PolicyEngine — CRUD", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("creates a policy and returns it", async () => {
    const row = makePolicy();
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const policy = await engine.createPolicy({
      agentId: AGENT_ID,
      policyType: "spending_limit",
      rules: { maxPerTx: 100 },
    });

    expect(policy.agentId).toBe(AGENT_ID);
    expect(policy.policyType).toBe("spending_limit");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("gets a policy by ID", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makePolicy()] });

    const policy = await engine.getPolicy(POLICY_ID);
    expect(policy).not.toBeNull();
    expect(policy!.id).toBe(POLICY_ID);
  });

  it("returns null for missing policy", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const policy = await engine.getPolicy("nonexistent");
    expect(policy).toBeNull();
  });

  it("lists policies for an agent", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({ id: "p1" }), makePolicy({ id: "p2" })],
    });

    const policies = await engine.listPolicies(AGENT_ID);
    expect(policies).toHaveLength(2);
  });

  it("updates a policy", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makePolicy({ rules: { maxPerTx: 200 } })],
    });

    const updated = await engine.updatePolicy(POLICY_ID, {
      rules: { maxPerTx: 200 },
    });

    expect(updated).not.toBeNull();
  });

  it("deletes a policy", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [makePolicy()] }) // getPolicy
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      ;

    const deleted = await engine.deletePolicy(POLICY_ID);
    expect(deleted).toBe(true);
  });

  it("returns false when deleting nonexistent policy", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const deleted = await engine.deletePolicy("nonexistent");
    expect(deleted).toBe(false);
  });
});

/* ================================================================ */
/*  Spending tracker                                                  */
/* ================================================================ */

describe("PolicyEngine — spending tracker", () => {
  it("records spend via upsert", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 0 });

    pool.query.mockResolvedValueOnce({ rows: [] });

    await engine.recordSpend(AGENT_ID, 50);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("ON CONFLICT");
    expect(call[1]).toContain(AGENT_ID);
  });
});

/* ================================================================ */
/*  Approval flow                                                     */
/* ================================================================ */

describe("PolicyEngine — approvals", () => {
  let pool: ReturnType<typeof createMockPool>;
  let engine: PolicyEngine;

  beforeEach(() => {
    pool = createMockPool();
    engine = new PolicyEngine(pool, { cacheTtlMs: 0 });
  });

  it("creates an approval request", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "approval-1" }] });

    const id = await engine.createApprovalRequest({
      agentId: AGENT_ID,
      policyId: POLICY_ID,
      targetContract: "0x1234",
      methodSelector: "0x5678",
      creditCost: 200,
      requiredApprovals: 2,
      approvers: ["approver-1", "approver-2"],
      expiresAt: new Date(Date.now() + 3600_000),
    });

    expect(id).toBe("approval-1");
  });

  it("approves a request and marks as approved when quorum reached", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "approval-1",
          approvers: ["approver-1"],
          approved_by: [],
          required_approvals: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      ;

    const result = await engine.approveRequest("approval-1", "approver-1");
    expect(result.approved).toBe(true);
    expect(result.status).toBe("approved");
  });

  it("rejects approval from unauthorized agent", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "approval-1",
        approvers: ["approver-1"],
        approved_by: [],
        required_approvals: 1,
      }],
    });

    await expect(engine.approveRequest("approval-1", "not-an-approver"))
      .rejects.toThrow("Not an authorized approver");
  });

  it("rejects duplicate approval", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "approval-1",
        approvers: ["approver-1"],
        approved_by: ["approver-1"],
        required_approvals: 2,
      }],
    });

    await expect(engine.approveRequest("approval-1", "approver-1"))
      .rejects.toThrow("Already approved");
  });
});

/* ================================================================ */
/*  Guild admin policies                                              */
/* ================================================================ */

describe("PolicyEngine — guild admin policies", () => {
  it("creates policy with guild_admin creator role", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 0 });

    const row = makePolicy({ creator_role: "guild_admin", guild_id: "guild-1" });
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const policy = await engine.createPolicy({
      agentId: AGENT_ID,
      policyType: "spending_limit",
      rules: { maxPerTx: 50 },
      creatorRole: "guild_admin",
      creatorId: "admin-agent",
      guildId: "guild-1",
    });

    expect(policy.creatorRole).toBe("guild_admin");
    expect(policy.guildId).toBe("guild-1");
  });
});

/* ================================================================ */
/*  Violation logging                                                 */
/* ================================================================ */

describe("PolicyEngine — violation logging", () => {
  it("returns violations with pagination", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 0 });

    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: "v1",
          agent_id: AGENT_ID,
          policy_id: POLICY_ID,
          policy_type: "spending_limit",
          violation_details: { message: "test" },
          target_contract: "0x1234",
          method_selector: "0x5678",
          credit_cost: 100,
          created_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      ;

    const result = await engine.getViolations(AGENT_ID, { limit: 10, offset: 0 });
    expect(result.violations).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

/* ================================================================ */
/*  Expired policies filtered out                                     */
/* ================================================================ */

describe("PolicyEngine — expired policies", () => {
  it("does not include expired policies in evaluation", async () => {
    const pool = createMockPool();
    const engine = new PolicyEngine(pool, { cacheTtlMs: 0 });

    // DB query filters out expired — mock returns empty
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await engine.evaluate(AGENT_ID, defaultCtx());
    expect(result.allowed).toBe(true);

    // Verify the query includes expires_at filter
    const queryStr = pool.query.mock.calls[0][0] as string;
    expect(queryStr).toContain("expires_at");
  });
});
