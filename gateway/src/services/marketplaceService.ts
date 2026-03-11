/**
 * Marketplace service — search, enrichment, and reviews for the A2A marketplace.
 *
 * Service listings and agreements are mirrored from on-chain to PostgreSQL
 * for fast, filterable queries. Reviews are stored off-chain only.
 *
 * @module services/marketplaceService
 */

import type pg from "pg";
import type { MessageBus } from "./messageBus.js";
import { normalizeTags } from "./interestEngine.js";

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

export interface AgreementMessageRow {
  id: string;
  agreement_id: number;
  sender_agent_id: string;
  message_type: string;
  content: string;
  attachment_cid: string | null;
  created_at: string;
}

export interface SendMessageInput {
  agreementId: number;
  senderAgentId: string;
  messageType: "general" | "revision_request" | "revision_response" | "delivery_note" | "dispute_evidence";
  content: string;
  attachmentCid?: string;
}

/** Agreement detail enriched with party addresses for frontend role detection. */
export interface EnrichedAgreementRow extends AgreementRow {
  buyer_address: string;
  provider_address: string;
  buyer_viewed_delivery_at: string | null;
  dispute_reason: string | null;
}

// ── Input types ──────────────────────────────────────────────────

export interface SearchFilters {
  category?: string;
  minRating?: number;
  maxPrice?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
  // GPU-specific filters
  gpuModel?: string;
  minVram?: number;
  maxPriceUsdc?: number;
  attestationMaxAgeDays?: number;
  availabilityStatus?: "online" | "degraded" | "any";
  minChallengePassRate?: number;
  // API-specific filters
  apiStatus?: "online" | "degraded" | "any";
  minUptimePercent?: number;
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
  tags?: string[];
  title?: string;
  tokenAddress?: string;
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
  escrowToken?: string;
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
  private messageBus: MessageBus | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus;
  }

  /**
   * Search service listings with filters.
   */
  async searchListings(filters: SearchFilters = {}): Promise<ListingRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    const hasGpuFilters = !!(filters.gpuModel || filters.minVram || filters.maxPriceUsdc !== undefined ||
      filters.attestationMaxAgeDays || filters.availabilityStatus || filters.minChallengePassRate);
    const hasApiFilters = !!(filters.apiStatus || filters.minUptimePercent);

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

    // GPU-specific filters (join with attestation + availability tables)
    if (filters.gpuModel) {
      conditions.push(`ga.gpu_model ILIKE $${paramIndex++}`);
      params.push(`%${filters.gpuModel}%`);
    }
    if (filters.minVram !== undefined) {
      conditions.push(`ga.vram_gb >= $${paramIndex++}`);
      params.push(filters.minVram);
    }
    if (filters.maxPriceUsdc !== undefined) {
      conditions.push(`CAST(sl.price_amount AS NUMERIC) <= $${paramIndex++}`);
      params.push(filters.maxPriceUsdc);
    }
    if (filters.attestationMaxAgeDays) {
      conditions.push(`ga.attested_at >= NOW() - INTERVAL '1 day' * $${paramIndex++}`);
      params.push(filters.attestationMaxAgeDays);
    }
    if (filters.availabilityStatus && filters.availabilityStatus !== "any") {
      conditions.push(`gv.status = $${paramIndex++}`);
      params.push(filters.availabilityStatus);
    }
    if (filters.minChallengePassRate !== undefined) {
      // Subquery for challenge pass rate
      conditions.push(`(
        SELECT CASE WHEN COUNT(*) = 0 THEN 100
        ELSE (COUNT(*) FILTER (WHERE status = 'completed') * 100.0 / COUNT(*))
        END FROM gpu_challenges gc
        WHERE gc.provider_address = sl.provider_address
      ) >= $${paramIndex++}`);
      params.push(filters.minChallengePassRate);
    }

    // API-specific filters (join with api_availability table)
    if (filters.apiStatus && filters.apiStatus !== "any") {
      conditions.push(`aa.status = $${paramIndex++}`);
      params.push(filters.apiStatus);
    }
    if (filters.minUptimePercent !== undefined) {
      conditions.push(
        `CASE WHEN aa.uptime_checks > 0 THEN (aa.uptime_passes::float / aa.uptime_checks * 100) ELSE 0 END >= $${paramIndex++}`,
      );
      params.push(filters.minUptimePercent);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    params.push(limit);
    params.push(offset);

    // When GPU filters are used, join with attestation and availability tables
    const gpuJoins = hasGpuFilters
      ? `LEFT JOIN idx_gpu_attestations ga ON LOWER(ga.provider_address) = LOWER(sl.provider_address)
         LEFT JOIN gpu_availability gv ON gv.listing_id = sl.listing_id`
      : "";

    // When API filters are used, join with api_availability table
    const apiJoins = hasApiFilters
      ? `LEFT JOIN api_availability aa ON aa.listing_id = sl.listing_id`
      : "";

    const joins = `${gpuJoins} ${apiJoins}`.trim();

    const gpuCols = hasGpuFilters
      ? `, ga.gpu_model AS gpu_model, ga.vram_gb AS gpu_vram_gb,
         ga.compute_capability, ga.cuda_version, ga.attested_at AS gpu_attested_at,
         ga.benchmark_hash, gv.status AS gpu_status, gv.last_heartbeat`
      : "";

    const apiCols = hasApiFilters
      ? `, aa.status AS api_status, aa.last_heartbeat AS api_last_heartbeat,
         aa.uptime_checks AS api_uptime_checks, aa.uptime_passes AS api_uptime_passes,
         aa.last_latency_ms AS api_latency_ms`
      : "";

    const selectCols = `sl.*${gpuCols}${apiCols}`;

    const { rows } = await this.pool.query<ListingRow>(
      `SELECT ${selectCols}
       FROM service_listings sl
       ${joins}
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
    const listingTags = input.tags ? normalizeTags(input.tags) : [];

    await this.pool.query(
      `INSERT INTO service_listings
        (listing_id, agent_id, provider_address, category, pricing_model, price_amount, metadata_cid, on_chain_tx, tags, token_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (listing_id) DO UPDATE SET
        category = EXCLUDED.category,
        pricing_model = EXCLUDED.pricing_model,
        price_amount = EXCLUDED.price_amount,
        metadata_cid = EXCLUDED.metadata_cid,
        on_chain_tx = EXCLUDED.on_chain_tx,
        tags = EXCLUDED.tags,
        token_address = COALESCE(EXCLUDED.token_address, service_listings.token_address),
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
        listingTags,
        input.tokenAddress ?? null,
      ],
    );

    // Emit entity:service_listing event for interest engine matching
    if (this.messageBus) {
      this.messageBus.publish("entity:service_listing", {
        type: "entity.created",
        timestamp: new Date().toISOString(),
        data: {
          entityType: "service_listing",
          entityId: String(input.listingId),
          title: input.title ?? `Service listing #${input.listingId}`,
          tags: listingTags,
          metadata: { category: input.category, pricingModel: input.pricingModel, priceAmount: input.priceAmount },
        },
      });
    }
  }

  /**
   * Cache an agreement from on-chain data into PostgreSQL.
   */
  async cacheAgreementFromChain(input: CacheAgreementInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO service_agreements
        (agreement_id, listing_id, buyer_agent_id, provider_agent_id, terms_cid, escrow_amount, escrow_type, deadline, on_chain_tx, escrow_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (agreement_id) DO UPDATE SET
        terms_cid = EXCLUDED.terms_cid,
        escrow_amount = EXCLUDED.escrow_amount,
        on_chain_tx = EXCLUDED.on_chain_tx,
        escrow_token = COALESCE(EXCLUDED.escrow_token, service_agreements.escrow_token)`,
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
        input.escrowToken ?? null,
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
  ) {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const { rows } = await this.pool.query(
      `SELECT sr.agreement_id AS "agreementId",
              a.address AS reviewer,
              sr.rating,
              sr.comment,
              sr.created_at AS "createdAt"
       FROM service_reviews sr
       JOIN agents a ON a.id = sr.reviewer_agent_id
       WHERE sr.reviewee_agent_id = $1
       ORDER BY sr.created_at DESC
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
   * Get a single agreement by on-chain agreement ID, enriched with party addresses.
   */
  async getAgreementDetail(agreementId: number): Promise<EnrichedAgreementRow | null> {
    const { rows } = await this.pool.query<EnrichedAgreementRow>(
      `SELECT sa.*,
              buyer.address AS buyer_address,
              provider.address AS provider_address
       FROM service_agreements sa
       LEFT JOIN agents buyer ON buyer.id = sa.buyer_agent_id
       LEFT JOIN agents provider ON provider.id = sa.provider_agent_id
       WHERE sa.agreement_id = $1`,
      [agreementId],
    );
    return rows[0] ?? null;
  }

  /**
   * Mark that the buyer has viewed the delivered work (fire-and-forget).
   */
  async markDeliveryViewed(agreementId: number, buyerAgentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE service_agreements
       SET buyer_viewed_delivery_at = NOW()
       WHERE agreement_id = $1
         AND buyer_agent_id = $2
         AND buyer_viewed_delivery_at IS NULL`,
      [agreementId, buyerAgentId],
    );
  }

  // ── Agreement Messages ────────────────────────────────────────

  /**
   * Send a message on an agreement thread.
   * Validates caller is a party and message type is valid for current status.
   */
  async sendMessage(input: SendMessageInput): Promise<AgreementMessageRow> {
    // Fetch agreement to validate
    const { rows: agreements } = await this.pool.query<AgreementRow>(
      `SELECT * FROM service_agreements WHERE agreement_id = $1`,
      [input.agreementId],
    );
    if (agreements.length === 0) {
      throw new Error("Agreement not found.");
    }

    const agreement = agreements[0];

    // Validate caller is a party
    if (
      input.senderAgentId !== agreement.buyer_agent_id &&
      input.senderAgentId !== agreement.provider_agent_id
    ) {
      throw new Error("Not a party to this agreement.");
    }

    const isBuyer = input.senderAgentId === agreement.buyer_agent_id;
    const status = agreement.status;

    // Validate message type constraints per status
    switch (input.messageType) {
      case "revision_request":
        if (!isBuyer) throw new Error("Only the buyer can request revisions.");
        if (status !== "delivered") throw new Error("Revisions can only be requested when work is delivered.");
        break;
      case "revision_response":
        if (isBuyer) throw new Error("Only the provider can respond to revision requests.");
        if (status !== "delivered") throw new Error("Revision responses are only valid when work is delivered.");
        break;
      case "delivery_note":
        if (isBuyer) throw new Error("Only the provider can add delivery notes.");
        if (status !== "delivered") throw new Error("Delivery notes are only valid when work is delivered.");
        break;
      case "dispute_evidence":
        if (status !== "disputed") throw new Error("Evidence can only be submitted for disputed agreements.");
        break;
      case "general":
        if (!["agreed", "delivered", "disputed"].includes(status)) {
          throw new Error("Messages can only be sent on active agreements.");
        }
        break;
      default:
        throw new Error(`Invalid message type: ${input.messageType}`);
    }

    // Validate content length
    if (!input.content || input.content.trim().length === 0) {
      throw new Error("Message content is required.");
    }
    if (input.content.length > 5000) {
      throw new Error("Message must be 5000 characters or fewer.");
    }

    const { rows } = await this.pool.query<AgreementMessageRow>(
      `INSERT INTO agreement_messages (agreement_id, sender_agent_id, message_type, content, attachment_cid)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.agreementId, input.senderAgentId, input.messageType, input.content.trim(), input.attachmentCid ?? null],
    );

    return rows[0];
  }

  /**
   * Get messages for an agreement thread. Caller must be a party.
   */
  async getMessages(
    agreementId: number,
    callerAgentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<AgreementMessageRow[]> {
    // Validate caller is a party
    const { rows: agreements } = await this.pool.query<AgreementRow>(
      `SELECT buyer_agent_id, provider_agent_id FROM service_agreements WHERE agreement_id = $1`,
      [agreementId],
    );
    if (agreements.length === 0) {
      throw new Error("Agreement not found.");
    }
    if (
      callerAgentId !== agreements[0].buyer_agent_id &&
      callerAgentId !== agreements[0].provider_agent_id
    ) {
      throw new Error("Not a party to this agreement.");
    }

    const limit = Math.min(options.limit ?? 100, 500);
    const offset = Math.max(options.offset ?? 0, 0);

    const { rows } = await this.pool.query<AgreementMessageRow>(
      `SELECT * FROM agreement_messages
       WHERE agreement_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [agreementId, limit, offset],
    );

    return rows;
  }
}
