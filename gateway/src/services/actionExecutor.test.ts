import { describe, it, expect, vi } from "vitest";
import { ActionExecutor } from "./actionExecutor.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function createMockRegistry() {
  return {
    getHandler: vi.fn(),
    getRateLimit: vi.fn().mockReturnValue({ maxPerHour: 10, maxPerDay: 50 }),
    getCost: vi.fn().mockReturnValue(100),
    getAutonomyLevel: vi.fn().mockReturnValue("autonomous"),
    get: vi.fn(),
    checkBoundaryViolation: vi.fn(),
    mapOpportunityToAction: vi.fn(),
  };
}

function createMockCreditManager() {
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: 10000, status: "active" }),
    addCredits: vi.fn(),
    deductCredits: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
//  processApprovedActions
// ---------------------------------------------------------------------------

describe("ActionExecutor — processApprovedActions", () => {
  it("returns zeros when no approved actions exist", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    const result = await executor.processApprovedActions();

    expect(result).toEqual({ executed: 0, failed: 0 });
  });

  it("processes approved actions and counts successes", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    const handler = vi.fn().mockResolvedValue({ success: true, output: { done: true }, creditsUsed: 100 });
    registry.getHandler.mockReturnValue(handler);

    // SELECT approved actions
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "act_1", agent_id: "agt_1", action_type: "create_post", payload: "{}", inference_cost: 100 }],
      rowCount: 1,
    });
    // Rate limit check
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "0", daily: "0" }], rowCount: 1 });
    // deductCredits handled by mock
    // UPDATE status = 'executing'
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // UPDATE status = 'completed'
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // INSERT action_execution_log
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.processApprovedActions();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
    expect(handler).toHaveBeenCalled();
  });

  it("counts failures for actions that throw", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    registry.getHandler.mockReturnValue(null); // no handler → will fail

    // SELECT approved actions
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "act_1", agent_id: "agt_1", action_type: "unknown_tool", payload: "{}", inference_cost: 100 }],
      rowCount: 1,
    });
    // markActionFailed UPDATE
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution INSERT
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.processApprovedActions();

    expect(result.executed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("handles query failure gracefully", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    const result = await executor.processApprovedActions();

    expect(result).toEqual({ executed: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
//  executeAction
// ---------------------------------------------------------------------------

describe("ActionExecutor — executeAction", () => {
  it("fails when no handler registered", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.getHandler.mockReturnValue(null);

    // markActionFailed UPDATE
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution INSERT
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeAction("act_1", "agt_1", "nonexistent", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("No handler registered");
  });

  it("fails when hourly rate limit exceeded", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.getHandler.mockReturnValue(vi.fn());
    registry.getRateLimit.mockReturnValue({ maxPerHour: 5, maxPerDay: 50 });

    // Rate limit query returns 5 hourly (at limit)
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "5", daily: "10" }], rowCount: 1 });
    // markActionFailed
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit exceeded");
    expect(result.error).toContain("per hour");
  });

  it("fails when daily rate limit exceeded", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.getHandler.mockReturnValue(vi.fn());
    registry.getRateLimit.mockReturnValue({ maxPerHour: 100, maxPerDay: 10 });

    // Hourly ok, daily at limit
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "2", daily: "10" }], rowCount: 1 });
    // markActionFailed
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit exceeded");
    expect(result.error).toContain("per day");
  });

  it("fails closed when rate limit check throws", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.getHandler.mockReturnValue(vi.fn());

    // Rate limit query fails
    pool.query.mockRejectedValueOnce(new Error("table missing"));
    // markActionFailed
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked for safety");
  });

  it("fails when credits insufficient", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    registry.getHandler.mockReturnValue(vi.fn());
    registry.getCost.mockReturnValue(500);
    creditManager.getBalance.mockResolvedValue({ balance: 100, status: "active" });

    // Rate limit check ok
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "0", daily: "0" }], rowCount: 1 });
    // markActionFailed
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient credits");
  });

  it("fails when account is paused", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    registry.getHandler.mockReturnValue(vi.fn());
    creditManager.getBalance.mockResolvedValue({ balance: 10000, status: "paused" });

    // Rate limit check
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "0", daily: "0" }], rowCount: 1 });
    // markActionFailed
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient credits or account paused");
  });

  it("succeeds end-to-end with valid handler", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    const handler = vi.fn().mockResolvedValue({ success: true, output: { postId: "p_1" }, creditsUsed: 100 });
    registry.getHandler.mockReturnValue(handler);
    registry.getCost.mockReturnValue(100);

    // Rate limit check
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "0", daily: "0" }], rowCount: 1 });
    // UPDATE status = 'executing'
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // UPDATE status = 'completed'
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // INSERT action_execution_log
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", { content: "hello" });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ postId: "p_1" });
    expect(creditManager.deductCredits).toHaveBeenCalledWith("agt_1", 100, "act_1");
  });

  it("marks failed when handler throws", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    registry.getHandler.mockReturnValue(vi.fn().mockRejectedValue(new Error("handler crashed")));
    registry.getCost.mockReturnValue(50);

    // Rate limit check
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "0", daily: "0" }], rowCount: 1 });
    // UPDATE status = 'executing'
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // markActionFailed UPDATE
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution INSERT
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("handler crashed");
    // Credits still charged (no refund on handler crash)
    expect(result.creditsUsed).toBe(50);
  });

  it("fails when credit deduction throws", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    const creditManager = createMockCreditManager();

    registry.getHandler.mockReturnValue(vi.fn());
    creditManager.deductCredits.mockRejectedValue(new Error("concurrent deduction"));

    // Rate limit check
    pool.query.mockResolvedValueOnce({ rows: [{ hourly: "0", daily: "0" }], rowCount: 1 });
    // markActionFailed
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    // logExecution
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, creditManager as any);
    const result = await executor.executeAction("act_1", "agt_1", "create_post", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Credit deduction failed");
  });
});

