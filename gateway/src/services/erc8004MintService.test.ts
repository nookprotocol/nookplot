import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { ERC8004MintService } from "./erc8004MintService.js";
import type { ERC8004MintServiceConfig } from "./erc8004MintService.js";
import { createMockPool, type MockPool } from "../test/helpers.js";

// Suppress audit log calls
vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// Mock the ABI import so we don't need the full SDK build
vi.mock("@nookplot/sdk/dist/abis.js", () => ({
  ERC8004_IDENTITY_REGISTRY_ABI: [
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function register(string agentURI) returns (uint256)",
    "function transferFrom(address from, address to, uint256 tokenId)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "event Registered(uint256 indexed agentId, address indexed owner, string agentURI)",
  ],
}));

// ---------------------------------------------------------------------------
//  Test setup helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "agt_test_import_001";
const AGENT_ADDRESS = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const REGISTRY_ADDRESS = "0xBbBBBBbbBBBb00000000000000000000bBbBbBbB";
const RELAYER_ADDRESS = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc";
const EXISTING_TOKEN_ID = 42n;

function makeConfig(): ERC8004MintServiceConfig {
  return {
    identityRegistryAddress: REGISTRY_ADDRESS,
    autoTransfer: true,
  };
}

function makeMockIpfs() {
  return {
    uploadJson: vi.fn().mockResolvedValue({ cid: "QmTestCid123" }),
    getGatewayUrl: vi.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  };
}

// We can't easily construct the real ERC8004MintService because it creates
// an ethers.Contract internally. Instead, we'll construct it with a real
// provider/wallet then replace the internal contract with a mock.
function createServiceWithMocks(pool: MockPool) {
  const ipfs = makeMockIpfs();

  // Create a dummy wallet (never hits the chain in tests)
  const wallet = new ethers.Wallet(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );

  // Create a minimal mock provider
  const mockProvider = {
    getBlockNumber: vi.fn().mockResolvedValue(100_000),
  } as unknown as ethers.JsonRpcProvider;

  const config = makeConfig();

  // Construct the service — this will create a real Contract internally,
  // but we'll replace it with our mock below
  const service = new ERC8004MintService(
    pool as any,
    ipfs,
    wallet,
    mockProvider,
    config,
  );

  // Replace the internal contract with a mock object
  const mockContract = {
    balanceOf: vi.fn(),
    tokenURI: vi.fn(),
    register: vi.fn(),
    transferFrom: vi.fn(),
    filters: {
      Transfer: vi.fn().mockReturnValue("mock-filter"),
    },
    queryFilter: vi.fn(),
    interface: {
      parseLog: vi.fn(),
    },
  };

  // Replace private fields via any cast
  (service as any).contract = mockContract;
  (service as any).provider = mockProvider;
  (service as any).relayerAddress = RELAYER_ADDRESS;

  return { service, pool, ipfs, mockContract, mockProvider };
}

// ---------------------------------------------------------------------------
//  importExisting
// ---------------------------------------------------------------------------

