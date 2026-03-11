import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  Mocks — must come before importing the router
// ---------------------------------------------------------------------------

// Suppress audit log
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock config
vi.mock("../config.js", () => ({
  gatewayConfig: {
    erc8004IdentityRegistry: null,
    creditInitialAmount: 100000,
  },
}));

// Mock SDK factory — prevents actual blockchain calls
vi.mock("../sdkFactory.js", () => ({
  getReadOnlySDK: vi.fn().mockReturnValue({
    ipfs: { uploadJson: vi.fn().mockResolvedValue({ cid: "bafytest_cid" }) },
    contracts: { getAgent: vi.fn().mockResolvedValue(null) },
  }),
  getSdkConfig: vi.fn().mockReturnValue({
    contracts: {},
    forwarderAddress: "0x0000000000000000000000000000000000000000",
  }),
}));

// Mock auth module — need actual hashApiKey but mock generateApiKey
vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    generateApiKey: vi.fn().mockReturnValue({
      key: "nk_" + "b".repeat(64),
      prefix: "nk_…bbbb",
    }),
  };
});

// Mock ethers — used for address validation + signature verification
vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr),
    getAddress: (addr: string) => addr, // passthrough (real version checksums)
    verifyMessage: vi.fn().mockReturnValue("0x1234567890123456789012345678901234567890"),
  },
}));

// Now import the router
import { createAgentsRouter } from "./agents.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_ADDRESS = "0x1234567890123456789012345678901234567890";

function makeMockCreditManager() {
  return {
    createAccount: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue(null),
  };
}

function buildApp(
  pool: ReturnType<typeof createMockPool>,
  cm?: ReturnType<typeof makeMockCreditManager>,
) {
  const sdkConfig = {
    contracts: {},
    forwarderAddress: "0x0000000000000000000000000000000000000000",
    rpcUrl: "http://localhost:8545",
    chainId: 8453,
  };
  const router = createAgentsRouter(
    pool as any,
    sdkConfig as any,
    TEST_HMAC_SECRET,
    cm as any,
  );
  return createTestApp(router);
}

function setupAuth(pool: ReturnType<typeof createMockPool>, agent?: ReturnType<typeof createMockAgent>) {
  const a = agent ?? createMockAgent();
  // Auth middleware: agent lookup
  pool.query.mockResolvedValueOnce({ rows: [a], rowCount: 1 });
  // Auth middleware: credit balance pre-fetch
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
  return a;
}

// ---------------------------------------------------------------------------
//  POST /v1/agents — Registration
// ---------------------------------------------------------------------------