// ---------------------------------------------------------------------------
//  executeDirectly
// ---------------------------------------------------------------------------

describe("ActionExecutor — executeDirectly", () => {
  it("returns error for unknown tool", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue(null);

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeDirectly("agt_1", "nonexistent", {}, "autonomous" as any);

    expect(result.requiresApproval).toBe(false);
    expect(result.result?.success).toBe(false);
    expect(result.result?.error).toContain("Unknown tool");
  });

  it("returns error when tool is disabled for agent", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue({ name: "create_post", cost: 100, handler: vi.fn() });

    // agent_tool_config query — tool is disabled
    pool.query.mockResolvedValueOnce({ rows: [{ enabled: false }], rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeDirectly("agt_1", "create_post", {}, "autonomous" as any);

    expect(result.requiresApproval).toBe(false);
    expect(result.result?.error).toContain("disabled for this agent");
  });

  it("requires approval for supervised autonomy level", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue({ name: "create_post", cost: 100, handler: vi.fn() });
    registry.getAutonomyLevel.mockReturnValue("autonomous");

    // agent_tool_config — not found (enabled by default)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT pending action
    pool.query.mockResolvedValueOnce({ rows: [{ id: "act_pending" }], rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeDirectly("agt_1", "create_post", {}, "supervised" as any);

    expect(result.requiresApproval).toBe(true);
    expect(result.actionId).toBe("act_pending");
    expect(result.result).toBeUndefined();
  });

  it("requires approval for supervised tool autonomy", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue({ name: "claim_bounty", cost: 500, handler: vi.fn() });
    registry.getAutonomyLevel.mockReturnValue("supervised");

    // agent_tool_config — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT pending action
    pool.query.mockResolvedValueOnce({ rows: [{ id: "act_sup" }], rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    // Even with "autonomous" agent level, supervised tool requires approval
    const result = await executor.executeDirectly("agt_1", "claim_bounty", {}, "autonomous" as any);

    expect(result.requiresApproval).toBe(true);
  });

  it("requires approval for semi-autonomous with high cost", async () => {
    const pool = createMockPool();
    const registry = createMockRegistry();
    registry.get.mockReturnValue({ name: "expensive_tool", cost: 5000, handler: vi.fn() });
    registry.getAutonomyLevel.mockReturnValue("autonomous");

    // agent_tool_config — not found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT pending action
    pool.query.mockResolvedValueOnce({ rows: [{ id: "act_exp" }], rowCount: 1 });

    const executor = new ActionExecutor(pool as any, registry as any, createMockCreditManager() as any);
    const result = await executor.executeDirectly("agt_1", "expensive_tool", {}, "semi-autonomous" as any);

    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  getExecutionLog
// ---------------------------------------------------------------------------

describe("ActionExecutor — getExecutionLog", () => {
  it("returns mapped execution log entries", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "log_1",
        agent_id: "agt_1",
        tool_name: "create_post",
        status: "completed",
        credits_charged: 100,
        duration_ms: 250,
        error_message: null,
        created_at: "2025-06-01",
        completed_at: "2025-06-01",
      }],
      rowCount: 1,
    });

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    const logs = await executor.getExecutionLog("agt_1");

    expect(logs).toHaveLength(1);
    expect(logs[0].toolName).toBe("create_post");
    expect(logs[0].creditsCharged).toBe(100);
    expect(logs[0].durationMs).toBe(250);
    expect(logs[0].errorMessage).toBeNull();
  });

  it("passes limit and offset to query", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    await executor.getExecutionLog("agt_1", 25, 10);

    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params).toEqual(["agt_1", 25, 10]);
  });
});

// ---------------------------------------------------------------------------
//  cleanupStaleActions
// ---------------------------------------------------------------------------

describe("ActionExecutor — cleanupStaleActions", () => {
  it("returns count of cleaned up actions", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rowCount: 3 });

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    const count = await executor.cleanupStaleActions();

    expect(count).toBe(3);
  });

  it("returns 0 when no stale actions", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    const count = await executor.cleanupStaleActions();

    expect(count).toBe(0);
  });

  it("returns 0 on query failure", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    const executor = new ActionExecutor(pool as any, createMockRegistry() as any, createMockCreditManager() as any);
    const count = await executor.cleanupStaleActions();

    expect(count).toBe(0);
  });
});
