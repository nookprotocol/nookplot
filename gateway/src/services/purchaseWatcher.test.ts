import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock ethers — constructor creates provider + contract internally
const mockProvider = {
  getBlockNumber: vi.fn().mockResolvedValue(1000),
};

const mockFilter = { topics: [] };
const mockContract = {
  filters: { CreditsPurchased: vi.fn().mockReturnValue(mockFilter) },
  queryFilter: vi.fn().mockResolvedValue([]),
};

vi.mock("ethers", () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => mockProvider),
    Contract: vi.fn().mockImplementation(() => mockContract),
  },
}));

// Must import after mocking
const { PurchaseWatcher } = await import("./purchaseWatcher.js");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockCreditManager() {
  return {
    addCredits: vi.fn().mockResolvedValue(undefined),
  };
}

const DEFAULT_CONFIG = {
  contractAddress: "0xcontract",
  rpcUrl: "https://rpc.example.com",
  pollIntervalMs: 60_000,
};

function createWatcher(pool: ReturnType<typeof createMockPool>, creditManager?: ReturnType<typeof createMockCreditManager>) {
  const cm = creditManager ?? createMockCreditManager();
  const watcher = new PurchaseWatcher(pool as any, cm as any, DEFAULT_CONFIG);
  return { watcher, creditManager: cm };
}

