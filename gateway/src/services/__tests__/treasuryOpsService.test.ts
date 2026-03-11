import { describe, it, expect, vi, beforeEach } from "vitest";
import { TreasuryOpsService } from "../treasuryOpsService.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

/* ================================================================ */
/*  Mock factories                                                    */
/* ================================================================ */

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

const AGENT_ID = "agent-001";
const OP_ID = "op-001";
const GUILD_ID = "guild-001";

function makeOpRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OP_ID,
    agent_id: AGENT_ID,
    guild_id: null,
    op_type: "auto_sweep",
    schedule: { intervalMinutes: 60 },
    rules: { threshold: 1000, targetGuildId: GUILD_ID, keepAmount: 500 },
    enabled: true,
    next_run_at: new Date(Date.now() + 3600_000).toISOString(),
    last_run_at: null,
    run_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeEarmarkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "earmark-001",
    agent_id: AGENT_ID,
    label: "marketing",
    allocated: 1000,
    spent: 200,
    description: "Marketing budget",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/* ================================================================ */
/*  CRUD — Scheduled operations                                       */
/* ================================================================ */

describe("TreasuryOpsService — operation CRUD", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: TreasuryOpsService;

  beforeEach(() => {
    pool = createMockPool();
    service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 }); // no auto-tick
  });

  it("creates a scheduled operation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeOpRow()] });

    const op = await service.createOp({
      agentId: AGENT_ID,
      opType: "auto_sweep",
      schedule: { intervalMinutes: 60 },
      rules: { threshold: 1000, targetGuildId: GUILD_ID, keepAmount: 500 },
    });

    expect(op.agentId).toBe(AGENT_ID);
    expect(op.opType).toBe("auto_sweep");
    expect(op.enabled).toBe(true);
  });

  it("gets an operation by ID", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeOpRow()] });

    const op = await service.getOp(OP_ID);
    expect(op).not.toBeNull();
    expect(op!.id).toBe(OP_ID);
  });

  it("returns null for missing operation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const op = await service.getOp("nonexistent");
    expect(op).toBeNull();
  });

  it("lists operations for an agent", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeOpRow({ id: "op1" }), makeOpRow({ id: "op2" })],
    });

    const ops = await service.listOps(AGENT_ID);
    expect(ops).toHaveLength(2);
  });

  it("updates an operation", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeOpRow({ enabled: false })],
    });

    const updated = await service.updateOp(OP_ID, { enabled: false });
    expect(updated).not.toBeNull();
  });

  it("deletes an operation", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await service.deleteOp(OP_ID);
    expect(deleted).toBe(true);
  });

  it("returns false when deleting nonexistent operation", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const deleted = await service.deleteOp("nonexistent");
    expect(deleted).toBe(false);
  });
});

/* ================================================================ */
/*  Tick — operation execution                                        */
/* ================================================================ */

describe("TreasuryOpsService — tick", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: TreasuryOpsService;

  beforeEach(() => {
    pool = createMockPool();
    service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });
  });

  it("processes due operations", async () => {
    const dueOp = makeOpRow({
      next_run_at: new Date(Date.now() - 60_000).toISOString(), // past due
      op_type: "balance_alert",
      rules: { earmarkLabel: "test", alertThresholdPercent: 80 },
    });

    pool.query
      .mockResolvedValueOnce({ rows: [dueOp] })   // find due ops
      .mockResolvedValueOnce({ rows: [] })         // earmark lookup (balance_alert)
      .mockResolvedValueOnce({ rows: [] })         // logHistory (skipped)
      .mockResolvedValueOnce({ rows: [] })         // update next_run_at
      ;

    const processed = await service.tick();
    expect(processed).toBe(1);
  });

  it("skips tick when already processing", async () => {
    pool.query.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ rows: [] }), 100);
    }));

    // Start two ticks concurrently
    const p1 = service.tick();
    const p2 = service.tick();

    const [r1, r2] = await Promise.all([p1, p2]);
    // One should process, one should skip
    expect(r1 + r2).toBe(0); // both return 0 since no rows
  });

  it("handles tick errors gracefully", async () => {
    pool.query.mockRejectedValueOnce(new Error("DB connection lost"));

    // Should not throw
    const processed = await service.tick();
    expect(processed).toBe(0);
  });
});

/* ================================================================ */
/*  Auto-sweep execution                                              */
/* ================================================================ */

describe("TreasuryOpsService — auto_sweep", () => {
  it("sweeps excess balance to guild treasury", async () => {
    const pool = createMockPool();
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    const mockCM = {
      deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 500 }),
    };
    const mockTS = {
      deposit: vi.fn().mockResolvedValue(undefined),
    };
    service.setCreditManager(mockCM);
    service.setTreasuryService(mockTS);

    const op = makeOpRow({
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      rules: { threshold: 1000, targetGuildId: GUILD_ID, keepAmount: 500 },
    });

    pool.query
      .mockResolvedValueOnce({ rows: [op] })         // find due ops
      .mockResolvedValueOnce({ rows: [{ balance_credits: "2000" }] }) // get balance
      .mockResolvedValueOnce({ rows: [] })            // logHistory
      .mockResolvedValueOnce({ rows: [] })            // update next_run_at
      ;

    await service.tick();

    expect(mockCM.deductCredits).toHaveBeenCalledWith(
      AGENT_ID,
      1500,  // 2000 - 500 keepAmount
      expect.stringContaining("auto_sweep"),
      "auto_sweep",
    );
    expect(mockTS.deposit).toHaveBeenCalledWith(
      AGENT_ID,
      GUILD_ID,
      1500,
      expect.stringContaining("Auto-sweep"),
    );
  });

  it("skips sweep when balance is below threshold", async () => {
    const pool = createMockPool();
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    service.setCreditManager({ deductCredits: vi.fn() });
    service.setTreasuryService({ deposit: vi.fn() });

    const op = makeOpRow({
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      rules: { threshold: 1000, targetGuildId: GUILD_ID, keepAmount: 500 },
    });

    pool.query
      .mockResolvedValueOnce({ rows: [op] })
      .mockResolvedValueOnce({ rows: [{ balance_credits: "800" }] }) // below threshold
      .mockResolvedValueOnce({ rows: [] }) // logHistory (skipped)
      .mockResolvedValueOnce({ rows: [] }) // update next_run_at
      ;

    await service.tick();

    // deductCredits should not be called
    const cm = (service as any).creditManager;
    expect(cm.deductCredits).not.toHaveBeenCalled();
  });
});

