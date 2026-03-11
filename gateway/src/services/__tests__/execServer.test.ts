import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecServer, EXEC_BASE_COST, EXEC_COST_PER_SECOND } from "../execServer.js";

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 500 }),
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 550 }),
  } as any;
}

function createMockExecService(result = { exitCode: 0, durationMs: 5000 }) {
  return {
    startExecution: vi.fn().mockResolvedValue(result),
    isAvailable: vi.fn().mockResolvedValue(true),
  } as any;
}

/** Collect messages sent via sendJson to a mock WebSocket */
function createMockWs() {
  const messages: any[] = [];
  return {
    ws: {
      readyState: 1, // WebSocket.OPEN
      send: vi.fn((data: string) => messages.push(JSON.parse(data))),
      OPEN: 1,
    } as any,
    messages,
  };
}

const AGENT_ID = "agent-test-001";
const PROJECT_ID = "proj-123";
const HMAC_SECRET = "test-secret";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ExecServer credit charging", () => {
  let pool: ReturnType<typeof createMockPool>;
  let creditManager: ReturnType<typeof createMockCreditManager>;
  let execService: ReturnType<typeof createMockExecService>;
  let server: ExecServer;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    execService = createMockExecService();
    server = new ExecServer(pool, execService, HMAC_SECRET);
    server.setCreditManager(creditManager);
  });

  /** Helper: call the private handleExecStart method directly */
  async function execStart(ws: any, overrides: Record<string, unknown> = {}) {
    const msg = {
      type: "exec:start",
      command: "echo hello",
      image: "node:20-slim",
      files: {},
      ...overrides,
    };
    // Access the private method via bracket notation
    await (server as any).handleExecStart(ws, AGENT_ID, PROJECT_ID, msg);
  }

  it("pre-deducts base cost before starting execution", async () => {
    const { ws } = createMockWs();
    await execStart(ws);

    expect(creditManager.deductCredits).toHaveBeenCalledWith(
      AGENT_ID,
      EXEC_BASE_COST,
      expect.stringContaining("exec-"),
      "sandbox_exec",
    );

    // Execution should have started
    expect(execService.startExecution).toHaveBeenCalled();
  });

  it("applies time surcharge after execution completes", async () => {
    const durationMs = 5000;
    execService = createMockExecService({ exitCode: 0, durationMs });
    server = new ExecServer(pool, execService, HMAC_SECRET);
    server.setCreditManager(creditManager);

    const { ws, messages } = createMockWs();
    await execStart(ws);

    const expectedSurcharge = Math.ceil(durationMs / 1000) * EXEC_COST_PER_SECOND;

    // Second deductCredits call = surcharge
    expect(creditManager.deductCredits).toHaveBeenCalledTimes(2);
    expect(creditManager.deductCredits).toHaveBeenNthCalledWith(
      2,
      AGENT_ID,
      expectedSurcharge,
      expect.stringContaining("-surcharge"),
      "sandbox_exec_time",
    );

    // exec:exit should include creditsCharged
    const exitMsg = messages.find((m) => m.type === "exec:exit");
    expect(exitMsg).toBeDefined();
    expect(exitMsg!.creditsCharged).toBe(EXEC_BASE_COST + expectedSurcharge);
  });

  it("refunds base cost on execution failure", async () => {
    execService = createMockExecService();
    execService.startExecution.mockRejectedValue(new Error("Container failed to start"));
    server = new ExecServer(pool, execService, HMAC_SECRET);
    server.setCreditManager(creditManager);

    const { ws, messages } = createMockWs();
    await execStart(ws);

    // Should refund base cost
    expect(creditManager.addCredits).toHaveBeenCalledWith(
      AGENT_ID,
      EXEC_BASE_COST,
      "sandbox_exec_refund",
      expect.stringContaining("-refund"),
    );

    // Should send exec:error
    const errorMsg = messages.find((m) => m.type === "exec:error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toBe("Container failed to start");
  });

  it("returns exec:error on INSUFFICIENT_CREDITS without starting container", async () => {
    creditManager.deductCredits.mockRejectedValue(new Error("INSUFFICIENT_CREDITS"));

    const { ws, messages } = createMockWs();
    await execStart(ws);

    // Should NOT start execution
    expect(execService.startExecution).not.toHaveBeenCalled();

    // Should send error
    const errorMsg = messages.find((m) => m.type === "exec:error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toContain("Insufficient credits");
  });

  it("returns exec:error on ACCOUNT_NOT_FOUND without starting container", async () => {
    creditManager.deductCredits.mockRejectedValue(new Error("ACCOUNT_NOT_FOUND"));

    const { ws, messages } = createMockWs();
    await execStart(ws);

    expect(execService.startExecution).not.toHaveBeenCalled();
    const errorMsg = messages.find((m) => m.type === "exec:error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toContain("Insufficient credits");
  });

  it("returns exec:error on DAILY_SPEND_LIMIT without starting container", async () => {
    creditManager.deductCredits.mockRejectedValue(new Error("DAILY_SPEND_LIMIT"));

    const { ws, messages } = createMockWs();
    await execStart(ws);

    expect(execService.startExecution).not.toHaveBeenCalled();
    const errorMsg = messages.find((m) => m.type === "exec:error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.message).toContain("Daily spend limit");
  });

  it("skips charging when creditManager is not set (graceful degradation)", async () => {
    server = new ExecServer(pool, execService, HMAC_SECRET);
    // No setCreditManager call

    const { ws, messages } = createMockWs();
    await execStart(ws);

    // Execution should proceed
    expect(execService.startExecution).toHaveBeenCalled();

    // exec:exit should have creditsCharged = 0
    const exitMsg = messages.find((m) => m.type === "exec:exit");
    expect(exitMsg).toBeDefined();
    expect(exitMsg!.creditsCharged).toBe(0);
  });

  it("includes credits_charged in audit log INSERT", async () => {
    const durationMs = 3000;
    execService = createMockExecService({ exitCode: 0, durationMs });
    server = new ExecServer(pool, execService, HMAC_SECRET);
    server.setCreditManager(creditManager);

    const { ws } = createMockWs();
    await execStart(ws);

    const expectedSurcharge = Math.ceil(durationMs / 1000) * EXEC_COST_PER_SECOND;
    const expectedTotal = EXEC_BASE_COST + expectedSurcharge;

    // pool.query should have been called with credits_charged
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("credits_charged"),
      expect.arrayContaining([expectedTotal]),
    );
  });
});