function createMockEvent(overrides?: Record<string, unknown>) {
  return {
    args: [
      "0xBuyer1111111111111111111111111111111111111", // buyer
      BigInt(1), // packId
      BigInt(14000), // creditAmount (140 display credits)
      BigInt("5000000"), // pricePaid (5 USDC, 6 decimals)
      false, // isNook
    ],
    transactionHash: "0xtxhash001",
    blockNumber: 500,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProvider.getBlockNumber.mockResolvedValue(1000);
  mockContract.queryFilter.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
//  start / stop
// ---------------------------------------------------------------------------

describe("PurchaseWatcher.start / stop", () => {
  it("starts and stops polling timer", () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    watcher.start();
    // start again should be no-op
    watcher.start();
    watcher.stop();
    // stop again should be no-op
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
//  poll (private — tested via reflection)
// ---------------------------------------------------------------------------

describe("PurchaseWatcher.poll", () => {
  it("initializes lastProcessedBlock on first run", async () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    mockProvider.getBlockNumber.mockResolvedValue(500);
    // getLastProcessedBlock → returns 0 (first run)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // setLastProcessedBlock → upsert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (watcher as any).poll();

    // Should have set last block to 500
    const upsertCall = pool.query.mock.calls[1];
    expect(upsertCall[1]).toContain("500");
  });

  it("skips when no new blocks", async () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    mockProvider.getBlockNumber.mockResolvedValue(500);
    // getLastProcessedBlock → returns 500
    pool.query.mockResolvedValueOnce({ rows: [{ value: "500" }], rowCount: 1 });

    await (watcher as any).poll();

    // Should not have queried for events
    expect(mockContract.queryFilter).not.toHaveBeenCalled();
  });

  it("queries events for new block range (single batch)", async () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    mockProvider.getBlockNumber.mockResolvedValue(505);
    // getLastProcessedBlock → returns 500
    pool.query.mockResolvedValueOnce({ rows: [{ value: "500" }], rowCount: 1 });
    // setLastProcessedBlock at end
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await (watcher as any).poll();

    expect(mockContract.queryFilter).toHaveBeenCalledWith(mockFilter, 501, 505);
  });

  it("processes multiple batches of 10 blocks to catch up", async () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    mockProvider.getBlockNumber.mockResolvedValue(530);
    // getLastProcessedBlock → returns 500
    pool.query.mockResolvedValueOnce({ rows: [{ value: "500" }], rowCount: 1 });
    // setLastProcessedBlock calls (3 batches: 501-510, 511-520, 521-530)
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await (watcher as any).poll();

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(3);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, mockFilter, 501, 510);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(2, mockFilter, 511, 520);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(3, mockFilter, 521, 530);
  });

  it("caps at 50 batches per poll (500 blocks)", async () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    mockProvider.getBlockNumber.mockResolvedValue(20000);
    pool.query.mockResolvedValueOnce({ rows: [{ value: "500" }], rowCount: 1 });
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await (watcher as any).poll();

    // 50 batches of 10 = 500 blocks processed (501-1000), stops at batch limit
    expect(mockContract.queryFilter).toHaveBeenCalledTimes(50);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, mockFilter, 501, 510);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(50, mockFilter, 991, 1000);
  });

  it("skips when already processing", async () => {
    const pool = createMockPool();
    const { watcher } = createWatcher(pool);

    // Set processing flag
    (watcher as any).processing = true;

    await (watcher as any).poll();

    // Should not have called getBlockNumber
    expect(mockProvider.getBlockNumber).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  processEvent (private — tested via reflection)
// ---------------------------------------------------------------------------

describe("PurchaseWatcher.processEvent", () => {
  it("processes event and credits agent", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { watcher } = createWatcher(pool, creditManager);
    const event = createMockEvent();

    // Agent lookup by address
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "agt_buyer" }],
      rowCount: 1,
    });
    // INSERT purchase record
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // UPDATE has_purchased
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (watcher as any).processEvent(event);

    // Verify agent lookup query
    const lookupCall = pool.query.mock.calls[0];
    expect(lookupCall[0]).toContain("LOWER(address) = LOWER");

    // Verify purchase record insert
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO credit_purchases");
    expect(insertCall[1][0]).toBe("agt_buyer"); // agent_id
    expect(insertCall[1][2]).toBe("0xtxhash001"); // tx_hash
    expect(insertCall[1][3]).toBe(1); // pack_id
    expect(insertCall[1][4]).toBe(14000); // credit_amount
    expect(insertCall[1][6]).toBe("usdc"); // payment_token (isNook=false)

    // Verify credits added
    expect(creditManager.addCredits).toHaveBeenCalledWith("agt_buyer", 14000, "purchase", "0xtxhash001");
  });

  it("records nook payment token when isNook=true", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { watcher } = createWatcher(pool, creditManager);

    const event = createMockEvent();
    event.args[4] = true; // isNook

    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_buyer" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (watcher as any).processEvent(event);

    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[1][6]).toBe("nook"); // payment_token
  });

  it("records purchase when no agent found for buyer", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { watcher } = createWatcher(pool, creditManager);
    const event = createMockEvent();

    // No agent found
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT purchase record (still recorded)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (watcher as any).processEvent(event);

    // No credits added since no agent
    expect(creditManager.addCredits).not.toHaveBeenCalled();

    // But purchase was still recorded
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[1][0]).toBeNull(); // agent_id is null
  });

  it("skips duplicate events (tx_hash conflict)", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    const { watcher } = createWatcher(pool, creditManager);
    const event = createMockEvent();

    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_buyer" }], rowCount: 1 });
    // INSERT fails with duplicate — throw error to simulate constraint violation
    pool.query.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));

    await (watcher as any).processEvent(event);

    // Should not have credited
    expect(creditManager.addCredits).not.toHaveBeenCalled();
  });

  it("handles credit add failure gracefully", async () => {
    const pool = createMockPool();
    const creditManager = createMockCreditManager();
    creditManager.addCredits.mockRejectedValueOnce(new Error("DB error"));
    const { watcher } = createWatcher(pool, creditManager);
    const event = createMockEvent();

    pool.query.mockResolvedValueOnce({ rows: [{ id: "agt_buyer" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT

    // Should not throw — credit failure is caught
    await (watcher as any).processEvent(event);

    // Credits were attempted
    expect(creditManager.addCredits).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
//  Backfill mode (startBlock config)
// ---------------------------------------------------------------------------

describe("PurchaseWatcher.backfill", () => {
  it("uses startBlock on first run instead of skipping historical", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const watcher = new PurchaseWatcher(pool as any, cm as any, {
      ...DEFAULT_CONFIG,
      startBlock: 42594000,
    });

    mockProvider.getBlockNumber.mockResolvedValue(42594015);
    // getLastProcessedBlock → returns 0 (first run)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // setLastProcessedBlock calls during batch processing
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await (watcher as any).poll();

    // Should have queried events starting from startBlock, not skipped
    expect(mockContract.queryFilter).toHaveBeenCalled();
    // First batch should start from startBlock + 1
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(
      1,
      mockFilter,
      42594001,
      42594010,
    );
  });

  it("skips historical when startBlock is not set (default behavior)", async () => {
    const pool = createMockPool();
    const cm = createMockCreditManager();
    const watcher = new PurchaseWatcher(pool as any, cm as any, DEFAULT_CONFIG);

    mockProvider.getBlockNumber.mockResolvedValue(500);
    // getLastProcessedBlock → returns 0 (first run)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // setLastProcessedBlock upsert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (watcher as any).poll();

    // Should NOT have queried for events — just set last block to current
    expect(mockContract.queryFilter).not.toHaveBeenCalled();
  });
});