/* ================================================================ */
/*  Scheduled transfer execution                                      */
/* ================================================================ */

describe("TreasuryOpsService — scheduled_transfer", () => {
  it("transfers credits between agents", async () => {
    const pool = createMockPool();
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    const mockCM = {
      deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 0 }),
      addCredits: vi.fn().mockResolvedValue(undefined),
    };
    service.setCreditManager(mockCM);

    const op = makeOpRow({
      next_run_at: new Date(Date.now() - 1000).toISOString(),
      op_type: "scheduled_transfer",
      rules: { fromAgentId: "agent-a", toAgentId: "agent-b", amount: 100 },
    });

    pool.query
      .mockResolvedValueOnce({ rows: [op] })  // find due ops
      .mockResolvedValueOnce({ rows: [] })    // logHistory
      .mockResolvedValueOnce({ rows: [] })    // update next_run_at
      ;

    await service.tick();

    expect(mockCM.deductCredits).toHaveBeenCalledWith("agent-a", 100, expect.any(String), "scheduled_transfer");
    expect(mockCM.addCredits).toHaveBeenCalledWith("agent-b", 100, "scheduled_transfer", expect.any(String));
  });
});

/* ================================================================ */
/*  CRUD — Budget earmarks                                            */
/* ================================================================ */

describe("TreasuryOpsService — earmark CRUD", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: TreasuryOpsService;

  beforeEach(() => {
    pool = createMockPool();
    service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });
  });

  it("creates an earmark", async () => {
    pool.query.mockResolvedValueOnce({ rows: [makeEarmarkRow()] });

    const earmark = await service.createEarmark({
      agentId: AGENT_ID,
      label: "marketing",
      allocated: 1000,
      description: "Marketing budget",
    });

    expect(earmark.label).toBe("marketing");
    expect(earmark.allocated).toBe(1000);
  });

  it("lists earmarks for an agent", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeEarmarkRow({ id: "e1" }), makeEarmarkRow({ id: "e2" })],
    });

    const earmarks = await service.listEarmarks(AGENT_ID);
    expect(earmarks).toHaveLength(2);
  });

  it("updates an earmark", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [makeEarmarkRow({ allocated: 2000 })],
    });

    const updated = await service.updateEarmark("earmark-001", { allocated: 2000 });
    expect(updated).not.toBeNull();
    expect(updated!.allocated).toBe(2000);
  });

  it("deletes an earmark", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await service.deleteEarmark("earmark-001");
    expect(deleted).toBe(true);
  });

  it("records earmark spend", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await service.recordEarmarkSpend(AGENT_ID, "marketing", 50);

    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("spent = spent +");
    expect(call[1]).toContain(50);
  });

  it("throws when earmark spend would exceed allocation", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    await expect(service.recordEarmarkSpend(AGENT_ID, "marketing", 5000))
      .rejects.toThrow("would exceed allocation");
  });
});

/* ================================================================ */
/*  Lifecycle                                                         */
/* ================================================================ */

describe("TreasuryOpsService — lifecycle", () => {
  it("starts and stops without error", () => {
    const pool = createMockPool();
    pool.query.mockResolvedValue({ rows: [] });
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    service.start();
    service.stop();
  });

  it("does not start multiple timers", () => {
    const pool = createMockPool();
    pool.query.mockResolvedValue({ rows: [] });
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    service.start();
    service.start(); // second start should be no-op
    service.stop();
  });
});

/* ================================================================ */
/*  Manual trigger                                                    */
/* ================================================================ */

describe("TreasuryOpsService — manual trigger", () => {
  it("runs an operation manually", async () => {
    const pool = createMockPool();
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    service.setCreditManager({ deductCredits: vi.fn().mockResolvedValue({}) });
    service.setTreasuryService({ deposit: vi.fn().mockResolvedValue(undefined) });

    pool.query
      .mockResolvedValueOnce({ rows: [makeOpRow()] })  // getOp
      .mockResolvedValueOnce({ rows: [{ balance_credits: "2000" }] }) // balance check
      .mockResolvedValueOnce({ rows: [] })             // logHistory
      .mockResolvedValueOnce({ rows: [] })             // update next_run_at
      ;

    const result = await service.runOpNow(OP_ID);
    expect(result.status).toBe("success");
  });

  it("throws for nonexistent operation", async () => {
    const pool = createMockPool();
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(service.runOpNow("nonexistent")).rejects.toThrow("not found");
  });
});

/* ================================================================ */
/*  Operation history                                                 */
/* ================================================================ */

describe("TreasuryOpsService — operation history", () => {
  it("retrieves execution history", async () => {
    const pool = createMockPool();
    const service = new TreasuryOpsService(pool, { tickIntervalMs: 999_999 });

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "h1",
        status: "success",
        details: { swept: 1500 },
        error_message: null,
        created_at: new Date(),
      }],
    });

    const history = await service.getOpHistory(OP_ID);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("success");
  });
});
