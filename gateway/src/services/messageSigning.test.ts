import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSigningPayload,
  verifyMessageSignature,
  getCurrentNonce,
  NOOKPLOT_MESSAGE_DOMAIN,
  NOOKPLOT_MESSAGE_TYPES,
} from "./messageSigning.js";
import { createMockPool } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock ethers
const mockVerifyTypedData = vi.fn();
vi.mock("ethers", () => ({
  ethers: {
    verifyTypedData: (...args: unknown[]) => mockVerifyTypedData(...args),
  },
}));

const TEST_ADDRESS = "0x1234567890123456789012345678901234567890";
const CHAIN_ID = 8453;

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

describe("messageSigning — constants", () => {
  it("exports NOOKPLOT_MESSAGE_DOMAIN", () => {
    expect(NOOKPLOT_MESSAGE_DOMAIN.name).toBe("NookplotMessaging");
    expect(NOOKPLOT_MESSAGE_DOMAIN.version).toBe("1");
  });

  it("exports NOOKPLOT_MESSAGE_TYPES with correct fields", () => {
    const fields = NOOKPLOT_MESSAGE_TYPES.NookplotMessage;
    expect(fields).toHaveLength(5);
    expect(fields.map((f) => f.name)).toEqual(["from", "to", "content", "nonce", "timestamp"]);
  });
});

// ---------------------------------------------------------------------------
//  buildSigningPayload
// ---------------------------------------------------------------------------

describe("buildSigningPayload", () => {
  it("returns payload with all fields", () => {
    const payload = buildSigningPayload(TEST_ADDRESS, "ch:test", "hello", BigInt(1), BigInt(1000));
    expect(payload.from).toBe(TEST_ADDRESS);
    expect(payload.to).toBe("ch:test");
    expect(payload.content).toBe("hello");
    expect(payload.nonce).toBe(BigInt(1));
    expect(payload.timestamp).toBe(BigInt(1000));
  });
});

// ---------------------------------------------------------------------------
//  verifyMessageSignature
// ---------------------------------------------------------------------------

describe("verifyMessageSignature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verifies valid signature and updates nonce", async () => {
    const pool = createMockPool();
    mockVerifyTypedData.mockReturnValue(TEST_ADDRESS);

    // Nonce INSERT returns row (success — nonce is new)
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_address: TEST_ADDRESS.toLowerCase() }],
      rowCount: 1,
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = buildSigningPayload(
      TEST_ADDRESS,
      "ch:test",
      "hello",
      BigInt(1),
      BigInt(nowSec),
    );

    const result = await verifyMessageSignature(pool as any, CHAIN_ID, payload, "0xsig");

    expect(result.valid).toBe(true);
    expect(result.recoveredAddress).toBe(TEST_ADDRESS);
    expect(mockVerifyTypedData).toHaveBeenCalled();
  });

  it("rejects expired timestamp", async () => {
    const pool = createMockPool();

    // 10 minutes ago — exceeds 5-min drift
    const oldSec = Math.floor(Date.now() / 1000) - 600;
    const payload = buildSigningPayload(
      TEST_ADDRESS,
      "ch:test",
      "hello",
      BigInt(1),
      BigInt(oldSec),
    );

    const result = await verifyMessageSignature(pool as any, CHAIN_ID, payload, "0xsig");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("timestamp");
  });

  it("rejects future timestamp beyond drift", async () => {
    const pool = createMockPool();

    // 10 minutes in the future
    const futureSec = Math.floor(Date.now() / 1000) + 600;
    const payload = buildSigningPayload(
      TEST_ADDRESS,
      "ch:test",
      "hello",
      BigInt(1),
      BigInt(futureSec),
    );

    const result = await verifyMessageSignature(pool as any, CHAIN_ID, payload, "0xsig");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("timestamp");
  });

  it("rejects invalid signature (ethers throws)", async () => {
    const pool = createMockPool();
    mockVerifyTypedData.mockImplementation(() => {
      throw new Error("invalid signature");
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = buildSigningPayload(
      TEST_ADDRESS,
      "ch:test",
      "hello",
      BigInt(1),
      BigInt(nowSec),
    );

    const result = await verifyMessageSignature(pool as any, CHAIN_ID, payload, "0xbadsig");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid signature");
  });

  it("rejects signature that recovers to wrong address", async () => {
    const pool = createMockPool();
    mockVerifyTypedData.mockReturnValue("0x9999999999999999999999999999999999999999");

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = buildSigningPayload(
      TEST_ADDRESS,
      "ch:test",
      "hello",
      BigInt(1),
      BigInt(nowSec),
    );

    const result = await verifyMessageSignature(pool as any, CHAIN_ID, payload, "0xwrongsig");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not match");
  });

  it("rejects replayed nonce", async () => {
    const pool = createMockPool();
    mockVerifyTypedData.mockReturnValue(TEST_ADDRESS);

    // Nonce INSERT returns empty (nonce not greater than existing)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const nowSec = Math.floor(Date.now() / 1000);
    const payload = buildSigningPayload(
      TEST_ADDRESS,
      "ch:test",
      "hello",
      BigInt(1),
      BigInt(nowSec),
    );

    const result = await verifyMessageSignature(pool as any, CHAIN_ID, payload, "0xsig");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Nonce too low");
  });
});

// ---------------------------------------------------------------------------
//  getCurrentNonce
// ---------------------------------------------------------------------------

describe("getCurrentNonce", () => {
  it("returns nonce when entry exists", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ nonce: "42" }],
      rowCount: 1,
    });

    const nonce = await getCurrentNonce(pool as any, TEST_ADDRESS);
    expect(nonce).toBe(BigInt(42));
  });

  it("returns -1 when no entry exists", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const nonce = await getCurrentNonce(pool as any, TEST_ADDRESS);
    expect(nonce).toBe(BigInt(-1));
  });

  it("lowercases the address for lookup", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await getCurrentNonce(pool as any, "0xABCD1234567890ABCDEF1234567890ABCDEF1234");

    expect(pool.query).toHaveBeenCalledWith(
      expect.anything(),
      ["0xabcd1234567890abcdef1234567890abcdef1234"],
    );
  });
});
