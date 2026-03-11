import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationService, type ValidationTestRunner } from "./validationService.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("ethers", () => ({
  ethers: {
    Contract: vi.fn(),
    keccak256: vi.fn().mockReturnValue("0xmockhash"),
    toUtf8Bytes: vi.fn().mockReturnValue(new Uint8Array()),
    AbiCoder: { defaultAbiCoder: () => ({ encode: vi.fn().mockReturnValue("0xencoded") }) },
  },
}));

vi.mock("@nookplot/sdk/dist/abis.js", () => ({
  ERC8004_VALIDATION_REGISTRY_ABI: [],
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockIpfs() {
  return {
    uploadJson: vi.fn().mockResolvedValue({ cid: "bafytest123" }),
    getGatewayUrl: vi.fn().mockReturnValue("https://ipfs.example.com/bafytest123"),
  };
}

function createMockWallet() {
  return {
    address: "0xrelayer1111111111111111111111111111111111",
    connect: vi.fn().mockReturnThis(),
  };
}

const DEFAULT_CONFIG = {
  validationRegistryAddress: "", // no on-chain submission
  enabled: true,
  autoTrigger: true,
  cooldownMs: 60_000,
  maxConcurrent: 5,
};

function createService(
  pool: ReturnType<typeof createMockPool>,
  opts?: { config?: Partial<typeof DEFAULT_CONFIG> },
) {
  const ipfs = createMockIpfs();
  const wallet = createMockWallet();
  const config = { ...DEFAULT_CONFIG, ...opts?.config };
  const service = new ValidationService(
    pool as any,
    ipfs as any,
    wallet as any,
    {} as any, // provider — unused when no contract address
    config,
  );
  return { service, ipfs };
}

function createTestRunner(score = 75): ValidationTestRunner {
  return {
    name: "capability",
    runTest: vi.fn().mockResolvedValue({
      score,
      metrics: { accuracy: 0.8, latency: 200 },
      testPrompt: "What is 2+2?",
      testResponse: "4",
      proofMethod: "direct" as const,
    }),
  };
}

// ---------------------------------------------------------------------------
//  requestValidation
// ---------------------------------------------------------------------------

describe("ValidationService.requestValidation", () => {
  it("creates a validation request", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    // Cooldown check — no recent requests
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Agent ERC-8004 lookup
    pool.query.mockResolvedValueOnce({ rows: [{ erc8004_agent_id: "42" }], rowCount: 1 });
    // INSERT request
    pool.query.mockResolvedValueOnce({ rows: [{ id: "req-001" }], rowCount: 1 });

    const result = await service.requestValidation("agt_test");

    expect(result.requestId).toBe("req-001");
    expect(result.status).toBe("pending");
  });

  it("rejects invalid test type", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    await expect(
      service.requestValidation("agt_test", "invalid_type"),
    ).rejects.toThrow("Invalid test type");
  });

  it("enforces cooldown", async () => {
    const pool = createMockPool();
    const { service } = createService(pool, { config: { cooldownMs: 600_000 } });

    // Recent request within cooldown
    pool.query.mockResolvedValueOnce({
      rows: [{ created_at: new Date(Date.now() - 5000) }], // 5s ago
      rowCount: 1,
    });

    await expect(
      service.requestValidation("agt_test"),
    ).rejects.toThrow("cooldown");
  });

  it("allows request after cooldown expires", async () => {
    const pool = createMockPool();
    const { service } = createService(pool, { config: { cooldownMs: 1000 } });

    // Recent request beyond cooldown
    pool.query.mockResolvedValueOnce({
      rows: [{ created_at: new Date(Date.now() - 5000) }], // 5s ago, cooldown is 1s
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [{ erc8004_agent_id: null }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ id: "req-002" }], rowCount: 1 });

    const result = await service.requestValidation("agt_test");
    expect(result.requestId).toBe("req-002");
  });

  it("auto-runs test when runner is registered", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);
    const runner = createTestRunner();
    service.registerTestRunner(runner);

    // requestValidation queries
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // cooldown
    pool.query.mockResolvedValueOnce({ rows: [{ erc8004_agent_id: null }], rowCount: 1 }); // agent lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "req-003" }], rowCount: 1 }); // INSERT

    // runValidation queries (auto-triggered, runs async)
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-003", agent_id: "agt_test", erc8004_agent_id: null, status: "pending", test_type: "capability", test_config: {} }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE status to testing
    pool.query.mockResolvedValueOnce({ rows: [{ id: "res-001" }], rowCount: 1 }); // INSERT result
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE status to completed
    pool.query.mockResolvedValueOnce({
      rows: [{ count: "1", avg: "75", max_date: new Date(), last_score: 75 }],
      rowCount: 1,
    }); // recomputeSummary query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT/UPDATE summary

    const result = await service.requestValidation("agt_test", "capability");
    expect(result.requestId).toBe("req-003");

    // Wait for auto-run to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.runTest).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  runValidation
// ---------------------------------------------------------------------------

describe("ValidationService.runValidation", () => {
  it("runs test and stores result", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);
    const runner = createTestRunner(85);
    service.registerTestRunner(runner);

    // Load request
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "req-001",
        agent_id: "agt_test",
        erc8004_agent_id: null,
        status: "pending",
        test_type: "capability",
        test_config: {},
      }],
      rowCount: 1,
    });
    // UPDATE status → testing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // INSERT result
    pool.query.mockResolvedValueOnce({ rows: [{ id: "res-001" }], rowCount: 1 });
    // UPDATE status → completed
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // recomputeSummary: query stats
    pool.query.mockResolvedValueOnce({
      rows: [{ count: "3", avg: "80", max_date: new Date(), last_score: 85 }],
      rowCount: 1,
    });
    // recomputeSummary: upsert summary
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.runValidation("req-001");

    expect(result.resultId).toBe("res-001");
    expect(result.score).toBe(85);
    expect(result.badge).toBe("verified"); // count=3, avg=80 → verified
    expect(runner.runTest).toHaveBeenCalledWith("agt_test", {
      testType: "capability",
      customConfig: {},
    });
  });

  it("throws when request not found", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(service.runValidation("req-missing")).rejects.toThrow("not found");
  });

  it("throws when already completed", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-001", status: "completed", test_type: "capability" }],
      rowCount: 1,
    });

    await expect(service.runValidation("req-001")).rejects.toThrow("already completed");
  });

  it("throws when no runner registered", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-001", agent_id: "agt_test", status: "pending", test_type: "inference", test_config: {} }],
      rowCount: 1,
    });

    await expect(service.runValidation("req-001")).rejects.toThrow("No test runner");
  });

  it("clamps score to 0-100", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);
    const runner: ValidationTestRunner = {
      name: "capability",
      runTest: vi.fn().mockResolvedValue({
        score: 150, // over 100
        metrics: {},
        testPrompt: "test",
        testResponse: "response",
        proofMethod: "direct",
      }),
    };
    service.registerTestRunner(runner);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-001", agent_id: "agt_test", erc8004_agent_id: null, status: "pending", test_type: "capability", test_config: {} }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE testing
    pool.query.mockResolvedValueOnce({ rows: [{ id: "res-001" }], rowCount: 1 }); // INSERT result
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE completed
    pool.query.mockResolvedValueOnce({ rows: [{ count: "1", avg: "100", max_date: new Date(), last_score: 100 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.runValidation("req-001");
    expect(result.score).toBe(100); // clamped to 100
  });

  it("marks request as failed on error", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);
    const runner: ValidationTestRunner = {
      name: "capability",
      runTest: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };
    service.registerTestRunner(runner);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-001", agent_id: "agt_test", erc8004_agent_id: null, status: "pending", test_type: "capability", test_config: {} }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE testing
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE failed

    await expect(service.runValidation("req-001")).rejects.toThrow("LLM unavailable");

    // Verify status was set to 'failed'
    const failCall = pool.query.mock.calls[2];
    expect(failCall[0]).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
//  getValidationStatus
// ---------------------------------------------------------------------------

describe("ValidationService.getValidationStatus", () => {
  it("returns request with result", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-001", agent_id: "agt_test", status: "completed" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "res-001", response_score: 85 }],
      rowCount: 1,
    });

    const status = await service.getValidationStatus("req-001");

    expect(status.request.id).toBe("req-001");
    expect(status.result?.id).toBe("res-001");
  });

  it("returns null result when not completed", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "req-001", status: "pending" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const status = await service.getValidationStatus("req-001");

    expect(status.request.id).toBe("req-001");
    expect(status.result).toBeNull();
  });

  it("throws when request not found", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(service.getValidationStatus("req-missing")).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
//  getAgentSummary / getAgentSummaryByAddress
// ---------------------------------------------------------------------------

describe("ValidationService.getAgentSummary", () => {
  it("returns summary", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_test", total_validations: 5, avg_score: 80, badge_level: "trusted" }],
      rowCount: 1,
    });

    const summary = await service.getAgentSummary("agt_test");

    expect(summary).not.toBeNull();
    expect(summary!.badge_level).toBe("trusted");
  });

  it("returns null when no summary exists", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const summary = await service.getAgentSummary("agt_missing");
    expect(summary).toBeNull();
  });
});

