import { describe, it, expect, vi, beforeEach } from "vitest";

// Suppress audit log side-effects
vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

import { MarketplaceService } from "../marketplaceService.js";
import type {
  ListingRow,
  AgreementRow,
  ReviewRow,
  AgreementMessageRow,
} from "../marketplaceService.js";

// ── Mock factories ────────────────────────────────────────────

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockMessageBus() {
  return { publish: vi.fn(), subscribe: vi.fn(), subscribePattern: vi.fn(), unsubscribe: vi.fn(), shutdown: vi.fn() };
}

// ── Test fixtures ─────────────────────────────────────────────

const BUYER_ID = "buyer-agent-uuid";
const PROVIDER_ID = "provider-agent-uuid";
const THIRD_PARTY_ID = "outsider-agent-uuid";

const LISTING_ROW: ListingRow = {
  id: "row-uuid-1",
  listing_id: 42,
  agent_id: PROVIDER_ID,
  provider_address: "0xProviderAddr",
  category: "data-analysis",
  pricing_model: "fixed",
  price_amount: "100",
  metadata_cid: "Qmxxx",
  active: true,
  total_completed: 5,
  total_disputed: 1,
  on_chain_tx: "0xTxHash",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-02T00:00:00.000Z",
};

const AGREEMENT_ROW: AgreementRow = {
  id: "agreement-row-uuid",
  agreement_id: 99,
  listing_id: 42,
  buyer_agent_id: BUYER_ID,
  provider_agent_id: PROVIDER_ID,
  terms_cid: "Qmterms",
  delivery_cid: null,
  escrow_amount: "100",
  escrow_type: "usdc",
  status: "settled",
  deadline: null,
  on_chain_tx: "0xAgreementTx",
  created_at: "2024-01-10T00:00:00.000Z",
  settled_at: "2024-01-15T00:00:00.000Z",
};

const REVIEW_ROW: ReviewRow = {
  id: "review-uuid-1",
  agreement_id: 99,
  reviewer_agent_id: BUYER_ID,
  reviewee_agent_id: PROVIDER_ID,
  rating: 4,
  comment: "Great work!",
  created_at: "2024-01-16T00:00:00.000Z",
};

const MESSAGE_ROW: AgreementMessageRow = {
  id: "msg-uuid-1",
  agreement_id: 99,
  sender_agent_id: BUYER_ID,
  message_type: "general",
  content: "Hello provider!",
  attachment_cid: null,
  created_at: "2024-01-11T00:00:00.000Z",
};

// ── Helpers ───────────────────────────────────────────────────

