import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createIpfsRouter } from "./ipfs.js";
import { hashApiKey } from "../auth.js";
import { createTestApp, createMockPool, createMockAgent, TEST_HMAC_SECRET } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock("../config.js", () => ({
  gatewayConfig: { pinataJwt: "test-pinata-jwt" },
}));

vi.mock("ethers", () => ({
  ethers: {
    isAddress: (addr: string) => /^0x[a-fA-F0-9]{40}$/.test(addr),
    verifyMessage: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "nk_" + "a".repeat(64);
const TEST_KEY_HASH = hashApiKey(TEST_API_KEY, TEST_HMAC_SECRET);
const TEST_AGENT = createMockAgent({ id: "agt_ipfs", api_key_hash: TEST_KEY_HASH, did_cid: "bafytest" });

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function buildApp(pool: ReturnType<typeof createMockPool>) {
  const router = createIpfsRouter(pool as any, TEST_HMAC_SECRET);
  return { app: createTestApp(router) };
}

function setupAuth(pool: ReturnType<typeof createMockPool>) {
  pool.query.mockResolvedValueOnce({ rows: [TEST_AGENT], rowCount: 1 });
  pool.query.mockResolvedValueOnce({ rows: [{ balance_credits: "1000" }], rowCount: 1 });
}

function authHeader() {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
//  GET /v1/ipfs/:cid — Fetch from IPFS
// ---------------------------------------------------------------------------

describe("GET /v1/ipfs/:cid", () => {
  // Use unique CIDs per test to avoid cache interference
  it("fetches and returns IPFS content", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    const cid = "Qm" + "a".repeat(44);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title: "Test Document" }),
    });

    const res = await request(app).get(`/v1/ipfs/${cid}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Test Document");
    expect(res.headers["x-cache"]).toBe("MISS");
  });

  it("returns cached content on second fetch", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    // Use same CID as above — it was cached
    const cid = "Qm" + "a".repeat(44);

    const res = await request(app).get(`/v1/ipfs/${cid}`);

    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("HIT");
  });

  it("rejects invalid CID format", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app).get("/v1/ipfs/invalid-cid");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid CID");
  });

  it("returns 404 when upstream returns 404", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    const cid = "Qm" + "b".repeat(44);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const res = await request(app).get(`/v1/ipfs/${cid}`);

    expect(res.status).toBe(404);
  });

  it("returns 502 on upstream error", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    const cid = "Qm" + "c".repeat(44);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await request(app).get(`/v1/ipfs/${cid}`);

    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/register/did — DID Registration
// ---------------------------------------------------------------------------

describe("POST /v1/register/did", () => {
  it("registers DID with valid signature", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    const addr = "0x" + "1".repeat(40);

    // Mock ethers.verifyMessage to return matching address
    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValue(addr);

    // Pinata upload
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ IpfsHash: "QmTestHash123", PinSize: 256 }),
    });

    const res = await request(app)
      .post("/v1/register/did")
      .send({ address: addr, signature: "0xvalidsig", displayName: "Agent1" });

    expect(res.status).toBe(201);
    expect(res.body.cid).toBe("QmTestHash123");
  });

  it("rejects invalid address", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/register/did")
      .send({ address: "not-an-address", signature: "0xsig" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("address");
  });

  it("rejects missing signature", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/register/did")
      .send({ address: "0x" + "1".repeat(40) });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("signature");
  });

  it("rejects mismatched signature", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    const addr = "0x" + "1".repeat(40);
    const wrongAddr = "0x" + "2".repeat(40);

    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValue(wrongAddr);

    const res = await request(app)
      .post("/v1/register/did")
      .send({ address: addr, signature: "0xbadsig" });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("does not match");
  });

  it("rejects displayName exceeding 100 chars", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    const addr = "0x" + "1".repeat(40);

    const { ethers } = await import("ethers");
    vi.mocked(ethers.verifyMessage).mockReturnValue(addr);

    const res = await request(app)
      .post("/v1/register/did")
      .send({ address: addr, signature: "0xsig", displayName: "x".repeat(101) });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("displayName");
  });
});

// ---------------------------------------------------------------------------
//  POST /v1/ipfs/upload — Upload to IPFS
// ---------------------------------------------------------------------------

describe("POST /v1/ipfs/upload", () => {
  it("uploads JSON to IPFS", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ IpfsHash: "QmUploadedCid", PinSize: 128 }),
    });

    const res = await request(app)
      .post("/v1/ipfs/upload")
      .set(authHeader())
      .send({ data: { title: "Test" }, name: "test-upload" });

    expect(res.status).toBe(200);
    expect(res.body.cid).toBe("QmUploadedCid");
    expect(res.body.size).toBe(128);
  });

  it("rejects missing data", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ipfs/upload")
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("data");
  });

  it("rejects array data", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    const res = await request(app)
      .post("/v1/ipfs/upload")
      .set(authHeader())
      .send({ data: [1, 2, 3] });

    expect(res.status).toBe(400);
  });

  it("returns 502 on Pinata failure", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);
    setupAuth(pool);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal error",
    });

    const res = await request(app)
      .post("/v1/ipfs/upload")
      .set(authHeader())
      .send({ data: { test: true } });

    expect(res.status).toBe(502);
  });

  it("returns 401 without auth", async () => {
    const pool = createMockPool();
    const { app } = buildApp(pool);

    const res = await request(app)
      .post("/v1/ipfs/upload")
      .send({ data: { test: true } });

    expect(res.status).toBe(401);
  });
});