describe("POST /v1/agents — registration", () => {
  it("rejects missing address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app)
      .post("/v1/agents")
      .send({ signature: "0xsig" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("address");
  });

  it("rejects invalid address format", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app)
      .post("/v1/agents")
      .send({ address: "not-an-address", signature: "0xsig" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("address");
  });

  it("rejects missing signature", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app)
      .post("/v1/agents")
      .send({ address: TEST_ADDRESS });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("signature");
  });

  it("rejects signature that doesn't match address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    // verifyMessage returns a different address than what was submitted
    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValueOnce("0x9999999999999999999999999999999999999999");

    const res = await request(app)
      .post("/v1/agents")
      .send({ address: TEST_ADDRESS, signature: "0xbadsig" });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("Signature does not match");
  });

  it("registers successfully with valid address + signature", async () => {
    const pool = createMockPool();
    const cm = makeMockCreditManager();
    const app = buildApp(pool, cm);

    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValueOnce(TEST_ADDRESS);

    // INSERT INTO agents
    pool.query.mockResolvedValueOnce({
      rows: [createMockAgent({ id: "agt_new", address: TEST_ADDRESS })],
      rowCount: 1,
    });
    // Proactive settings INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Web user link check
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/agents")
      .send({ address: TEST_ADDRESS, signature: "0xvalidsig" });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.address).toBe(TEST_ADDRESS);
    expect(res.body.did).toBe(`did:nookplot:${TEST_ADDRESS}`);
    expect(cm.createAccount).toHaveBeenCalled();
  });

  it("returns 409 when address already registered", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValueOnce(TEST_ADDRESS);

    // INSERT returns empty (ON CONFLICT DO NOTHING)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/agents")
      .send({ address: TEST_ADDRESS, signature: "0xvalidsig" });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("already registered");
  });

  it("rejects name over 100 chars", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValueOnce(TEST_ADDRESS);

    const res = await request(app)
      .post("/v1/agents")
      .send({
        address: TEST_ADDRESS,
        signature: "0xvalidsig",
        name: "x".repeat(101),
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("name");
  });

  it("rejects capabilities with > 50 items", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValueOnce(TEST_ADDRESS);

    const res = await request(app)
      .post("/v1/agents")
      .send({
        address: TEST_ADDRESS,
        signature: "0xvalidsig",
        capabilities: Array.from({ length: 51 }, (_, i) => `cap_${i}`),
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("capabilities");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/agents/names — Batch name resolution
// ---------------------------------------------------------------------------

describe("POST /v1/agents/names", () => {
  it("rejects non-array addresses", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app)
      .post("/v1/agents/names")
      .send({ addresses: "not-an-array" });

    expect(res.status).toBe(400);
  });

  it("rejects > 100 addresses", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const addresses = Array.from({ length: 101 }, (_, i) =>
      `0x${i.toString(16).padStart(40, "0")}`,
    );

    const res = await request(app)
      .post("/v1/agents/names")
      .send({ addresses });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("100");
  });

  it("resolves valid addresses to names", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const addr = "0x" + "ab".repeat(20);
    pool.query.mockResolvedValueOnce({
      rows: [{ address: addr, display_name: "Agent A", description: "Test" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/v1/agents/names")
      .send({ addresses: [addr] });

    expect(res.status).toBe(200);
    expect(res.body[addr.toLowerCase()]).toBeDefined();
    expect(res.body[addr.toLowerCase()].displayName).toBe("Agent A");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/me — Authenticated profile
// ---------------------------------------------------------------------------

describe("GET /v1/agents/me", () => {
  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/agents/me");
    expect(res.status).toBe(401);
  });

  it("returns profile for authenticated agent", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    const agent = setupAuth(pool);

    const res = await request(app)
      .get("/v1/agents/me")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(agent.address);
    expect(res.body.did).toContain("did:nookplot:");
    expect(res.body.registeredOnChain).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/:address/profile — Public profile
// ---------------------------------------------------------------------------

describe("GET /v1/agents/:address/profile", () => {
  it("returns 400 for invalid address", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/agents/invalid-addr/profile");
    expect(res.status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(`/v1/agents/${TEST_ADDRESS}/profile`);
    expect(res.status).toBe(404);
  });

  it("returns profile when agent exists", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        address: TEST_ADDRESS,
        display_name: "Test",
        description: "Agent",
        did_cid: "bafytest",
        capabilities: ["chat"],
        model_provider: "openai",
        model_name: "gpt-4",
        model_version: "latest",
        status: "active",
        created_at: new Date("2025-01-01"),
        updated_at: new Date("2025-01-01"),
      }],
      rowCount: 1,
    });

    const res = await request(app).get(`/v1/agents/${TEST_ADDRESS}/profile`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(TEST_ADDRESS);
    expect(res.body.registeredOnChain).toBe(true);
    expect(res.body.source).toBe("gateway-db");
  });
});

// ---------------------------------------------------------------------------
//  GET /v1/agents/search — Agent search
// ---------------------------------------------------------------------------

describe("GET /v1/agents/search", () => {
  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);

    const res = await request(app).get("/v1/agents/search?q=test");
    expect(res.status).toBe(401);
  });

  it("rejects query shorter than 2 chars", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .get("/v1/agents/search?q=a")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("2 characters");
  });

  it("returns search results", async () => {
    const pool = createMockPool();
    const app = buildApp(pool);
    setupAuth(pool);

    // Search query
    pool.query.mockResolvedValueOnce({
      rows: [{ address: TEST_ADDRESS, display_name: "Test Agent", description: null, did_cid: "bafytest", created_at: new Date() }],
      rowCount: 1,
    });

    const res = await request(app)
      .get("/v1/agents/search?q=test")
      .set("Authorization", `Bearer ${TEST_API_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
  });
});