describe("ValidationService.getAgentSummaryByAddress", () => {
  it("returns summary by address", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{ agent_id: "agt_test", avg_score: 90, badge_level: "elite" }],
      rowCount: 1,
    });

    const summary = await service.getAgentSummaryByAddress("0x1111");
    expect(summary!.badge_level).toBe("elite");
  });
});

// ---------------------------------------------------------------------------
//  listValidations
// ---------------------------------------------------------------------------

describe("ValidationService.listValidations", () => {
  it("returns validation history", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "res-1", response_score: 80 },
        { id: "res-2", response_score: 90 },
      ],
      rowCount: 2,
    });

    const results = await service.listValidations("agt_test", 10, 0);
    expect(results).toHaveLength(2);
  });

  it("caps limit to 100", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await service.listValidations("agt_test", 500, 0);

    const params = pool.query.mock.calls[0][1];
    expect(params[1]).toBe(100); // capped
  });
});

// ---------------------------------------------------------------------------
//  recomputeSummary — badge levels
// ---------------------------------------------------------------------------

describe("ValidationService.recomputeSummary", () => {
  const badgeCases = [
    { count: 10, avg: 85, expected: "elite" },
    { count: 5, avg: 70, expected: "trusted" },
    { count: 3, avg: 50, expected: "verified" },
    { count: 1, avg: 30, expected: "basic" },
    { count: 0, avg: 0, expected: "none" },
    { count: 2, avg: 90, expected: "basic" }, // high score but not enough count
    { count: 10, avg: 40, expected: "basic" }, // high count but low avg
  ];

  for (const { count, avg, expected } of badgeCases) {
    it(`returns "${expected}" for count=${count}, avg=${avg}`, async () => {
      const pool = createMockPool();
      const { service } = createService(pool);

      pool.query.mockResolvedValueOnce({
        rows: [{ count: String(count), avg: String(avg), max_date: count > 0 ? new Date() : null, last_score: avg }],
        rowCount: 1,
      });
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // upsert

      const badge = await service.recomputeSummary("agt_test");
      expect(badge).toBe(expected);
    });
  }
});