describe("ERC8004MintService — importExisting", () => {
  let service: ERC8004MintService;
  let pool: MockPool;
  let mockContract: any;
  let mockProvider: any;

  beforeEach(() => {
    const mocks = createServiceWithMocks(createMockPool());
    service = mocks.service;
    pool = mocks.pool;
    mockContract = mocks.mockContract;
    mockProvider = mocks.mockProvider;
  });

  // -------------------------------------------------------------------------
  //  Idempotency: agent already has erc8004_agent_id in DB
  // -------------------------------------------------------------------------

  it("returns early if agent already has an erc8004_agent_id in the DB", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: "99" }],
      rowCount: 1,
    });

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toEqual({
      agentId: 99n,
      imported: true,
      metadataCid: null,
    });
    // Should NOT have called balanceOf (early exit)
    expect(mockContract.balanceOf).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  //  No on-chain identity: balanceOf returns 0
  // -------------------------------------------------------------------------

  it("returns null when agent has no on-chain ERC-8004 identity (balance = 0)", async () => {
    // DB check: no existing erc8004_agent_id
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    mockContract.balanceOf.mockResolvedValue(0n);

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toBeNull();
    expect(mockContract.balanceOf).toHaveBeenCalledWith(AGENT_ADDRESS);
    // Should NOT have tried to scan events
    expect(mockContract.queryFilter).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  //  Existing identity found: imports successfully
  // -------------------------------------------------------------------------

  it("imports existing on-chain identity when balance > 0 and Transfer events found", async () => {
    // DB check: no existing erc8004_agent_id
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    // On-chain balance = 1 (has an identity)
    mockContract.balanceOf.mockResolvedValue(1n);

    // Transfer event scan finds a mint event
    mockContract.queryFilter.mockResolvedValueOnce([
      {
        args: { tokenId: EXISTING_TOKEN_ID },
      },
    ]);

    // tokenURI returns an IPFS URL
    mockContract.tokenURI.mockResolvedValue(
      "https://gateway.pinata.cloud/ipfs/QmExistingMetadata",
    );

    // DB update succeeds
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toEqual({
      agentId: EXISTING_TOKEN_ID,
      imported: true,
      metadataCid: "QmExistingMetadata",
    });

    // Verify DB was updated with imported source
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("erc8004_source = 'imported'"),
      [EXISTING_TOKEN_ID.toString(), "QmExistingMetadata", AGENT_ID],
    );
  });

  // -------------------------------------------------------------------------
  //  Balance > 0 but no Transfer events: returns null
  // -------------------------------------------------------------------------

  it("returns null when balance > 0 but no Transfer events found", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    mockContract.balanceOf.mockResolvedValue(1n);

    // No Transfer events in any chunk
    mockContract.queryFilter.mockResolvedValue([]);

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toBeNull();
    // Should have scanned multiple chunks
    expect(mockContract.queryFilter).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  //  tokenURI extraction failure is non-fatal
  // -------------------------------------------------------------------------

  it("imports successfully even when tokenURI read fails", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    mockContract.balanceOf.mockResolvedValue(1n);

    mockContract.queryFilter.mockResolvedValueOnce([
      { args: { tokenId: EXISTING_TOKEN_ID } },
    ]);

    // tokenURI call fails
    mockContract.tokenURI.mockRejectedValue(new Error("tokenURI reverted"));

    // DB update
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toEqual({
      agentId: EXISTING_TOKEN_ID,
      imported: true,
      metadataCid: null,
    });
  });

  // -------------------------------------------------------------------------
  //  tokenURI with unexpected format: metadataCid is null
  // -------------------------------------------------------------------------

  it("sets metadataCid to null when tokenURI format is unexpected", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    mockContract.balanceOf.mockResolvedValue(1n);

    mockContract.queryFilter.mockResolvedValueOnce([
      { args: { tokenId: EXISTING_TOKEN_ID } },
    ]);

    // tokenURI returns a non-IPFS URL
    mockContract.tokenURI.mockResolvedValue("https://example.com/metadata/42");

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toEqual({
      agentId: EXISTING_TOKEN_ID,
      imported: true,
      metadataCid: null,
    });
  });

  // -------------------------------------------------------------------------
  //  Event chunk scanning: handles failed chunks gracefully
  // -------------------------------------------------------------------------

  it("skips failed event chunks and continues scanning", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    mockContract.balanceOf.mockResolvedValue(1n);

    // First chunk fails, second chunk has the event
    mockContract.queryFilter
      .mockRejectedValueOnce(new Error("RPC error"))
      .mockResolvedValueOnce([
        { args: { tokenId: 77n } },
      ]);

    mockContract.tokenURI.mockResolvedValue(
      "https://gateway.pinata.cloud/ipfs/QmFoundIt",
    );

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    expect(result).toEqual({
      agentId: 77n,
      imported: true,
      metadataCid: "QmFoundIt",
    });
  });
});

// ---------------------------------------------------------------------------
//  mintAndTransfer — does NOT mint when agent already has ERC-8004
// ---------------------------------------------------------------------------

describe("ERC8004MintService — mintAndTransfer idempotency", () => {
  it("throws if agent already has an erc8004_agent_id", async () => {
    const { service, pool } = createServiceWithMocks(createMockPool());

    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: "42" }],
      rowCount: 1,
    });

    await expect(
      service.mintAndTransfer(AGENT_ID, AGENT_ADDRESS, "bafyDid123"),
    ).rejects.toThrow("Agent already has ERC-8004 ID: 42");
  });
});

// ---------------------------------------------------------------------------
//  Integration: relay route import-first logic
// ---------------------------------------------------------------------------

