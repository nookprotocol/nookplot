/**
 * Tests for signing.ts — EIP-712 ForwardRequest signing
 * and the prepare→sign→relay / prepare→sign→send flows.
 *
 * Uses real ethers for signature production; mocks ConnectionManager.request.
 * TEST_PRIVATE_KEY is a Hardhat default account (well-known public key).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  signForwardRequest,
  prepareSignRelay,
  prepareSignSend,
  extractIdFromReceipt,
  type PrepareResponse,
} from "../signing.js";
import type { ConnectionManager } from "../connection.js";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const DOMAIN = {
  name: "NookplotForwarder",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

const TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

const FORWARD_REQUEST = {
  from: TEST_ADDRESS,
  to: "0x0000000000000000000000000000000000000002",
  value: "0",
  gas: "100000",
  nonce: "0",
  deadline: 9999999999,
  data: "0xabcd",
};

function buildPrep(overrides: Partial<PrepareResponse> = {}): PrepareResponse {
  return {
    forwardRequest: { ...FORWARD_REQUEST },
    domain: { ...DOMAIN },
    types: { ...TYPES },
    ...overrides,
  };
}

function makeConn(privateKey: string | null = TEST_PRIVATE_KEY): {
  conn: ConnectionManager;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  const conn = {
    privateKey,
    request,
    config: { rpcUrl: "https://mainnet.base.org" },
  } as unknown as ConnectionManager;
  return { conn, request };
}

describe("signForwardRequest", () => {
  it("produces a 65-byte hex signature", async () => {
    const sig = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it("signature recovers the signer address", async () => {
    const sig = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    const recovered = ethers.verifyTypedData(DOMAIN, TYPES, FORWARD_REQUEST, sig);
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("is deterministic for identical inputs", async () => {
    const sig1 = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    const sig2 = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    expect(sig1).toBe(sig2);
  });

  it("differs across chain IDs (cross-chain replay protection)", async () => {
    const sig1 = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    const sig2 = await signForwardRequest(
      TEST_PRIVATE_KEY,
      { ...DOMAIN, chainId: 1 },
      TYPES,
      FORWARD_REQUEST,
    );
    expect(sig1).not.toBe(sig2);
  });

  it("differs across verifyingContracts (cross-contract replay protection)", async () => {
    const sig1 = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    const sig2 = await signForwardRequest(
      TEST_PRIVATE_KEY,
      { ...DOMAIN, verifyingContract: "0x000000000000000000000000000000000000dEaD" },
      TYPES,
      FORWARD_REQUEST,
    );
    expect(sig1).not.toBe(sig2);
  });

  it("differs across nonces (replay protection)", async () => {
    const sig1 = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    const sig2 = await signForwardRequest(
      TEST_PRIVATE_KEY,
      DOMAIN,
      TYPES,
      { ...FORWARD_REQUEST, nonce: "1" },
    );
    expect(sig1).not.toBe(sig2);
  });

  it("differs across data payloads", async () => {
    const sig1 = await signForwardRequest(TEST_PRIVATE_KEY, DOMAIN, TYPES, FORWARD_REQUEST);
    const sig2 = await signForwardRequest(
      TEST_PRIVATE_KEY,
      DOMAIN,
      TYPES,
      { ...FORWARD_REQUEST, data: "0xdeadbeef" },
    );
    expect(sig1).not.toBe(sig2);
  });

  it("rejects on invalid private key", async () => {
    await expect(
      signForwardRequest("not-a-key", DOMAIN, TYPES, FORWARD_REQUEST),
    ).rejects.toThrow();
  });
});

describe("prepareSignRelay", () => {
  let conn: ConnectionManager;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const m = makeConn();
    conn = m.conn;
    request = m.request;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("posts to prepare path then to /v1/relay", async () => {
    request
      .mockResolvedValueOnce(buildPrep())
      .mockResolvedValueOnce({ txHash: "0xRELAY", status: "ok" });

    const result = await prepareSignRelay(conn, "/v1/prepare/follow", { target: "0xT" });

    expect(request).toHaveBeenNthCalledWith(1, "POST", "/v1/prepare/follow", { target: "0xT" });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/v1/relay",
      expect.objectContaining({
        from: TEST_ADDRESS,
        to: FORWARD_REQUEST.to,
        value: "0",
        gas: "100000",
        nonce: "0",
        deadline: 9999999999,
        data: "0xabcd",
        signature: expect.stringMatching(/^0x[0-9a-fA-F]{130}$/),
      }),
    );
    expect(result).toEqual({ txHash: "0xRELAY" });
  });

  it("relay body signature recovers to the agent address", async () => {
    request
      .mockResolvedValueOnce(buildPrep())
      .mockResolvedValueOnce({ txHash: "0xRELAY", status: "ok" });

    await prepareSignRelay(conn, "/v1/prepare/follow", {});

    const relayBody = request.mock.calls[1][2] as Record<string, unknown>;
    const recovered = ethers.verifyTypedData(
      DOMAIN,
      TYPES,
      FORWARD_REQUEST,
      relayBody.signature as string,
    );
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it("throws synchronously if private key not configured", () => {
    const { conn: noKeyConn } = makeConn(null);
    expect(() => prepareSignRelay(noKeyConn, "/v1/prepare/follow", {})).toThrow(
      /Private key not configured/i,
    );
  });

  it("rejects if prepare response missing forwardRequest", async () => {
    request.mockResolvedValueOnce({ domain: DOMAIN, types: TYPES });
    await expect(prepareSignRelay(conn, "/v1/prepare/follow", {})).rejects.toThrow(
      /did not return a ForwardRequest/i,
    );
  });

  it("rejects if prepare response missing domain", async () => {
    request.mockResolvedValueOnce({ forwardRequest: FORWARD_REQUEST, types: TYPES });
    await expect(prepareSignRelay(conn, "/v1/prepare/follow", {})).rejects.toThrow(
      /did not return a ForwardRequest/i,
    );
  });

  it("rejects if prepare response missing types", async () => {
    request.mockResolvedValueOnce({ forwardRequest: FORWARD_REQUEST, domain: DOMAIN });
    await expect(prepareSignRelay(conn, "/v1/prepare/follow", {})).rejects.toThrow(
      /did not return a ForwardRequest/i,
    );
  });

  it("retries once on 'signature verification failed' error", async () => {
    request
      .mockResolvedValueOnce(buildPrep())
      .mockRejectedValueOnce(new Error("relay failed: signature verification failed"))
      .mockResolvedValueOnce(buildPrep())
      .mockResolvedValueOnce({ txHash: "0xRETRY", status: "ok" });

    const result = await prepareSignRelay(conn, "/v1/prepare/follow", {});
    expect(result).toEqual({ txHash: "0xRETRY" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retries once on nonce-related error", async () => {
    request
      .mockResolvedValueOnce(buildPrep())
      .mockRejectedValueOnce(new Error("invalid nonce: expected 5, got 3"))
      .mockResolvedValueOnce(buildPrep())
      .mockResolvedValueOnce({ txHash: "0xRETRY", status: "ok" });

    const result = await prepareSignRelay(conn, "/v1/prepare/follow", {});
    expect(result).toEqual({ txHash: "0xRETRY" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not retry on unrelated errors", async () => {
    request
      .mockResolvedValueOnce(buildPrep())
      .mockRejectedValueOnce(new Error("HTTP 500: internal server error"));

    await expect(prepareSignRelay(conn, "/v1/prepare/follow", {})).rejects.toThrow(/HTTP 500/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry beyond once when retry also fails", async () => {
    request
      .mockResolvedValueOnce(buildPrep())
      .mockRejectedValueOnce(new Error("nonce too low"))
      .mockResolvedValueOnce(buildPrep())
      .mockRejectedValueOnce(new Error("nonce too low"));

    await expect(prepareSignRelay(conn, "/v1/prepare/follow", {})).rejects.toThrow(/nonce too low/);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("serializes concurrent calls for the same private key", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    request.mockImplementation(async (_method: string, path: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (path === "/v1/relay") {
        return { txHash: "0x" + path.length.toString(16).padStart(64, "0"), status: "ok" };
      }
      return buildPrep();
    });

    await Promise.all([
      prepareSignRelay(conn, "/v1/prepare/a", {}),
      prepareSignRelay(conn, "/v1/prepare/b", {}),
      prepareSignRelay(conn, "/v1/prepare/c", {}),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("does not serialize across different private keys", async () => {
    const m1 = makeConn(TEST_PRIVATE_KEY);
    const m2 = makeConn("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

    let inFlight = 0;
    let maxInFlight = 0;
    const handler = async (_method: string, path: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (path === "/v1/relay") return { txHash: "0xOK", status: "ok" };
      return buildPrep();
    };
    m1.request.mockImplementation(handler);
    m2.request.mockImplementation(handler);

    await Promise.all([
      prepareSignRelay(m1.conn, "/v1/prepare/a", {}),
      prepareSignRelay(m2.conn, "/v1/prepare/b", {}),
    ]);

    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("prepareSignSend", () => {
  it("returns empty txHashes when prepare yields no txRequests", async () => {
    const { conn, request } = makeConn();
    request.mockResolvedValueOnce({ txRequests: [], meta: { reason: "nothing-to-claim" } });

    const result = await prepareSignSend(conn, "/v1/prepare/raw/claim", {});
    expect(result).toEqual({ txHashes: [], meta: { reason: "nothing-to-claim" } });
  });

  it("throws synchronously if private key not configured", () => {
    const { conn } = makeConn(null);
    expect(() => prepareSignSend(conn, "/v1/prepare/raw/claim", {})).toThrow(
      /Private key not configured/i,
    );
  });

  it("rejects if prepare returns no txRequests array", async () => {
    const { conn, request } = makeConn();
    request.mockResolvedValueOnce({ meta: {} });
    await expect(prepareSignSend(conn, "/v1/prepare/raw/claim", {})).rejects.toThrow(
      /did not return txRequests/i,
    );
  });

  it("rejects if prepare returns non-array txRequests", async () => {
    const { conn, request } = makeConn();
    request.mockResolvedValueOnce({ txRequests: "not-an-array" });
    await expect(prepareSignSend(conn, "/v1/prepare/raw/claim", {})).rejects.toThrow(
      /did not return txRequests/i,
    );
  });

  it("returns empty meta object when meta absent and txRequests empty", async () => {
    const { conn, request } = makeConn();
    request.mockResolvedValueOnce({ txRequests: [] });
    const result = await prepareSignSend(conn, "/v1/prepare/raw/claim", {});
    expect(result.meta).toEqual({});
  });

  it("posts to prepare path with body", async () => {
    const { conn, request } = makeConn();
    request.mockResolvedValueOnce({ txRequests: [] });
    await prepareSignSend(conn, "/v1/prepare/raw/claim", { epoch: 42 });
    expect(request).toHaveBeenCalledWith("POST", "/v1/prepare/raw/claim", { epoch: 42 });
  });
});

describe("extractIdFromReceipt", () => {
  const TOPIC = "0xc54f15383fc76338c2d91144251a76f63c6b1d53c7ad7e6fd6df0a2d93ac3a9a";
  const BOUNTY_ID_HEX = "0x000000000000000000000000000000000000000000000000000000000000007b"; // 123
  const CREATOR_HEX = "0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd";

  function mockProvider(
    receipt: { status: number; logs: { topics: string[]; data?: string }[] } | null,
  ) {
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: vi.fn().mockImplementation(() => ({
          waitForTransaction: vi.fn().mockResolvedValue(receipt),
        })),
      },
    }));
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it("extracts bountyId from topics[1] of BountyCreated event", async () => {
    mockProvider({
      status: 1,
      logs: [{ topics: [TOPIC, BOUNTY_ID_HEX, CREATOR_HEX] }],
    });
    const { extractIdFromReceipt: fn } = await import("../signing.js");
    const { conn } = makeConn();
    const id = await fn(conn, "0xabc...", TOPIC, 1);
    expect(id).toBe(123n);
  });

  it("extracts creator address (as bigint) from topics[2]", async () => {
    mockProvider({
      status: 1,
      logs: [{ topics: [TOPIC, BOUNTY_ID_HEX, CREATOR_HEX] }],
    });
    const { extractIdFromReceipt: fn } = await import("../signing.js");
    const { conn } = makeConn();
    const id = await fn(conn, "0xabc...", TOPIC, 2);
    expect(id).toBe(BigInt(CREATOR_HEX));
  });

  it("rejects when receipt is null (tx never mined)", async () => {
    mockProvider(null);
    const { extractIdFromReceipt: fn } = await import("../signing.js");
    const { conn } = makeConn();
    await expect(fn(conn, "0xabc...", TOPIC, 1)).rejects.toThrow(/not mined/i);
  });

  it("rejects when receipt status is 0 (tx reverted)", async () => {
    mockProvider({
      status: 0,
      logs: [],
    });
    const { extractIdFromReceipt: fn } = await import("../signing.js");
    const { conn } = makeConn();
    await expect(fn(conn, "0xabc...", TOPIC, 1)).rejects.toThrow(/reverted/i);
  });

  it("rejects when target event topic not found in any log", async () => {
    const OTHER_TOPIC = "0xdeadbeef".padEnd(66, "0");
    mockProvider({
      status: 1,
      logs: [{ topics: [OTHER_TOPIC, BOUNTY_ID_HEX] }],
    });
    const { extractIdFromReceipt: fn } = await import("../signing.js");
    const { conn } = makeConn();
    await expect(fn(conn, "0xabc...", TOPIC, 1)).rejects.toThrow(/not found in receipt/i);
  });

  it("rejects when indexedPosition is out of range", async () => {
    mockProvider({
      status: 1,
      logs: [{ topics: [TOPIC, BOUNTY_ID_HEX] }], // only one indexed arg
    });
    const { extractIdFromReceipt: fn } = await import("../signing.js");
    const { conn } = makeConn();
    await expect(fn(conn, "0xabc...", TOPIC, 2)).rejects.toThrow(/out of range/i);
  });
});
