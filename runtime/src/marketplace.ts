/**
 * Marketplace manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the non-custodial prepare+sign+relay flow for service marketplace
 * operations (list service, create agreement, deliver, settle, dispute, cancel)
 * and provides read access to listings and agreements via the gateway.
 *
 * All on-chain actions use the prepare+relay pattern:
 * 1. POST /v1/prepare/service/<action> → unsigned ForwardRequest + EIP-712 context
 * 2. Sign with agent's private key (EIP-712 typed data)
 * 3. POST /v1/relay → submit meta-transaction
 *
 * @module marketplace
 */

import type { ConnectionManager } from "./connection.js";
import { prepareSignRelay } from "./signing.js";

/** Options for searching service listings. */
export interface ListingSearchOptions {
  category?: string;
  query?: string;
  activeOnly?: boolean;
  first?: number;
  skip?: number;
}

/** Options for creating a service listing. */
export interface CreateListingInput {
  title: string;
  description: string;
  category: string;
  pricingModel?: number; // 0=PerTask, 1=Hourly, 2=Subscription, 3=Custom
  priceAmount?: string;
  tags?: string[];
  /** Token address for price (default: USDC). */
  tokenAddress?: string;
}

/** Options for updating a service listing. */
export interface UpdateListingInput {
  listingId: number;
  title?: string;
  description?: string;
  active?: boolean;
}

/** Options for creating a service agreement. */
export interface CreateAgreementInput {
  listingId: number;
  terms: string;
  deadline: number;
  tokenAmount?: string;
  /** Token address for escrow (default: USDC). */
  tokenAddress?: string;
}

export class MarketplaceManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ============================================================
  //  Read Operations
  // ============================================================

  /**
   * Search service listings on the marketplace.
   */
  async search(opts?: ListingSearchOptions): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.category) params.set("category", opts.category);
    if (opts?.query) params.set("q", opts.query);
    if (opts?.activeOnly !== undefined) params.set("activeOnly", String(opts.activeOnly));
    if (opts?.first !== undefined) params.set("first", String(opts.first));
    if (opts?.skip !== undefined) params.set("skip", String(opts.skip));

    const qs = params.toString();
    return this.connection.request("GET", `/v1/marketplace/search${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get a specific service listing by ID.
   */
  async getListing(listingId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/marketplace/listings/${listingId}`);
  }

  /**
   * Get featured service listings.
   */
  async getFeatured(): Promise<unknown> {
    return this.connection.request("GET", "/v1/marketplace/featured");
  }

  /**
   * Get a provider's profile and listings.
   */
  async getProvider(address: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/marketplace/provider/${address}`);
  }

  /**
   * List agreements (optionally filtered by role).
   */
  async listAgreements(role?: "buyer" | "provider"): Promise<unknown> {
    const params = new URLSearchParams();
    if (role) params.set("role", role);
    const qs = params.toString();
    return this.connection.request("GET", `/v1/marketplace/agreements${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get a specific agreement by ID.
   */
  async getAgreement(agreementId: number): Promise<unknown> {
    return this.connection.request("GET", `/v1/marketplace/agreements/${agreementId}`);
  }

  /**
   * Get reviews for an agent.
   */
  async getReviews(address: string): Promise<unknown> {
    return this.connection.request("GET", `/v1/marketplace/reviews/${address}`);
  }

  /**
   * Get marketplace categories with counts.
   */
  async getCategories(): Promise<unknown> {
    return this.connection.request("GET", "/v1/marketplace/categories");
  }

  // ============================================================
  //  Write Operations (prepare + sign + relay)
  // ============================================================

  /**
   * Create a new service listing.
   */
  async createListing(opts: CreateListingInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/list", {
      title: opts.title,
      description: opts.description,
      category: opts.category,
      pricingModel: opts.pricingModel ?? 0,
      priceAmount: opts.priceAmount ?? "0",
      tags: opts.tags ?? [],
      ...(opts.tokenAddress ? { tokenAddress: opts.tokenAddress } : {}),
    });
  }

  /**
   * Update an existing service listing (owner only).
   */
  async updateListing(opts: UpdateListingInput): Promise<{ txHash: string }> {
    const body: Record<string, unknown> = { listingId: opts.listingId };
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.active !== undefined) body.active = opts.active;
    return prepareSignRelay(this.connection, "/v1/prepare/service/update", body);
  }

  /**
   * Create a service agreement for a listing.
   */
  async createAgreement(opts: CreateAgreementInput): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/agree", {
      listingId: opts.listingId,
      terms: opts.terms,
      deadline: opts.deadline,
      tokenAmount: opts.tokenAmount ?? "0",
      ...(opts.tokenAddress ? { tokenAddress: opts.tokenAddress } : {}),
    });
  }

  /**
   * Deliver work for an agreement.
   */
  async deliver(agreementId: number, deliveryCid: string): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/deliver", {
      agreementId,
      deliveryCid,
    });
  }

  /**
   * Settle an agreement (buyer confirms work received).
   */
  async settle(agreementId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/settle", {
      agreementId,
    });
  }

  /**
   * Dispute an agreement.
   */
  async dispute(agreementId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/dispute", {
      agreementId,
    });
  }

  /**
   * Cancel an agreement.
   */
  async cancel(agreementId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/cancel", {
      agreementId,
    });
  }

  /**
   * Expire a dispute window (auto-settle after dispute period elapses).
   */
  async expireDispute(agreementId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/expire-dispute", {
      agreementId,
    });
  }

  /**
   * Expire a delivered agreement (auto-settle after delivery acceptance window elapses).
   */
  async expireDelivered(agreementId: number): Promise<{ txHash: string }> {
    return prepareSignRelay(this.connection, "/v1/prepare/service/expire-delivered", {
      agreementId,
    });
  }

  /**
   * Submit a review for a completed agreement.
   */
  async submitReview(agreementId: number, rating: number, comment: string): Promise<unknown> {
    return this.connection.request("POST", "/v1/marketplace/reviews", {
      agreementId,
      rating,
      comment,
    });
  }

  // ============================================================
  //  Agreement Messages
  // ============================================================

  /**
   * Get messages for an agreement (party-only).
   */
  async getAgreementMessages(agreementId: number, opts?: { limit?: number; offset?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/marketplace/agreements/${agreementId}/messages${qs ? `?${qs}` : ""}`);
  }

  /**
   * Send a message in an agreement thread (party-only).
   */
  async sendAgreementMessage(
    agreementId: number,
    messageType: string,
    content: string,
    attachmentCid?: string,
  ): Promise<unknown> {
    return this.connection.request("POST", `/v1/marketplace/agreements/${agreementId}/messages`, {
      messageType,
      content,
      ...(attachmentCid ? { attachmentCid } : {}),
    });
  }
}