function makeAgreement(overrides: Partial<AgreementRow> = {}): AgreementRow {
  return { ...AGREEMENT_ROW, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────

describe("MarketplaceService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let service: MarketplaceService;

  beforeEach(() => {
    pool = createMockPool();
    service = new MarketplaceService(pool);
  });

  // ── searchListings ───────────────────────────────────────────

  describe("searchListings", () => {
    it("uses activeOnly=true and default limit/offset when called with no filters", async () => {
      pool.query.mockResolvedValueOnce({ rows: [LISTING_ROW] });

      const result = await service.searchListings();

      expect(result).toEqual([LISTING_ROW]);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("sl.active = TRUE");
      // Default limit = 50, offset = 0
      expect(params).toContain(50);
      expect(params).toContain(0);
    });

    it("includes category condition when category filter is provided", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchListings({ category: "data-analysis" });

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("sl.category = $");
      expect(params).toContain("data-analysis");
    });

    it("clamps limit to 200 when a higher value is passed", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchListings({ limit: 9999 });

      const [, params] = pool.query.mock.calls[0];
      expect(params).toContain(200);
    });

    it("omits the activeOnly condition when activeOnly=false", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.searchListings({ activeOnly: false });

      const [sql] = pool.query.mock.calls[0];
      expect(sql).not.toContain("sl.active = TRUE");
    });
  });

  // ── getListingDetail ─────────────────────────────────────────

  describe("getListingDetail", () => {
    it("returns the listing row when found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [LISTING_ROW] });

      const result = await service.getListingDetail(42);

      expect(result).toEqual(LISTING_ROW);
      const [, params] = pool.query.mock.calls[0];
      expect(params).toEqual([42]);
    });

    it("returns null when the listing does not exist", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getListingDetail(999);

      expect(result).toBeNull();
    });
  });

  // ── cacheListingFromChain ────────────────────────────────────

  describe("cacheListingFromChain", () => {
    it("issues UPSERT with correct positional params", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.cacheListingFromChain({
        listingId: 42,
        agentId: PROVIDER_ID,
        providerAddress: "0xProviderAddr",
        category: "data-analysis",
        pricingModel: "fixed",
        priceAmount: "100",
        metadataCid: "Qmxxx",
        onChainTx: "0xTxHash",
        tags: [],
      });

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("ON CONFLICT (listing_id) DO UPDATE SET");
      expect(params[0]).toBe(42);
      expect(params[1]).toBe(PROVIDER_ID);
      expect(params[2]).toBe("0xProviderAddr");
    });

    it("normalizes tags before persisting (lowercases, deduplicates)", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.cacheListingFromChain({
        listingId: 1,
        agentId: PROVIDER_ID,
        providerAddress: "0xAddr",
        category: "dev",
        pricingModel: "fixed",
        priceAmount: "10",
        metadataCid: "Qm1",
        tags: ["Rust", "RUST", "rust"],
      });

      // normalizeTags deduplicates — only one "rust" should survive
      const [, params] = pool.query.mock.calls[0];
      const tagsParam: string[] = params[8];
      expect(tagsParam.filter((t: string) => t === "rust")).toHaveLength(1);
    });

    it("emits entity:service_listing event when messageBus is set", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const bus = createMockMessageBus();
      service.setMessageBus(bus);

      await service.cacheListingFromChain({
        listingId: 7,
        agentId: PROVIDER_ID,
        providerAddress: "0xAddr",
        category: "dev",
        pricingModel: "fixed",
        priceAmount: "10",
        metadataCid: "Qm7",
        title: "My Service",
      });

      expect(bus.publish).toHaveBeenCalledOnce();
      const [channel, payload] = bus.publish.mock.calls[0];
      expect(channel).toBe("entity:service_listing");
      expect(payload.data.entityId).toBe("7");
      expect(payload.data.title).toBe("My Service");
    });

    it("does NOT emit an event when no messageBus is set", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      // No setMessageBus call — should not throw
      await expect(
        service.cacheListingFromChain({
          listingId: 8,
          agentId: PROVIDER_ID,
          providerAddress: "0xAddr",
          category: "dev",
          pricingModel: "fixed",
          priceAmount: "10",
          metadataCid: "Qm8",
        }),
      ).resolves.toBeUndefined();

      expect(pool.query).toHaveBeenCalledOnce();
    });

    it("stores tokenAddress when provided", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.cacheListingFromChain({
        listingId: 55,
        agentId: PROVIDER_ID,
        providerAddress: "0xAddr",
        category: "dev",
        pricingModel: "fixed",
        priceAmount: "1000",
        metadataCid: "QmNook",
        tokenAddress: "0x2222222222222222222222222222222222222222",
      });

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("token_address");
      expect(params[9]).toBe("0x2222222222222222222222222222222222222222");
    });

    it("passes null for tokenAddress when omitted", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.cacheListingFromChain({
        listingId: 56,
        agentId: PROVIDER_ID,
        providerAddress: "0xAddr",
        category: "dev",
        pricingModel: "fixed",
        priceAmount: "100",
        metadataCid: "QmUsdc",
      });

      const [, params] = pool.query.mock.calls[0];
      expect(params[9]).toBeNull();
    });
  });

  // ── submitReview ─────────────────────────────────────────────

  describe("submitReview", () => {
    it("inserts and returns review row on happy path", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [makeAgreement({ status: "settled" })] })
        .mockResolvedValueOnce({ rows: [REVIEW_ROW] });

      const result = await service.submitReview({
        agreementId: 99,
        reviewerAgentId: BUYER_ID,
        revieweeAgentId: PROVIDER_ID,
        rating: 4,
        comment: "Great work!",
      });

      expect(result).toEqual(REVIEW_ROW);
      const insertCall = pool.query.mock.calls[1];
      expect(insertCall[0]).toContain("INSERT INTO service_reviews");
      expect(insertCall[1]).toEqual([99, BUYER_ID, PROVIDER_ID, 4, "Great work!"]);
    });

    it("throws when agreement status is not settled", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "agreed" })],
      });

      await expect(
        service.submitReview({
          agreementId: 99,
          reviewerAgentId: BUYER_ID,
          revieweeAgentId: PROVIDER_ID,
          rating: 5,
        }),
      ).rejects.toThrow("Can only review settled agreements.");
    });

    it("throws when reviewer is not a party to the agreement", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "settled" })],
      });

      await expect(
        service.submitReview({
          agreementId: 99,
          reviewerAgentId: THIRD_PARTY_ID,
          revieweeAgentId: PROVIDER_ID,
          rating: 3,
        }),
      ).rejects.toThrow("Reviewer is not a party to this agreement.");
    });

    it("throws when rating is below 1", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "settled" })],
      });

      await expect(
        service.submitReview({
          agreementId: 99,
          reviewerAgentId: BUYER_ID,
          revieweeAgentId: PROVIDER_ID,
          rating: 0,
        }),
      ).rejects.toThrow("Rating must be between 1 and 5.");
    });

    it("throws when rating is above 5", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "settled" })],
      });

      await expect(
        service.submitReview({
          agreementId: 99,
          reviewerAgentId: BUYER_ID,
          revieweeAgentId: PROVIDER_ID,
          rating: 6,
        }),
      ).rejects.toThrow("Rating must be between 1 and 5.");
    });

    it("throws when comment exceeds 2000 characters", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "settled" })],
      });

      await expect(
        service.submitReview({
          agreementId: 99,
          reviewerAgentId: BUYER_ID,
          revieweeAgentId: PROVIDER_ID,
          rating: 4,
          comment: "x".repeat(2001),
        }),
      ).rejects.toThrow("Comment must be 2000 characters or fewer.");
    });
  });

  // ── sendMessage ──────────────────────────────────────────────

  describe("sendMessage", () => {
    function mockAgreementThenInsert(agreement: AgreementRow) {
      pool.query
        .mockResolvedValueOnce({ rows: [agreement] })
        .mockResolvedValueOnce({ rows: [MESSAGE_ROW] });
    }

    it("inserts general message on an agreed agreement", async () => {
      mockAgreementThenInsert(makeAgreement({ status: "agreed" }));

      const result = await service.sendMessage({
        agreementId: 99,
        senderAgentId: BUYER_ID,
        messageType: "general",
        content: "Hello provider!",
      });

      expect(result).toEqual(MESSAGE_ROW);
      const insertCall = pool.query.mock.calls[1];
      expect(insertCall[0]).toContain("INSERT INTO agreement_messages");
    });

    it("throws when buyer tries to send revision_request on non-delivered agreement", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "agreed" })],
      });

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: BUYER_ID,
          messageType: "revision_request",
          content: "Please revise.",
        }),
      ).rejects.toThrow("Revisions can only be requested when work is delivered.");
    });

    it("throws when provider tries to send revision_request (buyer-only)", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "delivered" })],
      });

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: PROVIDER_ID,
          messageType: "revision_request",
          content: "I am the provider trying to request a revision.",
        }),
      ).rejects.toThrow("Only the buyer can request revisions.");
    });

    it("allows buyer to send revision_request on delivered agreement", async () => {
      mockAgreementThenInsert(makeAgreement({ status: "delivered" }));

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: BUYER_ID,
          messageType: "revision_request",
          content: "Please revise section 2.",
        }),
      ).resolves.toBeDefined();
    });

    it("throws when buyer tries to send delivery_note (provider-only)", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "delivered" })],
      });

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: BUYER_ID,
          messageType: "delivery_note",
          content: "Here are the files.",
        }),
      ).rejects.toThrow("Only the provider can add delivery notes.");
    });

    it("allows provider to send delivery_note on delivered agreement", async () => {
      mockAgreementThenInsert(makeAgreement({ status: "delivered" }));

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: PROVIDER_ID,
          messageType: "delivery_note",
          content: "Delivery notes here.",
        }),
      ).resolves.toBeDefined();
    });

    it("throws when dispute_evidence is sent on a non-disputed agreement", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "delivered" })],
      });

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: BUYER_ID,
          messageType: "dispute_evidence",
          content: "Here is my evidence.",
        }),
      ).rejects.toThrow("Evidence can only be submitted for disputed agreements.");
    });

    it("allows either party to send dispute_evidence on a disputed agreement", async () => {
      mockAgreementThenInsert(makeAgreement({ status: "disputed" }));

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: BUYER_ID,
          messageType: "dispute_evidence",
          content: "Proof of work screenshot.",
        }),
      ).resolves.toBeDefined();
    });

    it("throws when content is empty", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "agreed" })],
      });

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: BUYER_ID,
          messageType: "general",
          content: "   ",
        }),
      ).rejects.toThrow("Message content is required.");
    });

    it("throws when sender is not a party to the agreement", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeAgreement({ status: "agreed" })],
      });

      await expect(
        service.sendMessage({
          agreementId: 99,
          senderAgentId: THIRD_PARTY_ID,
          messageType: "general",
          content: "Hello!",
        }),
      ).rejects.toThrow("Not a party to this agreement.");
    });
  });

  // ── getMessages ──────────────────────────────────────────────

  describe("getMessages", () => {
    it("returns messages when caller is the buyer", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ buyer_agent_id: BUYER_ID, provider_agent_id: PROVIDER_ID }],
        })
        .mockResolvedValueOnce({ rows: [MESSAGE_ROW] });

      const result = await service.getMessages(99, BUYER_ID);

      expect(result).toEqual([MESSAGE_ROW]);
    });

    it("throws when caller is not a party to the agreement", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ buyer_agent_id: BUYER_ID, provider_agent_id: PROVIDER_ID }],
      });

      await expect(
        service.getMessages(99, THIRD_PARTY_ID),
      ).rejects.toThrow("Not a party to this agreement.");
    });

    it("clamps limit to 500 when a higher value is requested", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ buyer_agent_id: BUYER_ID, provider_agent_id: PROVIDER_ID }],
        })
        .mockResolvedValueOnce({ rows: [] });

      await service.getMessages(99, BUYER_ID, { limit: 9999 });

      const [, params] = pool.query.mock.calls[1];
      expect(params[1]).toBe(500);
    });
  });

  // ── getProviderStats ─────────────────────────────────────────

  describe("getProviderStats", () => {
    it("returns aggregated stats for a provider with reviews", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ total_listings: "3", total_completed: "12", total_disputed: "1" }],
        })
        .mockResolvedValueOnce({
          rows: [{ avg_rating: "4.25", review_count: "8" }],
        });

      const stats = await service.getProviderStats(PROVIDER_ID);

      expect(stats).toEqual({
        totalListings: 3,
        totalCompleted: 12,
        totalDisputed: 1,
        averageRating: 4.25,
        reviewCount: 8,
      });
    });

    it("returns null averageRating when the provider has no reviews", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ total_listings: "1", total_completed: "0", total_disputed: "0" }],
        })
        .mockResolvedValueOnce({
          rows: [{ avg_rating: null, review_count: "0" }],
        });

      const stats = await service.getProviderStats(PROVIDER_ID);

      expect(stats.averageRating).toBeNull();
      expect(stats.reviewCount).toBe(0);
    });
  });

  // ── getAgreements ────────────────────────────────────────────

  describe("getAgreements", () => {
    it("filters by buyer role and settled status", async () => {
      pool.query.mockResolvedValueOnce({ rows: [AGREEMENT_ROW] });

      const result = await service.getAgreements(BUYER_ID, "buyer", { status: "settled" });

      expect(result).toEqual([AGREEMENT_ROW]);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("sa.buyer_agent_id = $");
      expect(sql).toContain("sa.status = $");
      expect(params).toContain(BUYER_ID);
      expect(params).toContain("settled");
    });

    it("uses OR condition for both parties when role is 'both'", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getAgreements(BUYER_ID, "both");

      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain("OR");
      expect(sql).toContain("buyer_agent_id");
      expect(sql).toContain("provider_agent_id");
    });

    it("clamps limit to 200", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getAgreements(BUYER_ID, "buyer", { limit: 9999 });

      const [, params] = pool.query.mock.calls[0];
      expect(params).toContain(200);
    });
  });

  // ── getAgreementDetail ───────────────────────────────────────

  describe("getAgreementDetail", () => {
    it("returns enriched agreement when found", async () => {
      const enriched = {
        ...AGREEMENT_ROW,
        buyer_address: "0xBuyerAddr",
        provider_address: "0xProviderAddr",
        buyer_viewed_delivery_at: null,
        dispute_reason: null,
      };
      pool.query.mockResolvedValueOnce({ rows: [enriched] });

      const result = await service.getAgreementDetail(99);

      expect(result).toEqual(enriched);
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain("LEFT JOIN agents buyer");
      expect(sql).toContain("LEFT JOIN agents provider");
    });

    it("returns null when agreement is not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getAgreementDetail(999);

      expect(result).toBeNull();
    });
  });

  // ── markDeliveryViewed ───────────────────────────────────────

  describe("markDeliveryViewed", () => {
    it("issues UPDATE with agreement id, buyer id, and NULL guard", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.markDeliveryViewed(99, BUYER_ID);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("buyer_viewed_delivery_at = NOW()");
      expect(sql).toContain("buyer_viewed_delivery_at IS NULL");
      expect(params).toEqual([99, BUYER_ID]);
    });
  });

  // ── getFeaturedListings ──────────────────────────────────────

  describe("getFeaturedListings", () => {
    it("returns active listings ordered by completion count, clamped to 50", async () => {
      pool.query.mockResolvedValueOnce({ rows: [LISTING_ROW] });

      const result = await service.getFeaturedListings(200);

      expect(result).toEqual([LISTING_ROW]);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("active = TRUE");
      expect(params[0]).toBe(50); // clamped from 200
    });
  });

  // ── getCategories ────────────────────────────────────────────

  describe("getCategories", () => {
    it("returns category counts from GROUP BY query", async () => {
      const cats = [
        { category: "data-analysis", count: 12 },
        { category: "development", count: 7 },
      ];
      pool.query.mockResolvedValueOnce({ rows: cats });

      const result = await service.getCategories();

      expect(result).toEqual(cats);
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain("GROUP BY category");
      expect(sql).toContain("active = TRUE");
    });
  });

  // ── cacheAgreementFromChain ──────────────────────────────────

  describe("cacheAgreementFromChain", () => {
    it("issues UPSERT with correct positional params", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.cacheAgreementFromChain({
        agreementId: 99,
        listingId: 42,
        buyerAgentId: BUYER_ID,
        providerAgentId: PROVIDER_ID,
        termsCid: "Qmterms",
        escrowAmount: "100",
        escrowType: "usdc",
        deadline: "2024-06-01T00:00:00.000Z",
        onChainTx: "0xAgreementTx",
        escrowToken: "0xTokenAddr",
      });

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("ON CONFLICT (agreement_id) DO UPDATE SET");
      expect(params[0]).toBe(99);
      expect(params[1]).toBe(42);
      expect(params[2]).toBe(BUYER_ID);
      expect(params[3]).toBe(PROVIDER_ID);
      expect(params[9]).toBe("0xTokenAddr");
    });

    it("passes null for optional fields when omitted", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.cacheAgreementFromChain({
        agreementId: 1,
        listingId: 1,
        buyerAgentId: BUYER_ID,
        providerAgentId: PROVIDER_ID,
        termsCid: "Qmterms",
        escrowAmount: "50",
        escrowType: "usdc",
        deadline: "2024-12-01T00:00:00.000Z",
      });

      const [, params] = pool.query.mock.calls[0];
      // onChainTx → null, escrowToken → null
      expect(params[8]).toBeNull();
      expect(params[9]).toBeNull();
    });
  });

  // ── getReviews ───────────────────────────────────────────────

  describe("getReviews", () => {
    it("clamps limit to 200", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getReviews(PROVIDER_ID, { limit: 9999 });

      const [, params] = pool.query.mock.calls[0];
      expect(params[1]).toBe(200);
    });

    it("passes agentId as first param and uses default limit/offset", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getReviews(PROVIDER_ID);

      const [, params] = pool.query.mock.calls[0];
      expect(params[0]).toBe(PROVIDER_ID);
      expect(params[1]).toBe(50); // default
      expect(params[2]).toBe(0);  // default offset
    });
  });
});
