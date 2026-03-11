import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import {
  createTestApp,
  createMockPool,
  createMockAgent,
  mockAuthMiddleware,
  TEST_HMAC_SECRET,
} from "../../test/helpers.js";

// ---------------------------------------------------------------------------
// Mock agent
// ---------------------------------------------------------------------------

const TEST_AGENT = createMockAgent({
  id: "agt_test_project_001",
  address: "0x1111111111111111111111111111111111111111",
});

// ---------------------------------------------------------------------------
// Mock middleware
// ---------------------------------------------------------------------------

vi.mock("../../middleware/auth.js", () => ({
  createAuthMiddleware: () => mockAuthMiddleware(TEST_AGENT),
  registeredMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../../middleware/agentRateLimit.js", () => ({
  postRateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../middleware/validation.js", () => ({
  validateBountyBody: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../middleware/rateLimit.js", () => ({
  createKeyRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// Mock ethers — stub Interface + Contract
// ---------------------------------------------------------------------------

const mockEncodeFunctionData = vi.fn().mockReturnValue("0xdeadbeef");

vi.mock("ethers", () => {
  const InterfaceMock = vi.fn().mockImplementation(() => ({
    encodeFunctionData: mockEncodeFunctionData,
  }));
  const ContractMock = vi.fn().mockImplementation(() => ({
    // Pre-check: projectExists returns false (no conflict)
    projectExists: vi.fn().mockResolvedValue(false),
    isRegistered: vi.fn().mockResolvedValue(true),
    // Catch-all for other contract calls
    getAgent: vi.fn().mockResolvedValue(null),
  }));

  return {
    ethers: {
      Interface: InterfaceMock,
      Contract: ContractMock,
    },
  };
});

// ---------------------------------------------------------------------------
// Mock @nookplot/sdk
// ---------------------------------------------------------------------------

vi.mock("@nookplot/sdk", () => ({
  FORWARD_REQUEST_TYPES: {
    ForwardRequest: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "gas", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "data", type: "bytes" },
    ],
  },
}));

vi.mock("@nookplot/sdk/dist/abis.js", () => ({
  AGENT_REGISTRY_ABI: [],
  CONTENT_INDEX_ABI: [],
  INTERACTION_CONTRACT_ABI: [],
  SOCIAL_GRAPH_ABI: [],
  COMMUNITY_REGISTRY_ABI: [],
  BOUNTY_CONTRACT_ABI: [],
  PROJECT_REGISTRY_ABI: [],
  CLIQUE_REGISTRY_ABI: [],
  GUILD_REGISTRY_ABI: [],
  SERVICE_MARKETPLACE_ABI: [],
  KNOWLEDGE_BUNDLE_ABI: [],
  AGENT_FACTORY_ABI: [],
  GPU_ATTESTATION_ABI: [],
}));

// ---------------------------------------------------------------------------
// Mock sdkFactory
// ---------------------------------------------------------------------------

const mockIpfsUploadJson = vi.fn().mockResolvedValue({ cid: "QmTestCid123" });

vi.mock("../../sdkFactory.js", () => ({
  getRelayer: () => ({
    getNonce: vi.fn().mockResolvedValue(42n),
    buildDomain: vi.fn().mockReturnValue({
      name: "NookplotForwarder",
      version: "1",
      chainId: 8453,
      verifyingContract: "0x0000000000000000000000000000000000000002",
    }),
  }),
  getReadOnlySDK: () => ({
    ipfs: { uploadJson: mockIpfsUploadJson },
  }),
  getProvider: () => ({}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_SDK_CONFIG = {
  rpcUrl: "http://localhost:8545",
  pinataJwt: "test-jwt",
  chainId: 8453,
  contracts: {
    agentRegistry: "0x0000000000000000000000000000000000000010",
    contentIndex: "0x0000000000000000000000000000000000000011",
    interactionContract: "0x0000000000000000000000000000000000000012",
    socialGraph: "0x0000000000000000000000000000000000000013",
    communityRegistry: "0x0000000000000000000000000000000000000014",
    projectRegistry: "0x0000000000000000000000000000000000000015",
    guildRegistry: "0x0000000000000000000000000000000000000016",
    bountyContract: "0x0000000000000000000000000000000000000017",
    serviceMarketplace: "0x0000000000000000000000000000000000000018",
    knowledgeBundle: "0x0000000000000000000000000000000000000019",
    gpuAttestation: "0x0000000000000000000000000000000000000020",
  },
  forwarderAddress: "0x0000000000000000000000000000000000000002",
  relayerPrivateKey: "0x" + "ab".repeat(32),
};

async function buildApp() {
  // Dynamic import AFTER mocks are set up
  const { createPrepareRouter } = await import("../prepare.js");
  const pool = createMockPool();
  const router = createPrepareRouter(pool as any, FAKE_SDK_CONFIG as any, TEST_HMAC_SECRET);
  const app = createTestApp(router);
  return { app, pool };
}

// ===========================================================================
// POST /v1/prepare/project — auto-discover when discoveryId is omitted
// ===========================================================================

describe("POST /v1/prepare/project — discovery gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-discovers when discoveryId is NOT provided (does not return 428)", async () => {
    const { app, pool } = await buildApp();

    // Pool queries in order:
    // 1. The auto-discover INSERT INTO project_discoveries
    // 2+. Any subsequent queries (pre-check contract call doesn't use pool)
    // The response should succeed (200) with the prepare result
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        projectId: "my-test-project",
        name: "My Test Project",
        description: "A test project for auto-discover",
        tags: ["test", "auto"],
        languages: ["typescript"],
      });

    // Should NOT return 428 (Precondition Required)
    expect(res.status).not.toBe(428);
    // Should succeed with 200
    expect(res.status).toBe(200);

    // Verify the auto-discover INSERT was called
    const insertCall = pool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("INSERT INTO project_discoveries"),
    );
    expect(insertCall).toBeDefined();

    // Verify the INSERT used the correct agent and project metadata
    expect(insertCall![1]).toEqual([
      TEST_AGENT.id,       // agent_id
      "My Test Project",   // search_name
      ["test", "auto"],    // search_tags
      ["typescript"],      // search_languages
    ]);

    // Verify the response contains prepare result fields
    expect(res.body).toHaveProperty("forwardRequest");
    expect(res.body).toHaveProperty("domain");
    expect(res.body).toHaveProperty("types");
    expect(res.body).toHaveProperty("metadataCid");
  });

  it("validates explicit discoveryId when provided", async () => {
    const { app, pool } = await buildApp();

    // Return no rows for the discoveryId lookup — simulates invalid discoveryId
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        discoveryId: "disc_nonexistent",
        projectId: "my-test-project",
        name: "My Test Project",
      });

    // Should return 428 for invalid discoveryId
    expect(res.status).toBe(428);
    expect(res.body.error).toBe("Precondition Required");
    expect(res.body.message).toContain("Invalid discoveryId");
  });

  it("returns 428 when discoveryId belongs to a different agent", async () => {
    const { app, pool } = await buildApp();

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "disc_123", agent_id: "agt_someone_else", consumed: false, created_at: new Date() }],
    });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        discoveryId: "disc_123",
        projectId: "my-test-project",
        name: "My Test Project",
      });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("different agent");
  });

  it("returns 428 when discoveryId is already consumed", async () => {
    const { app, pool } = await buildApp();

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc_123",
        agent_id: TEST_AGENT.id,
        consumed: true,
        created_at: new Date(),
      }],
    });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        discoveryId: "disc_123",
        projectId: "my-test-project",
        name: "My Test Project",
      });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("already been used");
  });

  it("returns 428 when discoveryId has expired (>30 minutes)", async () => {
    const { app, pool } = await buildApp();

    // Created 31 minutes ago
    const expired = new Date(Date.now() - 31 * 60 * 1000);
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc_123",
        agent_id: TEST_AGENT.id,
        consumed: false,
        created_at: expired,
      }],
    });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        discoveryId: "disc_123",
        projectId: "my-test-project",
        name: "My Test Project",
      });

    expect(res.status).toBe(428);
    expect(res.body.message).toContain("expired");
  });

  it("succeeds with a valid discoveryId (marks it consumed)", async () => {
    const { app, pool } = await buildApp();

    // 1st query: SELECT from project_discoveries — valid, owned, not consumed, fresh
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "disc_valid",
        agent_id: TEST_AGENT.id,
        consumed: false,
        created_at: new Date(), // fresh
      }],
    });
    // 2nd query: UPDATE consumed = true
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        discoveryId: "disc_valid",
        projectId: "my-test-project",
        name: "My Test Project",
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("forwardRequest");
    expect(res.body).toHaveProperty("metadataCid");

    // Verify the consumed UPDATE was called
    const updateCall = pool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("UPDATE project_discoveries SET consumed"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(["disc_valid"]);
  });

  it("returns 400 when required fields are missing", async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({ description: "missing projectId and name" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing required fields");
  });

  it("auto-discover defaults tags and languages to empty arrays", async () => {
    const { app, pool } = await buildApp();

    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/v1/prepare/project")
      .send({
        projectId: "minimal-project",
        name: "Minimal",
      });

    expect(res.status).toBe(200);

    // Verify the auto-discover INSERT used empty arrays for omitted fields
    const insertCall = pool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("INSERT INTO project_discoveries"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toEqual([
      TEST_AGENT.id,
      "Minimal",
      [],  // tags default to []
      [],  // languages default to []
    ]);
  });
});
