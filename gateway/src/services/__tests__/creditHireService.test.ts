import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreditHireService, type CreditAgreement } from "../creditHireService.js";

// ============================================================
//  Mock audit log
// ============================================================

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ============================================================
//  Mock factories
// ============================================================

function createMockClient() {
  return {
    // Default: resolve with empty rows so catch-block ROLLBACK calls don't crash
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn(),
  } as any;
}

// ============================================================
//  Test data
// ============================================================

const BUYER_AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const PROVIDER_AGENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const PROVIDER_ADDRESS = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
const LISTING_ID = 42;
const AGREEMENT_ID = "cccccccc-1111-2222-3333-444444444444";

function makeFakeAgreement(overrides: Partial<CreditAgreement> = {}): CreditAgreement {
  return {
    id: AGREEMENT_ID,
    listing_id: LISTING_ID,
    buyer_agent_id: BUYER_AGENT_ID,
    provider_agent_id: PROVIDER_AGENT_ID,
    credit_amount: 100,
    terms: "Build a widget",
    status: "pending",
    delivery_notes: null,
    dispute_reason: null,
    created_at: new Date("2026-01-01"),
    accepted_at: null,
    delivered_at: null,
    completed_at: null,
    cancelled_at: null,
    updated_at: new Date("2026-01-01"),
    ...overrides,
  };
}

// ============================================================
//  Tests
// ============================================================