describe("ERC8004 import-first logic (relay route pattern)", () => {
  it("skips mintAndTransfer when importExisting returns a result", async () => {
    const { service, pool, mockContract } = createServiceWithMocks(createMockPool());

    // Simulate importExisting returning an imported identity
    const importSpy = vi.spyOn(service, "importExisting").mockResolvedValue({
      agentId: EXISTING_TOKEN_ID,
      imported: true,
      metadataCid: "QmImported",
    });

    const mintSpy = vi.spyOn(service, "mintAndTransfer");

    // Replicate the relay route pattern
    const imported = await service.importExisting(AGENT_ID, AGENT_ADDRESS);
    if (imported) {
      // Linked existing — no mint needed (this is the relay route behavior)
    } else {
      await service.mintAndTransfer(
        AGENT_ID,
        AGENT_ADDRESS,
        "bafyDid123",
        "Test Agent",
        "A test agent",
        ["chat"],
      );
    }

    expect(importSpy).toHaveBeenCalledOnce();
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it("calls mintAndTransfer when importExisting returns null (no existing identity)", async () => {
    const { service } = createServiceWithMocks(createMockPool());

    const importSpy = vi.spyOn(service, "importExisting").mockResolvedValue(null);
    const mintSpy = vi.spyOn(service, "mintAndTransfer").mockResolvedValue({
      agentId: 100n,
      metadataCid: "QmNew",
      mintTxHash: "0xabc",
      transferTxHash: "0xdef",
    });

    // Replicate the relay route pattern
    const imported = await service.importExisting(AGENT_ID, AGENT_ADDRESS);
    if (imported) {
      // Would link existing
    } else {
      await service.mintAndTransfer(
        AGENT_ID,
        AGENT_ADDRESS,
        "bafyDid123",
        "Test Agent",
        "A test agent",
        ["chat"],
      );
    }

    expect(importSpy).toHaveBeenCalledOnce();
    expect(mintSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
//  Integration: mint-erc8004 backfill endpoint pattern
// ---------------------------------------------------------------------------

describe("ERC8004 backfill endpoint pattern (mint-erc8004 route)", () => {
  it("returns imported result when existing identity found", async () => {
    const { service } = createServiceWithMocks(createMockPool());

    vi.spyOn(service, "importExisting").mockResolvedValue({
      agentId: EXISTING_TOKEN_ID,
      imported: true,
      metadataCid: "QmBackfillImport",
    });

    const mintForExistingSpy = vi.spyOn(service, "mintForExisting");

    // Replicate the backfill endpoint pattern
    const imported = await service.importExisting(AGENT_ID, AGENT_ADDRESS);
    let response: any;

    if (imported) {
      response = {
        imported: true,
        erc8004AgentId: Number(imported.agentId),
        metadataCid: imported.metadataCid,
      };
    } else {
      const result = await service.mintForExisting(AGENT_ID);
      response = {
        erc8004AgentId: Number(result.agentId),
        metadataCid: result.metadataCid,
        mintTxHash: result.mintTxHash,
        transferTxHash: result.transferTxHash ?? null,
      };
    }

    expect(response).toEqual({
      imported: true,
      erc8004AgentId: 42,
      metadataCid: "QmBackfillImport",
    });
    expect(mintForExistingSpy).not.toHaveBeenCalled();
  });

  it("falls back to mintForExisting when no existing identity", async () => {
    const { service } = createServiceWithMocks(createMockPool());

    vi.spyOn(service, "importExisting").mockResolvedValue(null);
    vi.spyOn(service, "mintForExisting").mockResolvedValue({
      agentId: 200n,
      metadataCid: "QmNewMint",
      mintTxHash: "0xmint123",
      transferTxHash: "0xtransfer456",
    });

    const imported = await service.importExisting(AGENT_ID, AGENT_ADDRESS);
    let response: any;

    if (imported) {
      response = {
        imported: true,
        erc8004AgentId: Number(imported.agentId),
        metadataCid: imported.metadataCid,
      };
    } else {
      const result = await service.mintForExisting(AGENT_ID);
      response = {
        erc8004AgentId: Number(result.agentId),
        metadataCid: result.metadataCid,
        mintTxHash: result.mintTxHash,
        transferTxHash: result.transferTxHash ?? null,
      };
    }

    expect(response).toEqual({
      erc8004AgentId: 200,
      metadataCid: "QmNewMint",
      mintTxHash: "0xmint123",
      transferTxHash: "0xtransfer456",
    });
  });
});

// ---------------------------------------------------------------------------
//  DB source tracking
// ---------------------------------------------------------------------------

describe("ERC8004 source tracking", () => {
  it("stores 'imported' source in DB when importing existing identity", async () => {
    const { service, pool, mockContract } = createServiceWithMocks(createMockPool());

    pool.query.mockResolvedValueOnce({
      rows: [{ erc8004_agent_id: null }],
      rowCount: 1,
    });

    mockContract.balanceOf.mockResolvedValue(1n);
    mockContract.queryFilter.mockResolvedValueOnce([
      { args: { tokenId: EXISTING_TOKEN_ID } },
    ]);
    mockContract.tokenURI.mockResolvedValue(
      "https://gateway.pinata.cloud/ipfs/QmSource",
    );

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await service.importExisting(AGENT_ID, AGENT_ADDRESS);

    // Find the UPDATE call (second query call)
    const updateCall = pool.query.mock.calls.find(
      (call: any) => typeof call[0] === "string" && call[0].includes("erc8004_source"),
    );

    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("erc8004_source = 'imported'");
    expect(updateCall![1]).toEqual([
      EXISTING_TOKEN_ID.toString(),
      "QmSource",
      AGENT_ID,
    ]);
  });
});
