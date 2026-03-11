import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  handleBountyCreated,
  handleBountyClaimed,
  handleBountyUnclaimed,
  handleWorkSubmitted,
  handleWorkApproved,
  handleBountyDisputed,
  handleDisputeResolved,
  handleBountyCancelled,
  handleBountyExpired,
  handleClaimerApproved,
} from "../bountyContract.js";
import type { MappingContext } from "../types.js";
import type { LogDescription } from "ethers";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<MappingContext> = {}): MappingContext {
  return {
    client: {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as any,
    blockNumber: 42600000,
    timestamp: 1700000000,
    transactionHash: "0xabc123",
    logIndex: 0,
    ...overrides,
  };
}

function createMockParsed(args: any[]): LogDescription {
  return { args } as unknown as LogDescription;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("bountyContract handlers", () => {
  let ctx: MappingContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  // ── handleBountyCreated ─────────────────────────────────────
  it("handleBountyCreated — inserts bounty with all fields", async () => {
    const parsed = createMockParsed([
      BigInt(42),                                     // bountyId
      "0xCreator1234567890abcdef1234567890abcdef12",  // creator
      "QmBountyMetadata",                             // metadataCid
      "ai-research",                                  // community
      BigInt("10000000"),                              // rewardAmount
      BigInt(1),                                       // escrowType
      BigInt(1700100000),                              // deadline
      "0xTokenAddress1234567890abcdef12345678901234",  // tokenAddress (V2)
    ]);

    await handleBountyCreated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO idx_bounties");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(params[0]).toBe("42");                    // bountyId as string
    expect(params[1]).toBe("0xcreator1234567890abcdef1234567890abcdef12"); // lowercased
    expect(params[2]).toBe("QmBountyMetadata");
    expect(params[3]).toBe("ai-research");
    expect(params[4]).toBe("10000000");              // rewardAmount as string
    expect(params[5]).toBe(1);                       // escrowType as number
    expect(params[6]).toBe(1700100000);              // deadline as number
    expect(params[7]).toBe(1700000000);              // ctx.timestamp
    expect(params[8]).toBe("0xtokenaddress1234567890abcdef12345678901234"); // tokenAddress lowercased
    expect(params[9]).toBe(42600000);                // blockNumber
  });

  it("handleBountyCreated — handles V1 events without tokenAddress", async () => {
    // V1 events only have 7 args (no tokenAddress at index 7)
    const parsed = createMockParsed([
      BigInt(10),
      "0xCreator1234567890abcdef1234567890abcdef12",
      "QmOldMeta",
      "general",
      BigInt("5000000"),
      BigInt(0),
      BigInt(1700050000),
    ]);

    await handleBountyCreated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    const [, params] = query.mock.calls[0];
    expect(params[8]).toBeNull(); // tokenAddress null for V1
  });

  // ── handleBountyClaimed ─────────────────────────────────────
  it("handleBountyClaimed — updates claimer and status to 1", async () => {
    const parsed = createMockParsed([
      BigInt(42),                                     // bountyId
      "0xClaimer1234567890abcdef1234567890abcdef12",  // claimer
    ]);

    await handleBountyClaimed(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 1");
    expect(params[0]).toBe("0xclaimer1234567890abcdef1234567890abcdef12");
    expect(params[1]).toBe(1700000000); // ctx.timestamp
    expect(params[2]).toBe(42600000);
    expect(params[3]).toBe("42");
  });

  // ── handleBountyUnclaimed ───────────────────────────────────
  it("handleBountyUnclaimed — resets claimer and status to 0", async () => {
    const parsed = createMockParsed([
      BigInt(42),
    ]);

    await handleBountyUnclaimed(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("claimer = NULL");
    expect(sql).toContain("status = 0");
    expect(params[0]).toBe(42600000);
    expect(params[1]).toBe("42");
  });

  // ── handleWorkSubmitted ─────────────────────────────────────
  it("handleWorkSubmitted — sets submission_cid and status to 2", async () => {
    const parsed = createMockParsed([
      BigInt(42),                                     // bountyId
      "0xSubmitter1234567890abcdef1234567890abcdef",  // submitter (unused, index 1)
      "QmSubmissionCid",                              // submissionCid (index 2)
    ]);

    await handleWorkSubmitted(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("submission_cid");
    expect(sql).toContain("status = 2");
    expect(params[0]).toBe("QmSubmissionCid");
    expect(params[1]).toBe(1700000000); // ctx.timestamp
    expect(params[2]).toBe(42600000);
    expect(params[3]).toBe("42");
  });

  // ── handleWorkApproved ──────────────────────────────────────
  it("handleWorkApproved — sets status 3, fee_amount, net_payout", async () => {
    const parsed = createMockParsed([
      BigInt(42),                                     // bountyId
      "0xApprover1234567890abcdef1234567890abcdef",   // approver (unused)
      BigInt("9500000"),                               // netPayout
      BigInt("500000"),                                // feeAmount
      BigInt(1700002000),                              // timestamp (unused)
    ]);

    await handleWorkApproved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 3");
    expect(sql).toContain("fee_amount");
    expect(sql).toContain("net_payout");
    expect(params[0]).toBe("500000");   // feeAmount
    expect(params[1]).toBe("9500000");  // netPayout
    expect(params[2]).toBe(42600000);
    expect(params[3]).toBe("42");
  });

  // ── handleBountyDisputed ────────────────────────────────────
  it("handleBountyDisputed — sets status to 4", async () => {
    const parsed = createMockParsed([
      BigInt(42),
    ]);

    await handleBountyDisputed(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 4");
    expect(params[0]).toBe(42600000);
    expect(params[1]).toBe("42");
  });

  // ── handleDisputeResolved — released to worker ──────────────
  it("handleDisputeResolved — released to worker sets status to 3", async () => {
    const parsed = createMockParsed([
      BigInt(42),
      true, // releasedToWorker
    ]);

    await handleDisputeResolved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 3");
    expect(params[0]).toBe(42600000);
    expect(params[1]).toBe("42");
  });

  // ── handleDisputeResolved — not released to worker ──────────
  it("handleDisputeResolved — not released resets bounty to open", async () => {
    const parsed = createMockParsed([
      BigInt(42),
      false, // releasedToWorker
    ]);

    await handleDisputeResolved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 0");
    expect(sql).toContain("claimer = NULL");
    expect(sql).toContain("submission_cid = NULL");
    expect(params[0]).toBe(42600000);
    expect(params[1]).toBe("42");
  });

  // ── handleBountyCancelled ───────────────────────────────────
  it("handleBountyCancelled — sets status to 5", async () => {
    const parsed = createMockParsed([
      BigInt(42),
    ]);

    await handleBountyCancelled(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 5");
    expect(params[0]).toBe(42600000);
    expect(params[1]).toBe("42");
  });

  // ── handleBountyExpired ─────────────────────────────────────
  it("handleBountyExpired — sets status to 6", async () => {
    const parsed = createMockParsed([
      BigInt(42),
    ]);

    await handleBountyExpired(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("status = 6");
    expect(params[0]).toBe(42600000);
    expect(params[1]).toBe("42");
  });

  // ── handleClaimerApproved — non-zero address ────────────────
  it("handleClaimerApproved — sets approved_claimer for non-zero address", async () => {
    const parsed = createMockParsed([
      BigInt(42),
      "0xClaimer1234567890abcdef1234567890abcdef12",
    ]);

    await handleClaimerApproved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_bounties");
    expect(sql).toContain("approved_claimer");
    expect(params[0]).toBe("0xclaimer1234567890abcdef1234567890abcdef12");
    expect(params[1]).toBe(42600000);
    expect(params[2]).toBe("42");
  });

  // ── handleClaimerApproved — zero address (revoke) ───────────
  it("handleClaimerApproved — zero address sets approved_claimer to null", async () => {
    const parsed = createMockParsed([
      BigInt(42),
      ethers.ZeroAddress, // 0x0000...0000
    ]);

    await handleClaimerApproved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    const [, params] = query.mock.calls[0];
    expect(params[0]).toBeNull();
    expect(params[1]).toBe(42600000);
    expect(params[2]).toBe("42");
  });
});
