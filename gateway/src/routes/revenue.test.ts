import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createRevenueRouter } from "./revenue.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const mockGetReadOnlySDK = vi.fn();
vi.mock("../sdkFactory.js", () => ({
  getReadOnlySDK: (...args: unknown[]) => mockGetReadOnlySDK(...args),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_rev", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const SDK_CONFIG = { rpcUrl: "https://mainnet.base.org", contracts: {} } as any;

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createRevenueRouter(pool as any, SDK_CONFIG, TEST_HMAC_SECRET);
  return createTestApp(router);
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  410 Gone — Revenue write operations
// ---------------------------------------------------------------------------

describe("Revenue — 410 Gone", () => {
  it("POST /v1/revenue/distribute returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/revenue/distribute")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/revenue/distribute");
  });

  it("POST /v1/revenue/config returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/revenue/config")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/revenue/config");
  });

  it("POST /v1/revenue/claim returns 410", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/revenue/claim")
      .set(authHeader());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Gone");
    expect(res.body.prepareEndpoint).toContain("prepare/revenue/claim");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/revenue/chain/:agent — Receipt chain
// ---------------------------------------------------------------------------

describe("GET /v1/revenue/chain/:agent", () => {
  it("returns receipt chain and config", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    mockGetReadOnlySDK.mockReturnValueOnce({
      contracts: {
        getReceiptChain: vi.fn().mockResolvedValue([{ from: "0xA", amount: "100" }]),
        getRevenueShareConfig: vi.fn().mockResolvedValue({ ownerShare: 70 }),
        getAgentTotalDistributed: vi.fn().mockResolvedValue({ toString: () => "5000" }),
      },
    });

    const res = await request(app)
      .get("/v1/revenue/chain/0xAgent")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("0xAgent");
    expect(res.body.totalDistributed).toBe("5000");
  });

  it("returns 500 on SDK failure", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    mockGetReadOnlySDK.mockReturnValueOnce({
      contracts: {
        getReceiptChain: vi.fn().mockRejectedValue(new Error("RPC error")),
        getRevenueShareConfig: vi.fn(),
        getAgentTotalDistributed: vi.fn(),
      },
    });

    const res = await request(app)
      .get("/v1/revenue/chain/0xAgent")
      .set(authHeader());

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/revenue/config/:agent — Share config
// ---------------------------------------------------------------------------

describe("GET /v1/revenue/config/:agent", () => {
  it("returns share config", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    mockGetReadOnlySDK.mockReturnValueOnce({
      contracts: {
        getRevenueShareConfig: vi.fn().mockResolvedValue({ ownerShare: 70, treasuryShare: 10 }),
      },
    });

    const res = await request(app)
      .get("/v1/revenue/config/0xAgent")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.ownerShare).toBe(70);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/revenue/balance — Caller's balance
// ---------------------------------------------------------------------------

describe("GET /v1/revenue/balance", () => {
  it("returns claimable balances", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    mockGetReadOnlySDK.mockReturnValueOnce({
      contracts: {
        getClaimableBalance: vi.fn().mockResolvedValue(BigInt(1000)),
        getClaimableEthBalance: vi.fn().mockResolvedValue(BigInt(500)),
        getAddressTotalClaimed: vi.fn().mockResolvedValue(BigInt(200)),
      },
    });

    const res = await request(app)
      .get("/v1/revenue/balance")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.claimableTokens).toBe("1000");
    expect(res.body.claimableEth).toBe("500");
    expect(res.body.totalClaimed).toBe("200");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/revenue/history/:agent — Distribution history
// ---------------------------------------------------------------------------

describe("GET /v1/revenue/history/:agent", () => {
  it("returns distribution events", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    mockGetReadOnlySDK.mockReturnValueOnce({
      contracts: {
        getRevenueHistory: vi.fn().mockResolvedValue([1]),
        getRevenueEvent: vi.fn().mockResolvedValue({
          amount: BigInt(1000),
          ownerAmount: BigInt(700),
          receiptChainAmount: BigInt(200),
          treasuryAmount: BigInt(100),
        }),
      },
    });

    const res = await request(app)
      .get("/v1/revenue/history/0xAgent")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("0xAgent");
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].amount).toBe("1000");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/revenue/earnings/:address — Earnings summary
// ---------------------------------------------------------------------------

describe("GET /v1/revenue/earnings/:address", () => {
  it("returns earnings for address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    mockGetReadOnlySDK.mockReturnValueOnce({
      contracts: {
        getClaimableBalance: vi.fn().mockResolvedValue(BigInt(3000)),
        getClaimableEthBalance: vi.fn().mockResolvedValue(BigInt(0)),
        getAddressTotalClaimed: vi.fn().mockResolvedValue(BigInt(1500)),
      },
    });

    const res = await request(app)
      .get("/v1/revenue/earnings/0xAddress")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.address).toBe("0xAddress");
    expect(res.body.claimableTokens).toBe("3000");
    expect(res.body.totalClaimed).toBe("1500");
  });
});
