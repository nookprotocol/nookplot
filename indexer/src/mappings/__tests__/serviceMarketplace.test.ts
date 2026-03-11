import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleServiceListed,
  handleServiceUpdated,
  handleAgreementCreated,
  handleWorkDelivered,
  handleAgreementSettled,
  handleAgreementDisputed,
  handleDisputeResolved,
  handleAgreementCancelled,
  handleDeliveryExpired,
  handleDisputeExpired,
  handleAgreementCancelledWithFee,
} from "../serviceMarketplace.js";
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

/**
 * Build a mock LogDescription whose `args` behaves like a Result —
 * both positional (args[0]) and named (args.fieldName) access work.
 */
function createMockParsed(namedArgs: Record<string, any>): LogDescription {
  const keys = Object.keys(namedArgs);
  const values = Object.values(namedArgs);

  // Create an array-like object that also supports named access
  const args: any = [...values];
  for (const key of keys) {
    args[key] = namedArgs[key];
  }

  return { args } as unknown as LogDescription;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("serviceMarketplace handlers", () => {
  let ctx: MappingContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  // ── handleServiceListed ─────────────────────────────────────
  it("handleServiceListed — inserts listing with all fields", async () => {
    const parsed = createMockParsed({
      listingId: BigInt(1),
      provider: "0xProvider1234567890abcdef1234567890abcdef",
      category: "code-review",
      metadataCid: "QmListingMeta",
      priceAmount: BigInt("2500000"),
    });

    await handleServiceListed(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO idx_service_listings");
    expect(sql).toContain("ON CONFLICT (listing_id) DO UPDATE");
    expect(params[0]).toBe(1);                      // listingId as Number
    expect(params[1]).toBe("0xprovider1234567890abcdef1234567890abcdef"); // lowercased
    expect(params[2]).toBe("code-review");
    expect(params[3]).toBe("QmListingMeta");
    expect(params[4]).toBe("2500000");
    expect(params[5]).toBe(1700000000);              // ctx.timestamp
    expect(params[6]).toBe(42600000);                // ctx.blockNumber
    expect(params[7]).toBe("0xabc123");              // ctx.transactionHash
  });

  // ── handleServiceUpdated ────────────────────────────────────
  it("handleServiceUpdated — updates metadata and active flag", async () => {
    const parsed = createMockParsed({
      listingId: BigInt(1),
      metadataCid: "QmUpdatedMeta",
      active: true,
    });

    await handleServiceUpdated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_service_listings");
    expect(sql).toContain("metadata_cid");
    expect(sql).toContain("active");
    expect(params[0]).toBe(1);
    expect(params[1]).toBe("QmUpdatedMeta");
    expect(params[2]).toBe(true);
    expect(params[3]).toBe(1700000000);
    expect(params[4]).toBe(42600000);
  });

  it("handleServiceUpdated — can deactivate a listing", async () => {
    const parsed = createMockParsed({
      listingId: BigInt(5),
      metadataCid: "QmSameMeta",
      active: false,
    });

    await handleServiceUpdated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    const [, params] = query.mock.calls[0];
    expect(params[2]).toBe(false);
  });

  // ── handleAgreementCreated ──────────────────────────────────
  it("handleAgreementCreated — inserts agreement with status 1", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      listingId: BigInt(1),
      buyer: "0xBuyer12345678901234567890123456789012abcd",
      provider: "0xProvider1234567890abcdef1234567890abcdef",
      escrowAmount: BigInt("5000000"),
      tokenAddress: "0xTokenAddr1234567890abcdef1234567890abcdef",
    });

    await handleAgreementCreated(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO idx_service_agreements");
    expect(sql).toContain("ON CONFLICT (agreement_id) DO NOTHING");
    expect(params[0]).toBe(100);
    expect(params[1]).toBe(1);
    expect(params[2]).toBe("0xbuyer12345678901234567890123456789012abcd");
    expect(params[3]).toBe("0xprovider1234567890abcdef1234567890abcdef");
    expect(params[4]).toBe("5000000");
    expect(params[5]).toBe("0xtokenaddr1234567890abcdef1234567890abcdef");
    expect(params[6]).toBe(1700000000);  // ctx.timestamp
    expect(params[7]).toBe(42600000);    // ctx.blockNumber
    expect(params[8]).toBe("0xabc123");  // ctx.transactionHash
  });

  // ── handleWorkDelivered ─────────────────────────────────────
  it("handleWorkDelivered — updates status to 2 with delivery CID", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      deliveryCid: "QmDeliveryCid",
    });

    await handleWorkDelivered(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_service_agreements");
    expect(sql).toContain("status = 2");
    expect(sql).toContain("delivery_cid");
    expect(params[0]).toBe(100);
    expect(params[1]).toBe("QmDeliveryCid");
    expect(params[2]).toBe(42600000);
  });

  // ── handleAgreementSettled ──────────────────────────────────
  it("handleAgreementSettled — sets status 3 and increments listing counter", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
    });

    await handleAgreementSettled(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);

    // First: update agreement status
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("UPDATE idx_service_agreements");
    expect(sql1).toContain("status = 3");
    expect(sql1).toContain("buyer_approved");
    expect(params1[0]).toBe(100);
    expect(params1[1]).toBe(1700000000);
    expect(params1[2]).toBe(42600000);

    // Second: increment total_completed on listing
    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_service_listings");
    expect(sql2).toContain("total_completed");
    expect(params2[0]).toBe(100);
    expect(params2[1]).toBe(1700000000);
  });

  // ── handleAgreementDisputed ─────────────────────────────────
  it("handleAgreementDisputed — reads pre-dispute status, sets status 4, increments total_disputed", async () => {
    const query = vi.fn()
      // First call: SELECT pre-dispute status
      .mockResolvedValueOnce({ rows: [{ status: 2 }], rowCount: 1 })
      // Second call: UPDATE agreement
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // Third call: UPDATE listing total_disputed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    ctx = createMockContext();
    (ctx.client as any).query = query;

    const parsed = createMockParsed({
      agreementId: BigInt(100),
      disputedBy: "0xDisputer1234567890abcdef1234567890abcdef",
    });

    await handleAgreementDisputed(ctx, parsed);

    expect(query).toHaveBeenCalledTimes(3);

    // SELECT pre-dispute status
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("SELECT status FROM idx_service_agreements");
    expect(params1[0]).toBe(100);

    // UPDATE agreement to disputed
    const [sql2, params2] = query.mock.calls[1];
    expect(sql2).toContain("UPDATE idx_service_agreements");
    expect(sql2).toContain("status = 4");
    expect(sql2).toContain("pre_dispute_status");
    expect(sql2).toContain("dispute_initiator");
    expect(params2[0]).toBe(100);
    expect(params2[1]).toBe(1700000000);
    expect(params2[2]).toBe(2); // pre-dispute status from SELECT
    expect(params2[3]).toBe("0xdisputer1234567890abcdef1234567890abcdef");
    expect(params2[4]).toBe(42600000);

    // UPDATE listing total_disputed
    const [sql3] = query.mock.calls[2];
    expect(sql3).toContain("total_disputed");
  });

  it("handleAgreementDisputed — defaults pre_dispute_status to 1 when no row found", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no existing row
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    ctx = createMockContext();
    (ctx.client as any).query = query;

    const parsed = createMockParsed({
      agreementId: BigInt(200),
      disputedBy: "0xDisputer1234567890abcdef1234567890abcdef",
    });

    await handleAgreementDisputed(ctx, parsed);

    const [, params2] = query.mock.calls[1];
    expect(params2[2]).toBe(1); // fallback to status 1
  });

  // ── handleDisputeResolved — provider wins ───────────────────
  it("handleDisputeResolved — provider wins sets status 3 and increments completed", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      inFavorOfProvider: true,
    });

    await handleDisputeResolved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);

    // Update agreement
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("UPDATE idx_service_agreements");
    expect(sql1).toContain("settlement_method");
    expect(params1[1]).toBe(3);  // status = settled
    expect(params1[2]).toBe("dispute_provider_wins");
    expect(params1[3]).toBe(1700000000);
    expect(params1[4]).toBe(42600000);

    // Increment listing completed
    const [sql2] = query.mock.calls[1];
    expect(sql2).toContain("total_completed");
  });

  // ── handleDisputeResolved — buyer wins ──────────────────────
  it("handleDisputeResolved — buyer wins sets status 5 (cancelled)", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      inFavorOfProvider: false,
    });

    await handleDisputeResolved(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1); // no listing increment

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_service_agreements");
    expect(params[1]).toBe(5);  // status = cancelled
    expect(params[2]).toBe("dispute_buyer_wins");
  });

  // ── handleAgreementCancelled ────────────────────────────────
  it("handleAgreementCancelled — sets status 5 with 'cancelled' method", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
    });

    await handleAgreementCancelled(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_service_agreements");
    expect(sql).toContain("status = 5");
    expect(sql).toContain("cancelled");
    expect(params[0]).toBe(100);
    expect(params[1]).toBe(42600000);
  });

  // ── handleDeliveryExpired (V4) ──────────────────────────────
  it("handleDeliveryExpired — settles with 'timeout' and increments completed", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
    });

    await handleDeliveryExpired(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);

    // Update agreement
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("UPDATE idx_service_agreements");
    expect(sql1).toContain("status = 3");
    expect(sql1).toContain("timeout");
    expect(params1[0]).toBe(100);
    expect(params1[1]).toBe(1700000000);
    expect(params1[2]).toBe(42600000);

    // Increment listing completed
    const [sql2] = query.mock.calls[1];
    expect(sql2).toContain("total_completed");
  });

  // ── handleDisputeExpired (V5) — provider wins ───────────────
  it("handleDisputeExpired — provider wins sets status 3 and increments completed", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      providerWins: true,
      cancellationFee: BigInt("100000"),
    });

    await handleDisputeExpired(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(2);

    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain("UPDATE idx_service_agreements");
    expect(sql1).toContain("cancellation_fee");
    expect(params1[1]).toBe(3);  // settled
    expect(params1[2]).toBe("dispute_expired_provider");
    expect(params1[3]).toBe("100000");
    expect(params1[4]).toBe(1700000000);
    expect(params1[5]).toBe(42600000);

    // Increment listing completed
    const [sql2] = query.mock.calls[1];
    expect(sql2).toContain("total_completed");
  });

  // ── handleDisputeExpired (V5) — buyer wins ──────────────────
  it("handleDisputeExpired — buyer wins sets status 5, no listing increment", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      providerWins: false,
      cancellationFee: BigInt("50000"),
    });

    await handleDisputeExpired(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1); // no listing increment

    const [sql, params] = query.mock.calls[0];
    expect(params[1]).toBe(5);  // cancelled
    expect(params[2]).toBe("dispute_expired_buyer");
    expect(params[3]).toBe("50000");
  });

  // ── handleAgreementCancelledWithFee (V5) ────────────────────
  it("handleAgreementCancelledWithFee — sets status 5 with fee", async () => {
    const parsed = createMockParsed({
      agreementId: BigInt(100),
      cancellationFee: BigInt("250000"),
    });

    await handleAgreementCancelledWithFee(ctx, parsed);

    const query = ctx.client.query as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("UPDATE idx_service_agreements");
    expect(sql).toContain("status = 5");
    expect(sql).toContain("cancelled_with_fee");
    expect(sql).toContain("cancellation_fee");
    expect(params[0]).toBe(100);
    expect(params[1]).toBe("250000");
    expect(params[2]).toBe(42600000);
  });
});