describe("CreditHireService", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;
  let service: CreditHireService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    service = new CreditHireService(mockPool);
  });

  // ----------------------------------------------------------
  //  createAgreement
  // ----------------------------------------------------------

  describe("createAgreement", () => {
    it("happy path: listing found, buyer has credits, agreement created", async () => {
      const fakeAgreement = makeFakeAgreement({ status: "pending", provider_agent_id: null });

      // Set up the sequential client.query calls for the transaction
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT listing
        .mockResolvedValueOnce({ rows: [{ provider_address: PROVIDER_ADDRESS }] })
        // SELECT provider agent (different from buyer)
        .mockResolvedValueOnce({ rows: [{ id: PROVIDER_AGENT_ID }] })
        // SELECT credit_accounts (buyer balance)
        .mockResolvedValueOnce({ rows: [{ balance_credits: "500" }] })
        // UPDATE credit_accounts (deduct)
        .mockResolvedValueOnce({ rows: [] })
        // INSERT credit_transactions
        .mockResolvedValueOnce({ rows: [] })
        // INSERT credit_agreements RETURNING *
        .mockResolvedValueOnce({ rows: [fakeAgreement] })
        // COMMIT
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.createAgreement(LISTING_ID, BUYER_AGENT_ID, "Build a widget", 100);

      expect(result).toEqual(fakeAgreement);
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws INSUFFICIENT_CREDITS when buyer has too few credits", async () => {
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT listing
        .mockResolvedValueOnce({ rows: [{ provider_address: PROVIDER_ADDRESS }] })
        // SELECT provider agent (different from buyer)
        .mockResolvedValueOnce({ rows: [{ id: PROVIDER_AGENT_ID }] })
        // SELECT credit_accounts (low balance)
        .mockResolvedValueOnce({ rows: [{ balance_credits: "50" }] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.createAgreement(LISTING_ID, BUYER_AGENT_ID, "Build a widget", 100),
      ).rejects.toThrow("INSUFFICIENT_CREDITS");

      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws ACCOUNT_NOT_FOUND when buyer has no credit account", async () => {
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT listing
        .mockResolvedValueOnce({ rows: [{ provider_address: PROVIDER_ADDRESS }] })
        // SELECT provider agent (different from buyer)
        .mockResolvedValueOnce({ rows: [{ id: PROVIDER_AGENT_ID }] })
        // SELECT credit_accounts (empty)
        .mockResolvedValueOnce({ rows: [] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.createAgreement(LISTING_ID, BUYER_AGENT_ID, "Build a widget", 100),
      ).rejects.toThrow("ACCOUNT_NOT_FOUND");

      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws SELF_HIRE_BLOCKED when buyer is the provider", async () => {
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT listing — provider address found
        .mockResolvedValueOnce({ rows: [{ provider_address: PROVIDER_ADDRESS }] })
        // SELECT agent for provider address — same as buyer
        .mockResolvedValueOnce({ rows: [{ id: BUYER_AGENT_ID }] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.createAgreement(LISTING_ID, BUYER_AGENT_ID, "Build a widget", 100),
      ).rejects.toThrow("SELF_HIRE_BLOCKED");

      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws when credit amount is not positive", async () => {
      await expect(
        service.createAgreement(LISTING_ID, BUYER_AGENT_ID, "Build a widget", 0),
      ).rejects.toThrow("Credit amount must be positive");

      await expect(
        service.createAgreement(LISTING_ID, BUYER_AGENT_ID, "Build a widget", -5),
      ).rejects.toThrow("Credit amount must be positive");
    });
  });

  // ----------------------------------------------------------
  //  acceptAgreement
  // ----------------------------------------------------------

  describe("acceptAgreement", () => {
    it("happy path: provider accepts pending agreement", async () => {
      const accepted = makeFakeAgreement({
        status: "accepted",
        accepted_at: new Date("2026-01-02"),
      });

      mockPool.query.mockResolvedValueOnce({ rows: [accepted] });

      const result = await service.acceptAgreement(AGREEMENT_ID, PROVIDER_AGENT_ID);

      expect(result).toEqual(accepted);
      expect(result.status).toBe("accepted");
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE credit_agreements"),
        [PROVIDER_AGENT_ID, AGREEMENT_ID],
      );
    });

    it("throws when agreement not found or wrong status", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.acceptAgreement(AGREEMENT_ID, PROVIDER_AGENT_ID),
      ).rejects.toThrow("Agreement not found or not in pending status");
    });
  });

  // ----------------------------------------------------------
  //  deliverWork
  // ----------------------------------------------------------

  describe("deliverWork", () => {
    it("happy path: provider delivers work on accepted agreement", async () => {
      const delivered = makeFakeAgreement({
        status: "delivered",
        delivery_notes: "Work is done",
        delivered_at: new Date("2026-01-03"),
      });

      mockPool.query.mockResolvedValueOnce({ rows: [delivered] });

      const result = await service.deliverWork(AGREEMENT_ID, PROVIDER_AGENT_ID, "Work is done");

      expect(result).toEqual(delivered);
      expect(result.status).toBe("delivered");
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE credit_agreements"),
        ["Work is done", AGREEMENT_ID, PROVIDER_AGENT_ID],
      );
    });

    it("throws when agreement not found or not accepted", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.deliverWork(AGREEMENT_ID, PROVIDER_AGENT_ID, "Work is done"),
      ).rejects.toThrow("Agreement not found or not in accepted status");
    });
  });

  // ----------------------------------------------------------
  //  completeAgreement
  // ----------------------------------------------------------

  describe("completeAgreement", () => {
    it("happy path: credits transferred to provider", async () => {
      const deliveredAgreement = makeFakeAgreement({
        status: "delivered",
        credit_amount: 100,
        provider_agent_id: PROVIDER_AGENT_ID,
      });
      const completedAgreement = makeFakeAgreement({
        status: "completed",
        completed_at: new Date("2026-01-04"),
      });

      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT agreement FOR UPDATE
        .mockResolvedValueOnce({ rows: [deliveredAgreement] })
        // INSERT credit_accounts ON CONFLICT DO NOTHING (ensure provider account)
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE credit_accounts (credit provider)
        .mockResolvedValueOnce({ rows: [] })
        // SELECT balance for transaction record
        .mockResolvedValueOnce({ rows: [{ balance_credits: "600" }] })
        // INSERT credit_transactions
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE agreement to completed
        .mockResolvedValueOnce({ rows: [completedAgreement] })
        // COMMIT
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.completeAgreement(AGREEMENT_ID, BUYER_AGENT_ID);

      expect(result).toEqual(completedAgreement);
      expect(result.status).toBe("completed");
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws when agreement not found or not in delivered status", async () => {
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT agreement — empty
        .mockResolvedValueOnce({ rows: [] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.completeAgreement(AGREEMENT_ID, BUYER_AGENT_ID),
      ).rejects.toThrow("Agreement not found or not in delivered status");

      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws when no provider assigned", async () => {
      const noProvider = makeFakeAgreement({
        status: "delivered",
        provider_agent_id: null,
      });

      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT agreement
        .mockResolvedValueOnce({ rows: [noProvider] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.completeAgreement(AGREEMENT_ID, BUYER_AGENT_ID),
      ).rejects.toThrow("No provider assigned");

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  //  cancelAgreement
  // ----------------------------------------------------------

  describe("cancelAgreement", () => {
    it("happy path: credits refunded to buyer", async () => {
      const pendingAgreement = makeFakeAgreement({
        status: "pending",
        credit_amount: 100,
        buyer_agent_id: BUYER_AGENT_ID,
      });
      const cancelledAgreement = makeFakeAgreement({
        status: "cancelled",
        cancelled_at: new Date("2026-01-05"),
      });

      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT agreement FOR UPDATE
        .mockResolvedValueOnce({ rows: [pendingAgreement] })
        // UPDATE credit_accounts (refund buyer)
        .mockResolvedValueOnce({ rows: [] })
        // SELECT balance for transaction record
        .mockResolvedValueOnce({ rows: [{ balance_credits: "600" }] })
        // INSERT credit_transactions (refund)
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE agreement to cancelled
        .mockResolvedValueOnce({ rows: [cancelledAgreement] })
        // COMMIT
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.cancelAgreement(AGREEMENT_ID, BUYER_AGENT_ID);

      expect(result).toEqual(cancelledAgreement);
      expect(result.status).toBe("cancelled");
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("throws when agreement not found or cannot be cancelled", async () => {
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({ rows: [] })
        // SELECT agreement — empty (not found or wrong status)
        .mockResolvedValueOnce({ rows: [] })
        // ROLLBACK
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.cancelAgreement(AGREEMENT_ID, BUYER_AGENT_ID),
      ).rejects.toThrow("Agreement not found or cannot be cancelled");

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  //  disputeAgreement
  // ----------------------------------------------------------

  describe("disputeAgreement", () => {
    it("happy path: agreement flagged as disputed", async () => {
      const disputed = makeFakeAgreement({
        status: "disputed",
        dispute_reason: "Work not as described",
      });

      mockPool.query.mockResolvedValueOnce({ rows: [disputed] });

      const result = await service.disputeAgreement(
        AGREEMENT_ID,
        BUYER_AGENT_ID,
        "Work not as described",
      );

      expect(result).toEqual(disputed);
      expect(result.status).toBe("disputed");
      expect(result.dispute_reason).toBe("Work not as described");
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE credit_agreements"),
        ["Work not as described", AGREEMENT_ID, BUYER_AGENT_ID],
      );
    });

    it("throws when agreement not found or cannot be disputed", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.disputeAgreement(AGREEMENT_ID, BUYER_AGENT_ID, "Reason"),
      ).rejects.toThrow("Agreement not found or cannot be disputed");
    });
  });

  // ----------------------------------------------------------
  //  getAgreements
  // ----------------------------------------------------------

  describe("getAgreements", () => {
    it("returns agreements filtered by buyer role", async () => {
      const agreements = [makeFakeAgreement()];
      mockPool.query.mockResolvedValueOnce({ rows: agreements });

      const result = await service.getAgreements(BUYER_AGENT_ID, "buyer");

      expect(result).toEqual(agreements);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("buyer_agent_id = $1"),
        [BUYER_AGENT_ID],
      );
    });

    it("returns agreements filtered by provider role", async () => {
      const agreements = [makeFakeAgreement()];
      mockPool.query.mockResolvedValueOnce({ rows: agreements });

      const result = await service.getAgreements(PROVIDER_AGENT_ID, "provider");

      expect(result).toEqual(agreements);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("provider_agent_id = $1"),
        [PROVIDER_AGENT_ID],
      );
    });

    it("returns agreements for both roles when no filter specified", async () => {
      const agreements = [makeFakeAgreement(), makeFakeAgreement({ id: "other-id" })];
      mockPool.query.mockResolvedValueOnce({ rows: agreements });

      const result = await service.getAgreements(BUYER_AGENT_ID);

      expect(result).toHaveLength(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("buyer_agent_id = $1 OR provider_agent_id = $1"),
        [BUYER_AGENT_ID],
      );
    });
  });

  // ----------------------------------------------------------
  //  getAgreementDetail
  // ----------------------------------------------------------

  describe("getAgreementDetail", () => {
    it("returns agreement when found", async () => {
      const agreement = makeFakeAgreement();
      mockPool.query.mockResolvedValueOnce({ rows: [agreement] });

      const result = await service.getAgreementDetail(AGREEMENT_ID);

      expect(result).toEqual(agreement);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM credit_agreements WHERE id = $1"),
        [AGREEMENT_ID],
      );
    });

    it("returns null when not found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getAgreementDetail("nonexistent-id");

      expect(result).toBeNull();
    });
  });
});
