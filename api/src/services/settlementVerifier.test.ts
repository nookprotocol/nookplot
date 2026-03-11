import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSettlementVerifier } from "./settlementVerifier.js";
import { ethers } from "ethers";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

import { logSecurityEvent } from "../middleware/auditLog.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const PAYEE = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const VALID_TX_HASH = "0x" + "ab".repeat(32);
const USDC_BASE = "0x1111111111111111111111111111111111111111";

/** Build a mock Transfer log entry that matches USDC on Base mainnet. */
function makeTransferLog(from: string, to: string, amount: bigint) {
  const iface = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const topic0 = iface.getEvent("Transfer")!.topicHash;
  const encoded = iface.encodeEventLog(iface.getEvent("Transfer")!, [from, to, amount]);
  return {
    address: USDC_BASE,
    topics: encoded.topics,
    data: encoded.data,
  };
}

function createMockProvider(receipt: any = null) {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
  } as unknown as ethers.JsonRpcProvider;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("createSettlementVerifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a function", () => {
    const provider = createMockProvider();
    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });
    expect(typeof verify).toBe("function");
  });

  it("rejects invalid txHash format", async () => {
    const provider = createMockProvider();
    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify("not-a-hash", PAYER);
    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(0);

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "warn",
      "settlement-verify-invalid-txhash",
      expect.objectContaining({ txHash: "not-a-hash" }),
    );
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("skips verification when sampleRate causes skip", async () => {
    const provider = createMockProvider();
    // sampleRate = 0 means always skip
    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 0,
    });

    verify(VALID_TX_HASH, PAYER);
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("logs warning for unknown network", async () => {
    const provider = createMockProvider({ status: 1, logs: [] });
    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:99999", // unknown
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER);
    await vi.advanceTimersByTimeAsync(0);
    // Flush the async verification promise
    await vi.runAllTimersAsync();

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "warn",
      "settlement-verify-unknown-network",
      expect.objectContaining({ network: "eip155:99999" }),
    );
  });

  it("logs error when transaction failed (status !== 1)", async () => {
    const provider = createMockProvider({ status: 0, logs: [] });
    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER);
    await vi.runAllTimersAsync();

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "error",
      "settlement-mismatch",
      expect.objectContaining({ reason: "transaction-failed" }),
    );
  });

  it("logs error when no USDC transfer events found", async () => {
    const provider = createMockProvider({ status: 1, logs: [] });
    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER);
    await vi.runAllTimersAsync();

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "error",
      "settlement-mismatch",
      expect.objectContaining({ reason: "no-usdc-transfer" }),
    );
  });

  it("logs payer-payee-mismatch when transfer addresses don't match", async () => {
    const wrongPayer = "0x3333333333333333333333333333333333333333";
    const log = makeTransferLog(wrongPayer, PAYEE, 5000n);
    const provider = createMockProvider({ status: 1, logs: [log] });

    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER);
    await vi.runAllTimersAsync();

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "error",
      "settlement-mismatch",
      expect.objectContaining({ reason: "payer-payee-mismatch" }),
    );
  });

  it("logs settlement-verified on successful verification", async () => {
    const log = makeTransferLog(PAYER, PAYEE, 5000n);
    const provider = createMockProvider({ status: 1, logs: [log] });

    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER);
    await vi.runAllTimersAsync();

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "debug",
      "settlement-verified",
      expect.objectContaining({ txHash: VALID_TX_HASH }),
    );
  });

  it("detects amount mismatch", async () => {
    const log = makeTransferLog(PAYER, PAYEE, 5000n);
    const provider = createMockProvider({ status: 1, logs: [log] });

    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER, "9999"); // expected 9999, actual 5000
    await vi.runAllTimersAsync();

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "error",
      "settlement-mismatch",
      expect.objectContaining({ reason: "amount-mismatch" }),
    );
  });

  it("retries up to 3 times when receipt is null", async () => {
    const provider = {
      getTransactionReceipt: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    } as unknown as ethers.JsonRpcProvider;

    const verify = createSettlementVerifier({
      provider,
      payeeAddress: PAYEE,
      network: "eip155:8453",
      sampleRate: 1.0,
    });

    verify(VALID_TX_HASH, PAYER);

    // Advance past all 3 retry delays (5s each)
    await vi.advanceTimersByTimeAsync(15_000);

    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(3);
    expect(logSecurityEvent).toHaveBeenCalledWith(
      "warn",
      "settlement-verify-no-receipt",
      expect.objectContaining({ txHash: VALID_TX_HASH }),
    );
  });
});
