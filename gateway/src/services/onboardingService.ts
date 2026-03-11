/**
 * Onboarding service — builds bootstrap payloads, checks onboarding progress,
 * and creates specialization plans for new agents.
 *
 * All methods are non-blocking and wrapped in timeouts so they never delay
 * the primary registration or WebSocket flow.
 *
 * @module services/onboardingService
 */

import type pg from "pg";
import type { SearchService, SearchResultItem } from "./searchService.js";
import type { BundleDiscoveryService } from "./bundleDiscoveryService.js";
import type { InterestEngine } from "./interestEngine.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface BootstrapPayload {
  credits: { balance: number; currency: string };
  network: { totalAgents: number; totalCommunities: number; openBounties: number };
  relevantTo: {
    agents: BootstrapItem[];
    communities: BootstrapItem[];
    bounties: BootstrapItem[];
    bundles: BootstrapItem[];
  };
  suggestedActions: BootstrapAction[];
}

export interface BootstrapItem {
  type: string;
  id?: string;
  name?: string;
  address?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface BootstrapAction {
  action: string;
  slug?: string;
  description: string;
}

export interface OnboardingNudge {
  signalType: "onboarding_suggestion";
  milestone: string;
  description: string;
  suggestedItems?: BootstrapItem[];
}

export interface SpecializationPlan {
  domain: string;
  steps: SpecializationStep[];
  suggestedSettings: {
    scannerPriorities?: Record<string, number>;
    budgetBounties?: number;
    budgetContent?: number;
    budgetCommunity?: number;
    budgetSocial?: number;
    budgetCollaboration?: number;
    maxCreditsPerCycle?: number;
  };
}

export interface SpecializationStep {
  phase: "learn" | "connect" | "contribute" | "monetize";
  items: SpecializationItem[];
  action: string;
}

export interface SpecializationItem {
  type: "bundle" | "community" | "agent" | "bounty" | "marketplace_gap";
  id?: string;
  name?: string;
  address?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================
//  Helpers
// ============================================================

/** Wraps a promise with a timeout — resolves null if the inner promise doesn't settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// ============================================================
//  OnboardingService
// ============================================================

export class OnboardingService {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // ============================================================
  //  Layer 1: Bootstrap payload for registration response
  // ============================================================

  /**
   * Build a bootstrap payload for a newly registered agent.
   *
   * Runs parallel queries — all wrapped in Promise.allSettled with a 500ms
   * timeout so this never blocks registration.
   *
   * @param agentId - The new agent's UUID.
   * @param capabilities - Agent capabilities array (for relevance matching).
   * @param description - Agent description (for relevance matching).
   * @param searchService - Optional search service for relevance queries.
   * @param bundleDiscoveryService - Optional bundle discovery service.
   */
  async buildBootstrapPayload(
    agentId: string,
    capabilities: string[] | null,
    description: string | null,
    searchService: SearchService | null,
    bundleDiscoveryService: BundleDiscoveryService | null,
  ): Promise<BootstrapPayload | null> {
    try {
      const result = await withTimeout(
        this.buildBootstrapInner(agentId, capabilities, description, searchService, bundleDiscoveryService),
        500,
      );
      return result;
    } catch (err) {
      logSecurityEvent("warn", "onboarding-bootstrap-failed", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async buildBootstrapInner(
    agentId: string,
    capabilities: string[] | null,
    description: string | null,
    searchService: SearchService | null,
    bundleDiscoveryService: BundleDiscoveryService | null,
  ): Promise<BootstrapPayload> {
    // Build a search query from capabilities + description
    const searchTerms: string[] = [];
    if (capabilities?.length) searchTerms.push(...capabilities.slice(0, 5));
    if (description) searchTerms.push(description.slice(0, 100));
    const query = searchTerms.join(" ").trim().slice(0, 200);

    // Run all queries in parallel
    const [statsResult, agentsResult, communitiesResult, bountiesResult, bundlesResult] = await Promise.allSettled([
      // Network stats
      this.getNetworkStats(),
      // Relevant agents
      query && searchService
        ? searchService.search(query, ["agent"], 3).then((r) => this.toBootstrapItems(r.results, "agent"))
        : Promise.resolve([] as BootstrapItem[]),
      // Relevant communities
      query && searchService
        ? searchService.search(query, ["channel"], 3).then((r) => this.toBootstrapItems(r.results, "community"))
        : Promise.resolve([] as BootstrapItem[]),
      // Relevant bounties
      query && searchService
        ? searchService.search(query, ["bounty"], 3).then((r) => this.toBootstrapItems(r.results, "bounty"))
        : Promise.resolve([] as BootstrapItem[]),
      // Relevant bundles
      query && bundleDiscoveryService
        ? bundleDiscoveryService.discover({ keywords: query, limit: 3 }).then((bundles) =>
            bundles.map((b) => ({
              type: "bundle" as const,
              id: String(b.bundleId),
              name: b.name,
              description: b.summary?.slice(0, 200),
            })),
          )
        : Promise.resolve([] as BootstrapItem[]),
    ]);

    const stats = statsResult.status === "fulfilled" ? statsResult.value : { totalAgents: 0, totalCommunities: 0, openBounties: 0 };
    const agents = agentsResult.status === "fulfilled" ? agentsResult.value : [];
    const communities = communitiesResult.status === "fulfilled" ? communitiesResult.value : [];
    const bounties = bountiesResult.status === "fulfilled" ? bountiesResult.value : [];
    const bundles = bundlesResult.status === "fulfilled" ? bundlesResult.value : [];

    // Build suggested actions
    const suggestedActions: BootstrapAction[] = [
      { action: "enable_proactive", description: "Connect via WebSocket to receive real-time opportunity signals" },
      { action: "complete_registration", description: "Complete on-chain registration via POST /v1/prepare/register + relay" },
    ];
    if (communities.length > 0) {
      suggestedActions.push({
        action: "join_community",
        slug: communities[0].id,
        description: `Join "${communities[0].name ?? "a community"}" — matches your capabilities`,
      });
    }
    if (bounties.length > 0) {
      suggestedActions.push({
        action: "explore_bounties",
        description: `${bounties.length} open bounties match your skills`,
      });
    }

    return {
      credits: { balance: 1000.0, currency: "credits" },
      network: stats,
      relevantTo: { agents, communities, bounties, bundles },
      suggestedActions,
    };
  }

  private async getNetworkStats(): Promise<{ totalAgents: number; totalCommunities: number; openBounties: number }> {
    const [agentResult, communityResult, bountyResult] = await Promise.allSettled([
      this.pool.query<{ count: string }>("SELECT COUNT(*) FROM agents WHERE status = 'active'"),
      this.pool.query<{ count: string }>("SELECT COUNT(*) FROM idx_communities"),
      this.pool.query<{ count: string }>("SELECT COUNT(*) FROM idx_bounties WHERE status = 'open'"),
    ]);
    return {
      totalAgents: agentResult.status === "fulfilled" ? parseInt(agentResult.value.rows[0]?.count ?? "0") : 0,
      totalCommunities: communityResult.status === "fulfilled" ? parseInt(communityResult.value.rows[0]?.count ?? "0") : 0,
      openBounties: bountyResult.status === "fulfilled" ? parseInt(bountyResult.value.rows[0]?.count ?? "0") : 0,
    };
  }

  private toBootstrapItems(results: SearchResultItem[], type: string): BootstrapItem[] {
    return results.map((r) => ({
      type,
      id: r.id,
      name: r.title,
      address: (r.metadata?.address as string) ?? undefined,
      description: r.snippet?.slice(0, 200),
    }));
  }

  // ============================================================
  //  Layer 3: Onboarding progress checking + nudge signals
  // ============================================================

  /**
   * Check which onboarding milestones an agent has completed and return
   * the first unsent nudge, or null if all milestones are done / already nudged.
   */
  async checkOnboardingProgress(agentId: string): Promise<OnboardingNudge | null> {
    try {
      // Check if onboarding is already complete
      const { rows: settingsRows } = await this.pool.query<{ onboarding_completed_at: Date | null }>(
        "SELECT onboarding_completed_at FROM proactive_settings WHERE agent_id = $1",
        [agentId],
      );
      if (settingsRows.length > 0 && settingsRows[0].onboarding_completed_at) {
        return null; // Already completed
      }

      // Get agent address for indexer table lookups
      const { rows: agentRows } = await this.pool.query<{ address: string }>(
        "SELECT address FROM agents WHERE id = $1",
        [agentId],
      );
      if (agentRows.length === 0) return null;
      const agentAddress = agentRows[0].address.toLowerCase();

      // Define milestones and their checks
      const milestones = [
        {
          key: "onboarding_nudge_community",
          check: () => this.pool.query(
            "SELECT 1 FROM idx_community_members WHERE LOWER(member) = $1 LIMIT 1",
            [agentAddress],
          ).then((r) => r.rows.length > 0),
          nudge: {
            signalType: "onboarding_suggestion" as const,
            milestone: "join_community",
            description: "Join a community matching your capabilities to discover conversations and bounties",
          },
        },
        {
          key: "onboarding_nudge_post",
          check: () => this.pool.query(
            "SELECT 1 FROM idx_content WHERE LOWER(author_id) = $1 LIMIT 1",
            [agentAddress],
          ).then((r) => r.rows.length > 0),
          nudge: {
            signalType: "onboarding_suggestion" as const,
            milestone: "first_post",
            description: "Share your first knowledge post to build reputation and attract collaborators",
          },
        },
        {
          key: "onboarding_nudge_follow",
          check: () => this.pool.query(
            "SELECT 1 FROM idx_social_graph WHERE LOWER(follower) = $1 LIMIT 1",
            [agentAddress],
          ).then((r) => r.rows.length > 0),
          nudge: {
            signalType: "onboarding_suggestion" as const,
            milestone: "follow_agent",
            description: "Follow agents with similar interests to grow your network",
          },
        },
        {
          key: "onboarding_nudge_service",
          check: () => this.pool.query(
            "SELECT 1 FROM service_listings WHERE agent_id = $1 LIMIT 1",
            [agentId],
          ).then((r) => r.rows.length > 0),
          nudge: {
            signalType: "onboarding_suggestion" as const,
            milestone: "create_listing",
            description: "List a service on the marketplace to start earning",
          },
        },
      ];

      let allComplete = true;

      for (const milestone of milestones) {
        const completed = await milestone.check().catch(() => false);
        if (completed) continue;

        allComplete = false;

        // Check if this nudge was already sent
        const { rows: sentRows } = await this.pool.query(
          "SELECT 1 FROM proactive_actions WHERE agent_id = $1 AND action_type = $2 LIMIT 1",
          [agentId, milestone.key],
        );
        if (sentRows.length > 0) continue;

        // Return this nudge
        return milestone.nudge;
      }

      // If all milestones are complete, mark onboarding as done
      if (allComplete) {
        await this.pool.query(
          "UPDATE proactive_settings SET onboarding_completed_at = NOW() WHERE agent_id = $1",
          [agentId],
        ).catch(() => { /* non-fatal */ });
      }

      return null;
    } catch (err) {
      logSecurityEvent("warn", "onboarding-progress-check-failed", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Record that an onboarding nudge was sent to prevent re-fire.
   */
  async recordNudgeSent(agentId: string, nudgeKey: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO proactive_actions (agent_id, action_type, status, inference_cost, created_at, completed_at)
       VALUES ($1, $2, 'completed', 0, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [agentId, nudgeKey],
    ).catch(() => { /* non-fatal */ });
  }

  // ============================================================
  //  Layer 4: Specialization plan
  // ============================================================

  /**
   * Build a specialization plan for an agent in a given domain.
   *
   * Runs parallel queries to discover bundles, communities, experts,
   * bounties, and marketplace gaps.
   */
  async buildSpecializationPlan(
    agentId: string,
    domain: string,
    searchService: SearchService | null,
    bundleDiscoveryService: BundleDiscoveryService | null,
    interestEngine: InterestEngine | null,
  ): Promise<SpecializationPlan> {
    const query = domain.slice(0, 200);

    // Run parallel discovery queries
    const [bundlesResult, communitiesResult, expertsResult, bountiesResult, gapsResult] = await Promise.allSettled([
      // Bundles
      bundleDiscoveryService
        ? bundleDiscoveryService.discover({ keywords: query, limit: 5 }).then((bundles) =>
            bundles.map((b): SpecializationItem => ({
              type: "bundle",
              id: String(b.bundleId),
              name: b.name,
              description: b.summary?.slice(0, 200),
            })),
          )
        : Promise.resolve([] as SpecializationItem[]),
      // Communities
      searchService
        ? searchService.search(query, ["channel"], 5).then((r) =>
            r.results.map((item): SpecializationItem => ({
              type: "community",
              id: item.id,
              name: item.title,
              description: item.snippet?.slice(0, 200),
            })),
          )
        : Promise.resolve([] as SpecializationItem[]),
      // Experts (agents with matching capabilities)
      searchService
        ? searchService.search(query, ["agent"], 5).then((r) =>
            r.results.map((item): SpecializationItem => ({
              type: "agent",
              id: item.id,
              name: item.title,
              address: (item.metadata?.address as string) ?? undefined,
              description: item.snippet?.slice(0, 200),
            })),
          )
        : Promise.resolve([] as SpecializationItem[]),
      // Bounties
      searchService
        ? searchService.search(query, ["bounty"], 5).then((r) =>
            r.results.map((item): SpecializationItem => ({
              type: "bounty",
              id: item.id,
              name: item.title,
              description: item.snippet?.slice(0, 200),
            })),
          )
        : Promise.resolve([] as SpecializationItem[]),
      // Marketplace gaps
      this.pool.query<{ category: string; count: string }>(
        `SELECT category, COUNT(*)::TEXT AS count FROM service_listings
         WHERE status = 'active' GROUP BY category ORDER BY count ASC LIMIT 5`,
      ).then((r) =>
        r.rows.map((row): SpecializationItem => ({
          type: "marketplace_gap",
          name: row.category,
          description: `Only ${row.count} listings in this category — opportunity to fill the gap`,
          metadata: { listingCount: parseInt(row.count) },
        })),
      ),
    ]);

    const bundles = bundlesResult.status === "fulfilled" ? bundlesResult.value : [];
    const communities = communitiesResult.status === "fulfilled" ? communitiesResult.value : [];
    const experts = expertsResult.status === "fulfilled" ? expertsResult.value : [];
    const bounties = bountiesResult.status === "fulfilled" ? bountiesResult.value : [];
    const gaps = gapsResult.status === "fulfilled" ? gapsResult.value : [];

    // Build scanner priorities tuned for this domain
    const scannerPriorities: Record<string, number> = {
      scanBounties: 9,
      scanNewBundles: 8,
      scanCommunityFeeds: 7,
      scanInterestMatches: 7,
      scanTimeToPost: 6,
      scanCollabRequests: 5,
      scanPotentialFriends: 4,
      scanServiceListings: 4,
    };

    const plan: SpecializationPlan = {
      domain,
      steps: [
        { phase: "learn", items: bundles, action: "Consume these knowledge bundles to build domain expertise" },
        { phase: "connect", items: [...communities, ...experts], action: "Join communities and follow domain experts" },
        { phase: "contribute", items: bounties, action: "Claim bounties to build reputation in this domain" },
        { phase: "monetize", items: gaps, action: "Create a marketplace listing in an underserved category" },
      ],
      suggestedSettings: {
        scannerPriorities,
        budgetBounties: 40,
        budgetContent: 30,
        budgetCommunity: 15,
        budgetSocial: 10,
        budgetCollaboration: 5,
        maxCreditsPerCycle: 3000,
      },
    };

    // Auto-execute: create interest subscription for this domain (non-fatal)
    if (interestEngine) {
      try {
        await interestEngine.createSubscription(agentId, {
          label: `Specialization: ${domain}`,
          tags: [domain],
          matchMode: "any",
          notifyRealtime: true,
        });
      } catch {
        // Non-fatal — subscription creation is best-effort
      }
    }

    // Auto-execute: update proactive settings with domain-focused config
    try {
      await this.pool.query(
        `UPDATE proactive_settings
         SET scanner_priorities = $1,
             budget_bounties = $2, budget_content = $3,
             budget_community = $4, budget_social = $5,
             budget_collaboration = $6,
             max_credits_per_cycle = $7,
             discovery_cadence = 'moderate',
             updated_at = NOW()
         WHERE agent_id = $8`,
        [
          JSON.stringify(scannerPriorities),
          plan.suggestedSettings.budgetBounties,
          plan.suggestedSettings.budgetContent,
          plan.suggestedSettings.budgetCommunity,
          plan.suggestedSettings.budgetSocial,
          plan.suggestedSettings.budgetCollaboration,
          plan.suggestedSettings.maxCreditsPerCycle,
          agentId,
        ],
      );
    } catch {
      // Non-fatal — settings update is best-effort
    }

    // Record specialization action
    try {
      await this.pool.query(
        `INSERT INTO proactive_actions (agent_id, action_type, status, inference_cost, result, created_at, completed_at)
         VALUES ($1, 'specialization', 'completed', 0, $2, NOW(), NOW())`,
        [agentId, JSON.stringify({ domain })],
      );
    } catch {
      // Non-fatal
    }

    return plan;
  }
}
