/**
 * ACP (Agent Commerce Protocol) adapter service.
 *
 * Thin adapter mapping Virtuals ACP phases → Nookplot constructs:
 *   Capability advertisement → Agent skills + marketplace listings
 *   Request → intentService.createIntent()
 *   Negotiate → intentService.createProposal()
 *   Transaction → intentService.acceptProposal()
 *   Evaluate → Quality scoring + marketplace review
 *
 * @module services/acpService
 */

import type pg from "pg";
import type { IntentService, IntentRow, ProposalRow } from "./intentService.js";
import type { MarketplaceService } from "./marketplaceService.js";

/* ---------- ACP types ---------- */

export interface AcpCapability {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  pricing?: { amount: number; currency: string };
}

export interface AcpServiceDescriptor {
  protocol: "acp";
  version: "1.0";
  name: string;
  description: string;
  baseUrl: string;
  capabilities: string;     // URL path to capabilities endpoint
  endpoints: {
    capabilities: string;
    request: string;
    negotiate: string;
    execute: string;
    evaluate: string;
  };
}

/* ---------- Service ---------- */

export class AcpService {
  private readonly pool: pg.Pool;
  private readonly intentService: IntentService;
  private readonly marketplaceService: MarketplaceService | null;

  constructor(
    pool: pg.Pool,
    intentService: IntentService,
    marketplaceService: MarketplaceService | null = null,
  ) {
    this.pool = pool;
    this.intentService = intentService;
    this.marketplaceService = marketplaceService;
  }

  /* ---- Service descriptor ---- */

  getServiceDescriptor(gatewayUrl: string): AcpServiceDescriptor {
    return {
      protocol: "acp",
      version: "1.0",
      name: "Nookplot",
      description: "Decentralized agent coordination protocol — identity, reputation, communication, collaboration, and economic settlement",
      baseUrl: gatewayUrl,
      capabilities: "/v1/acp/capabilities",
      endpoints: {
        capabilities: "/v1/acp/capabilities",
        request: "/v1/acp/requests",
        negotiate: "/v1/acp/requests/:id/negotiate",
        execute: "/v1/acp/requests/:id/execute",
        evaluate: "/v1/acp/requests/:id/evaluate",
      },
    };
  }

  /* ---- Capability listing ---- */

  async getCapabilities(category?: string, limit = 50): Promise<AcpCapability[]> {
    const capabilities: AcpCapability[] = [];

    // Pull from marketplace service listings
    if (this.marketplaceService) {
      try {
        const listings = await this.marketplaceService.searchListings({
          category: category || undefined,
          activeOnly: true,
          limit: Math.min(limit, 100),
        });
        for (const listing of listings) {
          capabilities.push({
            id: `listing-${listing.id}`,
            name: `listing-${listing.listing_id}`,
            description: listing.metadata_cid ?? "",
            category: listing.category ?? "general",
            provider: listing.provider_address,
            pricing: listing.price_amount
              ? { amount: parseInt(String(listing.price_amount), 10) / 100, currency: "credits" }
              : undefined,
          });
        }
      } catch {
        // Marketplace listings are optional
      }
    }

    // Pull from agent expertise
    const { rows: agents } = await this.pool.query<{
      address: string;
      display_name: string | null;
      expertise: string[];
    }>(
      `SELECT address, display_name, expertise
       FROM agents
       WHERE expertise IS NOT NULL AND array_length(expertise, 1) > 0
       ORDER BY RANDOM()
       LIMIT $1`,
      [Math.min(limit - capabilities.length, 50)],
    );

    for (const agent of agents) {
      for (const skill of agent.expertise) {
        capabilities.push({
          id: `agent-skill-${agent.address}-${skill}`,
          name: skill,
          description: `${agent.display_name ?? agent.address} specializes in ${skill}`,
          category: "agent-skill",
          provider: agent.address,
        });
      }
    }

    return capabilities.slice(0, limit);
  }

  /* ---- Request (creates intent) ---- */

  async createRequest(
    creatorId: string,
    creatorAddress: string,
    body: { title: string; description: string; category?: string; budget?: number; skills?: string[] },
  ): Promise<IntentRow> {
    return this.intentService.createIntent({
      creatorId,
      creatorAddress,
      title: body.title,
      description: body.description,
      category: body.category,
      budgetAmount: body.budget,
      requiredSkills: body.skills,
      metadata: { source: "acp" },
    });
  }

  /* ---- Negotiate (creates proposal) ---- */

  async negotiate(
    intentId: string,
    proposerId: string,
    proposerAddress: string,
    body: { description: string; approach?: string; estimatedCost?: number; estimatedDuration?: number },
  ): Promise<ProposalRow> {
    return this.intentService.createProposal({
      intentId,
      proposerId,
      proposerAddress,
      description: body.description,
      approach: body.approach,
      estimatedCost: body.estimatedCost,
      estimatedDurationHours: body.estimatedDuration,
      metadata: { source: "acp" },
    });
  }

  /* ---- Execute (accepts proposal) ---- */

  async execute(
    intentId: string,
    creatorId: string,
    proposalId: string,
  ): Promise<{ intent: IntentRow; proposal: ProposalRow }> {
    return this.intentService.acceptProposal(intentId, proposalId, creatorId);
  }

  /* ---- Evaluate (stores review) ---- */

  async evaluate(
    intentId: string,
    reviewerId: string,
    body: { rating: number; comment?: string },
  ): Promise<{ success: boolean }> {
    const intent = await this.intentService.getIntent(intentId);
    if (!intent) throw new Error("Intent not found");

    // Store the evaluation as intent metadata
    await this.pool.query(
      `UPDATE intents SET metadata = jsonb_set(
         COALESCE(metadata, '{}'),
         '{evaluation}',
         $1::jsonb
       ), updated_at = NOW()
       WHERE id = $2`,
      [
        JSON.stringify({
          reviewerId,
          rating: Math.min(Math.max(body.rating, 1), 5),
          comment: body.comment ?? null,
          evaluatedAt: new Date().toISOString(),
        }),
        intentId,
      ],
    );

    return { success: true };
  }
}
