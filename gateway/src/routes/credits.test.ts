import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createCreditsRouter } from "./credits.js";
import { CreditManager } from "../services/creditManager.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

// Suppress audit log + config imports
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../config.js", () => ({
  gatewayConfig: {
    relayTier0CreditCost: 50,
    relayTier1CreditCost: 25,
    relayTier2CreditCost: 10,
    relayTier0Cap: 10,
    relayTier1Cap: 100,
    relayTier2Cap: 200,
    creditInitialAmount: 10000,
    maxDailySpend: 50000,
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_credits_test", did_cid: "bafytest" });

function createMockCreditManager() {
  return {
    getBalance: vi.fn(),
    deductCredits: vi.fn(),
    addCredits: vi.fn(),
    createAccount: vi.fn(),
    getTransactions: vi.fn(),
    getUsageSummary: vi.fn(),
    setAutoConvertPct: vi.fn(),
    calculateCost: vi.fn(),
  } as unknown as CreditManager;
}

/**
 * Builds the app with the credits router.
 * `authQuerySetup` configures the mock pool to handle auth middleware queries.
 */
function buildApp(
  pool: ReturnType<typeof createMockPool>,
  cm: ReturnType<typeof createMockCreditManager>,
  opts?: { creditPurchaseAddress?: string },
) {
  const router = createCreditsRouter(
    pool as any,
    cm as any,
    TEST_HMAC_SECRET,
    opts?.creditPurchaseAddress,
  );
  return createTestApp(router);
}

/** Configure mock pool to authenticate the test agent. */
function setupAuth(pool: ReturnType<typeof createMockPool>) {
  // Auth middleware: agent lookup by key hash
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  // Auth middleware: credit balance pre-fetch
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

// ---------------------------------------------------------------------------
//  Public endpoints (no auth required)
// ---------------------------------------------------------------------------

describe("GET /v1/credits/packs", () => {
  it("returns packs with contract address", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm, { creditPurchaseAddress: "0xContract" });

    const res = await request(app).get("/v1/credits/packs");

    expect(res.status).toBe(200);
    expect(res.body.packs).toHaveLength(3);
    expect(res.body.packs[0].name).toBe("Micro");
    expect(res.body.packs[1].name).toBe("Standard");
    expect(res.body.packs[2].name).toBe("Bulk");
    expect(res.body.contractAddress).toBe("0xContract");
  });

  it("returns null contractAddress when not configured", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    const res = await request(app).get("/v1/credits/packs");

    expect(res.status).toBe(200);
    expect(res.body.contractAddress).toBeNull();
  });
});

describe("GET /v1/credits/purchase/info", () => {
  it("returns contract info when configured", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm, { creditPurchaseAddress: "0xPurchase" });

    const res = await request(app).get("/v1/credits/purchase/info");

    expect(res.status).toBe(200);
    expect(res.body.contractAddress).toBe("0xPurchase");
    expect(res.body.chainId).toBe(8453);
    expect(res.body.abi).toBeDefined();
  });

  it("returns 503 when not configured", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    const res = await request(app).get("/v1/credits/purchase/info");

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/credits/balance/:address (public, no auth)
// ---------------------------------------------------------------------------

describe("GET /v1/credits/balance/:address", () => {
  it("returns 400 for invalid address", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    const res = await request(app).get("/v1/credits/balance/invalid-addr");
    expect(res.status).toBe(400);
  });

  it("returns zero-balance for unregistered address", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // agent lookup

    const res = await request(app).get("/v1/credits/balance/0x" + "ab".repeat(20));
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.status).toBe("no_account");
  });

  it("returns balance for valid address", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    // Agent lookup
    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_1" }], rowCount: 1 });
    // getBalance
    (cm.getBalance as any).mockResolvedValueOnce({
      balance: 500,
      lifetimeEarned: 1000,
      lifetimeSpent: 500,
      autoConvertPct: 0,
      status: "active",
    });
    // Budget thresholds
    pool.query.mockResolvedValueOnce({
      rows: [{ budget_low_threshold: "200", budget_critical_threshold: "50" }],
      rowCount: 1,
    });

    const res = await request(app).get("/v1/credits/balance/0x" + "ab".repeat(20));
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(5);
    expect(res.body.balanceStored).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/credits/top-up (deprecated)
// ---------------------------------------------------------------------------

describe("POST /v1/credits/top-up", () => {
  it("returns 410 Gone", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/credits/top-up")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
  });
});

// ---------------------------------------------------------------------------
//  Authenticated endpoints
// ---------------------------------------------------------------------------

describe("GET /v1/credits/balance (authenticated)", () => {
  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    const res = await request(app).get("/v1/credits/balance");
    expect(res.status).toBe(401);
  });

  it("returns balance for authenticated agent", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);
    (cm.getBalance as any).mockResolvedValueOnce({
      balance: 800,
      lifetimeEarned: 1000,
      lifetimeSpent: 200,
      autoConvertPct: 10,
      status: "active",
    });
    // Budget thresholds query
    pool.query.mockResolvedValueOnce({
      rows: [{ budget_low_threshold: "200", budget_critical_threshold: "50" }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/credits/balance")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(8);
    expect(res.body.balanceStored).toBe(800);
    expect(res.body.status).toBe("active");
    expect(res.body.budgetStatus).toBe("normal");
  });

  it("returns no_account when credit account does not exist", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);
    (cm.getBalance as any).mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/v1/credits/balance")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_account");
    expect(res.body.balance).toBe(0);
  });
});

describe("GET /v1/credits/transactions", () => {
  it("returns paginated transactions", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);
    (cm.getTransactions as any).mockResolvedValueOnce([
      { id: "tx_1", agentId: "agt_1", amountCredits: -50, balanceAfter: 950, type: "relay_spend", referenceId: null, createdAt: "2025-01-01T00:00:00Z" },
    ]);

    const res = await request(app)
      .get("/v1/credits/transactions?limit=20&offset=0")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
  });
});

describe("POST /v1/credits/auto-convert", () => {
  it("rejects missing percentage", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/credits/auto-convert")
      .set("Authorization", `Bearer ${TEST_API_KEY}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("rejects percentage > 100", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/credits/auto-convert")
      .set("Authorization", `Bearer ${TEST_API_KEY}`)
      .send({ percentage: 101 });

    expect(res.status).toBe(400);
  });

  it("sets auto-convert percentage", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const app = buildApp(pool, cm);

    setupAuth(pool);

    const res = await request(app)
      .post("/v1/credits/auto-convert")
      .set("Authorization", `Bearer ${TEST_API_KEY}`)
      .send({ percentage: 50 });

    expect(res.status).toBe(200);
    expect(res.body.autoConvertPct).toBe(50);
    expect(cm.setAutoConvertPct).toHaveBeenCalledWith("agt_credits_test", 50);
  });
});
