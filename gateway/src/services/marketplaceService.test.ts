import { describe, it, expect, vi } from "vitest";
import { MarketplaceService } from "./marketplaceService.js";
import { createMockPool } from "../test/helpers.js";

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: "ls_1",
    listing_id: 1,
    agent_id: "agt_1",
    provider_address: "0xabc",
    category: "code-review",
    pricing_model: "per-task",
    price_amount: "100",
    metadata_cid: "bafytest",
    active: true,
    total_completed: 10,
    total_disputed: 0,
    on_chain_tx: null,
    created_at: "2025-06-01",
    updated_at: "2025-06-01",
    ...overrides,
  };
}

function makeAgreement(overrides: Record<string, unknown> = {}) {
  return {
    id: "ag_1",
    agreement_id: 1,
    listing_id: 1,
    buyer_agent_id: "agt_buyer",
    provider_agent_id: "agt_provider",
    terms_cid: "bafyterms",
    delivery_cid: null,
    escrow_amount: "500",
    escrow_type: "credit",
    status: "settled",
    deadline: null,
    on_chain_tx: null,
    created_at: "2025-06-01",
    settled_at: "2025-06-02",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  searchListings
// ---------------------------------------------------------------------------

describe("MarketplaceService — searchListings", () => {
  it("returns active listings by default", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeListing()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    const listings = await svc.searchListings();

    expect(listings).toHaveLength(1);
    expect(listings[0].category).toBe("code-review");
  });

  it("filters by category", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new MarketplaceService(pool as any);
    await svc.searchListings({ category: "data-analysis" });

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("category");
  });

  it("limits results to 200 max", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new MarketplaceService(pool as any);
    await svc.searchListings({ limit: 500 });

    const params = pool.query.mock.calls[0][1] as unknown[];
    // limit param should be clamped to 200
    expect(params).toContain(200);
  });
});

// ---------------------------------------------------------------------------
//  getListingDetail
// ---------------------------------------------------------------------------

describe("MarketplaceService — getListingDetail", () => {
  it("returns listing by ID", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeListing()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    const listing = await svc.getListingDetail(1);

    expect(listing).not.toBeNull();
    expect(listing!.listing_id).toBe(1);
  });

  it("returns null when not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new MarketplaceService(pool as any);
    const listing = await svc.getListingDetail(999);

    expect(listing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getProviderStats
// ---------------------------------------------------------------------------

describe("MarketplaceService — getProviderStats", () => {
  it("returns aggregated provider stats", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ total_listings: "5", total_completed: "20", total_disputed: "2" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ avg_rating: "4.50", review_count: "10" }],
      rowCount: 1,
    });

    const svc = new MarketplaceService(pool as any);
    const stats = await svc.getProviderStats("agt_1");

    expect(stats.totalListings).toBe(5);
    expect(stats.totalCompleted).toBe(20);
    expect(stats.totalDisputed).toBe(2);
    expect(stats.averageRating).toBe(4.5);
    expect(stats.reviewCount).toBe(10);
  });

  it("handles null average rating", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ total_listings: "1", total_completed: "0", total_disputed: "0" }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ avg_rating: null, review_count: "0" }],
      rowCount: 1,
    });

    const svc = new MarketplaceService(pool as any);
    const stats = await svc.getProviderStats("agt_1");

    expect(stats.averageRating).toBeNull();
    expect(stats.reviewCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  submitReview
// ---------------------------------------------------------------------------

describe("MarketplaceService — submitReview", () => {
  it("submits review for settled agreement", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeAgreement()], rowCount: 1 }); // agreement lookup
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "rv_1", agreement_id: 1, reviewer_agent_id: "agt_buyer", reviewee_agent_id: "agt_provider", rating: 5, comment: "Great!", created_at: "2025-06-02" }],
      rowCount: 1,
    });

    const svc = new MarketplaceService(pool as any);
    const review = await svc.submitReview({
      agreementId: 1,
      reviewerAgentId: "agt_buyer",
      revieweeAgentId: "agt_provider",
      rating: 5,
      comment: "Great!",
    });

    expect(review.rating).toBe(5);
  });

  it("rejects review for non-settled agreement", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeAgreement({ status: "active" })], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    await expect(svc.submitReview({
      agreementId: 1,
      reviewerAgentId: "agt_buyer",
      revieweeAgentId: "agt_provider",
      rating: 5,
    })).rejects.toThrow("Can only review settled agreements");
  });

  it("rejects review from non-party", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeAgreement()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    await expect(svc.submitReview({
      agreementId: 1,
      reviewerAgentId: "agt_outsider",
      revieweeAgentId: "agt_provider",
      rating: 5,
    })).rejects.toThrow("not a party");
  });

  it("rejects invalid rating", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeAgreement()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    await expect(svc.submitReview({
      agreementId: 1,
      reviewerAgentId: "agt_buyer",
      revieweeAgentId: "agt_provider",
      rating: 6,
    })).rejects.toThrow("Rating must be between 1 and 5");
  });

  it("rejects oversized comment", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeAgreement()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    await expect(svc.submitReview({
      agreementId: 1,
      reviewerAgentId: "agt_buyer",
      revieweeAgentId: "agt_provider",
      rating: 4,
      comment: "x".repeat(2001),
    })).rejects.toThrow("2000 characters or fewer");
  });

  it("rejects review for missing agreement", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new MarketplaceService(pool as any);
    await expect(svc.submitReview({
      agreementId: 999,
      reviewerAgentId: "agt_buyer",
      revieweeAgentId: "agt_provider",
      rating: 5,
    })).rejects.toThrow("Agreement not found");
  });
});

// ---------------------------------------------------------------------------
//  getFeaturedListings / getCategories
// ---------------------------------------------------------------------------

describe("MarketplaceService — getFeaturedListings", () => {
  it("returns featured listings capped at 50", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeListing()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    const listings = await svc.getFeaturedListings(100);

    // Should clamp to 50
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(50);
  });
});

describe("MarketplaceService — getCategories", () => {
  it("returns category counts", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { category: "code-review", count: 15 },
        { category: "data-analysis", count: 8 },
      ],
      rowCount: 2,
    });

    const svc = new MarketplaceService(pool as any);
    const cats = await svc.getCategories();

    expect(cats).toHaveLength(2);
    expect(cats[0].category).toBe("code-review");
  });
});

// ---------------------------------------------------------------------------
//  getAgreements
// ---------------------------------------------------------------------------

describe("MarketplaceService — getAgreements", () => {
  it("filters by buyer role", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeAgreement()], rowCount: 1 });

    const svc = new MarketplaceService(pool as any);
    const agreements = await svc.getAgreements("agt_buyer", "buyer");

    expect(agreements).toHaveLength(1);
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("buyer_agent_id");
  });

  it("filters by provider role", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new MarketplaceService(pool as any);
    await svc.getAgreements("agt_provider", "provider");

    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("provider_agent_id");
  });
});
