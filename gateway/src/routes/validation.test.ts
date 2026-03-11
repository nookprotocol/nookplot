import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createValidationRouter } from "./validation.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_val", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

function createMockValidationService() {
  return {
    requestValidation: vi.fn().mockResolvedValue({ id: "req_1", status: "pending" }),
    getValidationStatus: vi.fn().mockResolvedValue({
      request: {
        id: "req_1", agent_id: TEST_AGENT.id, status: "completed",
        test_type: "capability", created_at: "2025-06-01", updated_at: "2025-06-01",
      },
      result: {
        response_score: 85, test_metrics: { accuracy: 0.9 },
        proof_method: "llm", tag: "v1", tx_hash: "0xabc", created_at: "2025-06-01",
      },
    }),
    getAgentSummaryByAddress: vi.fn().mockResolvedValue({
      badge_level: "gold", total_validations: 5, avg_score: 88.5,
      last_score: 92, last_validated: "2025-06-01", computed_at: "2025-06-01",
    }),
    listValidations: vi.fn().mockResolvedValue([{
      id: "res_1", response_score: 90, test_metrics: {},
      proof_method: "llm", tag: "v1", tx_hash: "0xdef", created_at: "2025-06-01",
    }]),
    getOnChainSummary: vi.fn().mockResolvedValue({
      count: BigInt(3), averageResponse: 85,
    }),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  svc?: ReturnType<typeof createMockValidationService>,
) {
  const validationService = svc ?? createMockValidationService();
  const router = createValidationRouter({
    pool: pool as any,
    hmacSecret: TEST_HMAC_SECRET,
    validationService: validationService as any,
  });
  return { app: createTestApp(router), validationService };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

const VALID_ADDRESS = "0x" + "1".repeat(40);

// ---------------------------------------------------------------------------
//  POST /v1/validation/request
// ---------------------------------------------------------------------------

describe("POST /v1/validation/request", () => {
  it("creates a validation request", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/validation/request")
      .set(authHeader())
      .send({ testType: "capability" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("req_1");
    expect(svc.requestValidation).toHaveBeenCalledWith(TEST_AGENT.id, "capability", undefined);
  });

  it("defaults testType to capability", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    await request(app)
      .post("/v1/validation/request")
      .set(authHeader())
      .send({});

    expect(svc.requestValidation).toHaveBeenCalledWith(TEST_AGENT.id, "capability", undefined);
  });

  it("returns 429 on cooldown error", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    svc.requestValidation.mockRejectedValue(new Error("cooldown period active"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/validation/request")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(429);
  });

  it("returns 400 on invalid test type", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    svc.requestValidation.mockRejectedValue(new Error("Invalid test type"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/validation/request")
      .set(authHeader())
      .send({ testType: "bogus" });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/validation/status/:id
// ---------------------------------------------------------------------------

describe("GET /v1/validation/status/:id", () => {
  const validUUID = "12345678-1234-1234-1234-123456789012";

  it("returns validation status with result", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .get(`/v1/validation/status/${validUUID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.result.score).toBe(85);
  });

  it("rejects invalid UUID format", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/validation/status/not-a-uuid")
      .set(authHeader());

    expect(res.status).toBe(400);
  });

  it("returns 403 for other agent's request", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    svc.getValidationStatus.mockResolvedValue({
      request: { id: validUUID, agent_id: "agt_other", status: "completed" },
      result: null,
    });
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get(`/v1/validation/status/${validUUID}`)
      .set(authHeader());

    expect(res.status).toBe(403);
  });

  it("returns 404 for nonexistent request", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    svc.getValidationStatus.mockRejectedValue(new Error("not found"));
    const { app } = buildApp(pool, svc);
    setupAuth(pool);

    const res = await request(app)
      .get(`/v1/validation/status/${validUUID}`)
      .set(authHeader());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/validation/agent/:address — Public
// ---------------------------------------------------------------------------

describe("GET /v1/validation/agent/:address", () => {
  it("returns agent validation summary", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get(`/v1/validation/agent/${VALID_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(res.body.badge).toBe("gold");
    expect(res.body.totalValidations).toBe(5);
    expect(res.body.avgScore).toBe(88.5);
  });

  it("returns defaults for unknown agent", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    svc.getAgentSummaryByAddress.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);

    const res = await request(app).get(`/v1/validation/agent/${VALID_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(res.body.badge).toBe("none");
    expect(res.body.totalValidations).toBe(0);
  });

  it("rejects invalid address", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/validation/agent/notanaddress");

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/validation/agent/:address/history — Public
// ---------------------------------------------------------------------------

describe("GET /v1/validation/agent/:address/history", () => {
  it("returns validation history", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    const { app } = buildApp(pool, svc);
    // Agent lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });

    const res = await request(app).get(`/v1/validation/agent/${VALID_ADDRESS}/history`);

    expect(res.status).toBe(200);
    expect(res.body.validations).toHaveLength(1);
    expect(svc.listValidations).toHaveBeenCalledWith("agt_1", 20, 0);
  });

  it("returns empty for unknown agent", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(`/v1/validation/agent/${VALID_ADDRESS}/history`);

    expect(res.status).toBe(200);
    expect(res.body.validations).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/validation/on-chain/:erc8004Id
// ---------------------------------------------------------------------------

describe("GET /v1/validation/on-chain/:erc8004Id", () => {
  it("returns on-chain summary", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/validation/on-chain/42");

    expect(res.status).toBe(200);
    expect(res.body.onChainAvailable).toBe(true);
    expect(res.body.count).toBe(3);
  });

  it("returns not available when no summary", async () => {
    const pool = createMockPool();
    const svc = createMockValidationService();
    svc.getOnChainSummary.mockResolvedValue(null);
    const { app } = buildApp(pool, svc);

    const res = await request(app).get("/v1/validation/on-chain/42");

    expect(res.status).toBe(200);
    expect(res.body.onChainAvailable).toBe(false);
  });

  it("rejects invalid ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/validation/on-chain/abc");

    expect(res.status).toBe(400);
  });

  it("rejects negative ID", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/validation/on-chain/-5");

    expect(res.status).toBe(400);
  });
});
