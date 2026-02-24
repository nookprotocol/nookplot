/**
 * Marketplace service — search, enrichment, and reviews for the A2A marketplace.
 *
 * Service listings and agreements are mirrored from on-chain to PostgreSQL
 * for fast, filterable queries. Reviews are stored off-chain only.
 *
 * @module services/marketplaceService
 */

import type pg from "pg";

// ── Row shapes ───────────────────────────────────────────────────

export interface ListingRow {
  id: string;
  listing_id: number;
  agent_id: string;
  provider_address: string;
  category: string;
  pricing_model: string;
  price_amount: string;
  metadata_cid: string;
  active: boolean;
  total_completed: number;
  total_disputed: number;
  on_chain_tx: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgreementRow {
  id: string;
  agreement_id: number;
  listing_id: number;
  buyer_agent_id: string;
  provider_agent_id: string;
  terms_cid: string | null;
  delivery_cid: string | null;
  escrow_amount: string;
  escrow_type: string;
  status: string;
  deadline: string | null;
  on_chain_tx: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface ReviewRow {
  id: string;
  agreement_id: number;
  reviewer_agent_id: string;
  reviewee_agent_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

// ── Input types ──────────────────────────────────────────────────

export interface SearchFilters {
  category?: string;
  minRating?: number;
  maxPrice?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface CacheListingInput {
  listingId: number;
  agentId: string;
  providerAddress: string;
  category: string;
  pricingModel: string;
  priceAmount: string;
  metadataCid: string;
  onChainTx?: string;
}

export interface CacheAgreementInput {
  agreementId: number;
  listingId: number;
  buyerAgentId: string;
  providerAgentId: string;
  termsCid: string;
  escrowAmount: string;
  escrowType: string;
  deadline: string;
  onChainTx?: string;
}

export interface SubmitReviewInput {
  agreementId: number;
  reviewerAgentId: string;
  revieweeAgentId: string;
  rating: number;
  comment?: string;
}

export interface ProviderStats {
  totalListings: number;
  totalCompleted: number;
  totalDisputed: number;
  averageRating: number | null;
  reviewCount: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

// ── Service class ────────────────────────────────────────────────

export class MarketplaceService {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * Search service listings with filters.
   */
  async searchListings(filters: SearchFilters = {}): Promise<ListingRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.activeOnly !== false) {
      conditions.push("sl.active = TRUE");
    }

    if (filters.category) {
      conditions.push(`sl.category = $${paramIndex++}`);
      params.push(filters.category);
    }

    if (filters.maxPrice) {
      conditions.push(`CAST(sl.price_amount AS NUMERIC) <= $${paramIndex++}`);
      params.push(filters.maxPrice);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    params.push(limit);
    params.push(offset);

    const { rows } = await this.pool.query<ListingRow>(
      `SELECT sl.*
       FROM service_listings sl
       ${whereClause}
       ORDER BY sl.total_completed DESC, sl.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params,
    );

    return rows;
  }

  /**
   * Get a single listing by on-chain listing ID.
   */
  async getListingDetail(listingId: number): Promise<ListingRow | null> {
    const { rows } = await this.pool.query<ListingRow>(
      `SELECT * FROM service_listings WHERE listing_id = $1`,
      [listingId],
    );
    return rows[0] ?? null;
  }

  /**
   * Cache a listing from on-chain data into PostgreSQL.
   */
  async cacheListingFromChain(input: CacheListingInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO service_listings
        (listing_id, agent_id, provider_address, category, pricing_model, price_amount, metadata_cid, on_chain_tx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (listing_id) DO UPDATE SET
        category = EXCLUDED.category,
        pricing_model = EXCLUDED.pricing_model,
        price_amount = EXCLUDED.price_amount,
        metadata_cid = EXCLUDED.metadata_cid,
        on_chain_tx = EXCLUDED.on_chain_tx,
        updated_at = NOW()`,
      [
        input.listingId,
        input.agentId,
        input.providerAddress,
        input.category,
        input.pricingModel,
        input.priceAmount,
        input.metadataCid,
        input.onChainTx ?? null,
      ],
    );
  }

  /**
   * Cache an agreement from on-chain data into PostgreSQL.
   */
  async cacheAgreementFromChain(input: CacheAgreementInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO service_agreements
        (agreement_id, listing_id, buyer_agent_id, provider_agent_id, terms_cid, escrow_amount, escrow_type, deadline, on_chain_tx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (agreement_id) DO UPDATE SET
        terms_cid = EXCLUDED.terms_cid,
        escrow_amount = EXCLUDED.escrow_amount,
        on_chain_tx = EXCLUDED.on_chain_tx`,
      [
        input.agreementId,
        input.listingId,
        input.buyerAgentId,
        input.providerAgentId,
        input.termsCid,
        input.escrowAmount,
        input.escrowType,
        input.deadline,
        input.onChainTx ?? null,
      ],
    );
  }

  /**
   * Get provider stats (listings, completions, disputes, rating).
   */
  async getProviderStats(agentId: string): Promise<ProviderStats> {
    const listingRes = await this.pool.query<{
      total_listings: string;
      total_completed: string;
      total_disputed: string;
    }>(
      `SELECT
        COUNT(*) AS total_listings,
        COALESCE(SUM(total_completed), 0) AS total_completed,
        COALESCE(SUM(total_disputed), 0) AS total_disputed
       FROM service_listings
       WHERE agent_id = $1`,
      [agentId],
    );

    const ratingRes = await this.pool.query<{
      avg_rating: string | null;
      review_count: string;
    }>(
      `SELECT
        AVG(rating)::NUMERIC(3,2) AS avg_rating,
        COUNT(*) AS review_count
       FROM service_reviews
       WHERE reviewee_agent_id = $1`,
      [agentId],
    );

    const listing = listingRes.rows[0];
    const rating = ratingRes.rows[0];

    return {
      totalListings: parseInt(listing.total_listings, 10),
      totalCompleted: parseInt(listing.total_completed, 10),
      totalDisputed: parseInt(listing.total_disputed, 10),
      averageRating: rating.avg_rating ? parseFloat(rating.avg_rating) : null,
      reviewCount: parseInt(rating.review_count, 10),
    };
  }

  /**
   * Submit a review for a settled agreement.
   *
   * @throws if the agreement is not settled or already reviewed.
   */
  async submitReview(input: SubmitReviewInput): Promise<ReviewRow> {
    // Validate agreement exists and is settled
    const { rows: agreements } = await this.pool.query<AgreementRow>(
      `SELECT * FROM service_agreements WHERE agreement_id = $1`,
      [input.agreementId],
    );

    if (agreements.length === 0) {
      throw new Error("Agreement not found.");
    }

    const agreement = agreements[0];
    if (agreement.status !== "settled") {
      throw new Error("Can only review settled agreements.");
    }

    // Validate reviewer is a party to the agreement
    if (
      input.reviewerAgentId !== agreement.buyer_agent_id &&
      input.reviewerAgentId !== agreement.provider_agent_id
    ) {
      throw new Error("Reviewer is not a party to this agreement.");
    }

    // Validate rating
    if (input.rating < 1 || input.rating > 5) {
      throw new Error("Rating must be between 1 and 5.");
    }

    // Validate comment length
    if (input.comment && input.comment.length > 2000) {
      throw new Error("Comment must be 2000 characters or fewer.");
    }

    const { rows } = await this.pool.query<ReviewRow>(
      `INSERT INTO service_reviews (agreement_id, reviewer_agent_id, reviewee_agent_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.agreementId, input.reviewerAgentId, input.revieweeAgentId, input.rating, input.comment ?? null],
    );

    return rows[0];
  }

  /**
   * Get reviews for an agent (as reviewee).
   */
  async getReviews(
    agentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<ReviewRow[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM service_reviews
       WHERE reviewee_agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset],
    );

    return rows;
  }

  /**
   * Get featured listings (top by completion rate, active only).
   */
  async getFeaturedListings(limit: number = 10): Promise<ListingRow[]> {
    const { rows } = await this.pool.query<ListingRow>(
      `SELECT * FROM service_listings
       WHERE active = TRUE
       ORDER BY total_completed DESC, total_disputed ASC, created_at DESC
       LIMIT $1`,
      [Math.min(limit, 50)],
    );

    return rows;
  }

  /**
   * Get categories with listing counts.
   */
  async getCategories(): Promise<CategoryCount[]> {
    const { rows } = await this.pool.query<CategoryCount>(
      `SELECT category, COUNT(*)::INTEGER AS count
       FROM service_listings
       WHERE active = TRUE
       GROUP BY category
       ORDER BY count DESC`,
    );

    return rows;
  }

  /**
   * Get agreements for an agent (as buyer or provider).
   */
  async getAgreements(
    agentId: string,
    role: "buyer" | "provider" | "both" = "both",
    options: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<AgreementRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (role === "buyer") {
      conditions.push(`sa.buyer_agent_id = $${paramIndex++}`);
      params.push(agentId);
    } else if (role === "provider") {
      conditions.push(`sa.provider_agent_id = $${paramIndex++}`);
      params.push(agentId);
    } else {
      conditions.push(`(sa.buyer_agent_id = $${paramIndex} OR sa.provider_agent_id = $${paramIndex})`);
      paramIndex++;
      params.push(agentId);
    }

    if (options.status) {
      conditions.push(`sa.status = $${paramIndex++}`);
      params.push(options.status);
    }

    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);
    params.push(limit);
    params.push(offset);

    const { rows } = await this.pool.query<AgreementRow>(
      `SELECT sa.*
       FROM service_agreements sa
       WHERE ${conditions.join(" AND ")}
       ORDER BY sa.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params,
    );

    return rows;
  }

  /**
   * Get a single agreement by on-chain agreement ID.
   */
  async getAgreementDetail(agreementId: number): Promise<AgreementRow | null> {
    const { rows } = await this.pool.query<AgreementRow>(
      `SELECT * FROM service_agreements WHERE agreement_id = $1`,
      [agreementId],
    );
    return rows[0] ?? null;
  }
}
