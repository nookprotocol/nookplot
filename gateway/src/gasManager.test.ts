import { describe, it, expect, vi, beforeEach } from "vitest";
import { GasManager } from "./gasManager.js";
import { createMockPool } from "./test/helpers.js";

vi.mock("./middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock ethers
const mockSendTransaction = vi.fn();
const mockGetBalance = vi.fn();

vi.mock("ethers", () => ({
  ethers: {
    Wallet: vi.fn().mockImplementation(() => ({
      address: "0xHotWallet",
      sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
    })),
    JsonRpcProvider: vi.fn(),
    parseEther: (val: string) => BigInt(Math.round(parseFloat(val) * 1e18)),
    formatEther: (val: bigint) => (Number(val) / 1e18).toString(),
  },
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  dailyLimitEth: 0.01,
  minReserveEth: 0.1,
  fundingAmountEth: 0.001,
};

function createGasManager(configOverrides: Record<string, unknown> = {}) {
  const pool = createMockPool();
  const provider = { getBalance: mockGetBalance } as any;
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const gm = new GasManager("0xprivatekey", provider, pool as any, config);
  return { gm, pool };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  Basic properties
// ---------------------------------------------------------------------------

describe("GasManager — basics", () => {
  it("returns hot wallet address", () => {
    const { gm } = createGasManager();
    expect(gm.address).toBe("0xHotWallet");
  });

  it("getBalance delegates to provider", async () => {
    const { gm } = createGasManager();
    mockGetBalance.mockResolvedValueOnce(BigInt(1e18));

    const balance = await gm.getBalance();
    expect(balance).toBe(BigInt(1e18));
  });
});

// ---------------------------------------------------------------------------
//  ensureGas
// ---------------------------------------------------------------------------

describe("GasManager — ensureGas", () => {
  it("returns true immediately in metatx mode", async () => {
    const { gm } = createGasManager({ metatxEnabled: true });

    const result = await gm.ensureGas("0xAgent", "agt_1");
    expect(result).toBe(true);
    expect(mockGetBalance).not.toHaveBeenCalled();
  });

  it("returns true when agent already has enough gas", async () => {
    const { gm } = createGasManager();
    // Agent balance >= 0.0001 ETH
    mockGetBalance.mockResolvedValueOnce(BigInt(1e15)); // 0.001 ETH

    const result = await gm.ensureGas("0xAgent", "agt_1");
    expect(result).toBe(true);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("returns false when daily limit reached", async () => {
    const { gm, pool } = createGasManager();
    // Agent balance too low
    mockGetBalance.mockResolvedValueOnce(BigInt(0));
    // Daily spending query returns over limit
    pool.query.mockResolvedValueOnce({
      rows: [{ total: String(BigInt(1e16)) }], // 0.01 ETH = at daily limit
      rowCount: 1,
    });

    const result = await gm.ensureGas("0xAgent", "agt_1");
    expect(result).toBe(false);
  });

  it("returns false when hot wallet is below reserve", async () => {
    const { gm, pool } = createGasManager();
    // Agent balance too low
    mockGetBalance.mockResolvedValueOnce(BigInt(0));
    // Daily spending under limit
    pool.query.mockResolvedValueOnce({
      rows: [{ total: "0" }],
      rowCount: 1,
    });
    // Hot wallet balance below reserve (0.1 ETH)
    mockGetBalance.mockResolvedValueOnce(BigInt(1e16)); // 0.01 ETH < 0.1 reserve

    const result = await gm.ensureGas("0xAgent", "agt_1");
    expect(result).toBe(false);
  });

  it("funds agent and records gas transfer on success", async () => {
    const { gm, pool } = createGasManager();
    // Agent balance too low
    mockGetBalance.mockResolvedValueOnce(BigInt(0));
    // Daily spending under limit
    pool.query.mockResolvedValueOnce({
      rows: [{ total: "0" }],
      rowCount: 1,
    });
    // Hot wallet has sufficient balance
    mockGetBalance.mockResolvedValueOnce(BigInt(1e18)); // 1 ETH
    // Send transaction succeeds
    mockSendTransaction.mockResolvedValueOnce({
      wait: () => Promise.resolve({
        hash: "0xtxhash",
        gasUsed: BigInt(21000),
        gasPrice: BigInt(1e9),
      }),
    });
    // Record gas transfer INSERT
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await gm.ensureGas("0xAgent", "agt_1");
    expect(result).toBe(true);
    expect(mockSendTransaction).toHaveBeenCalled();

    // Verify gas ledger insert
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toContain("gas_ledger");
    expect(insertCall[1][1]).toBe("0xtxhash");
  });

  it("returns false when funding transaction fails", async () => {
    const { gm, pool } = createGasManager();
    mockGetBalance.mockResolvedValueOnce(BigInt(0));
    pool.query.mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });
    mockGetBalance.mockResolvedValueOnce(BigInt(1e18));
    mockSendTransaction.mockRejectedValueOnce(new Error("nonce too low"));

    const result = await gm.ensureGas("0xAgent", "agt_1");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  recordGasTransfer
// ---------------------------------------------------------------------------

describe("GasManager — recordGasTransfer", () => {
  it("inserts into gas_ledger", async () => {
    const { gm, pool } = createGasManager();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await gm.recordGasTransfer("agt_1", "0xtx", 21000, "1000000000", "21000000000000", "fund");

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("gas_ledger");
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("agt_1");
    expect(params[1]).toBe("0xtx");
    expect(params[5]).toBe("fund");
  });
});
