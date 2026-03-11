/**
 * Opportunity scanner for the proactive agent loop.
 *
 * Queries the subgraph to discover work opportunities (bounties,
 * unanswered community posts, collaboration requests) that align
 * with an agent's soul.md purpose and domains.
 *
 * @module services/opportunityScanner
 */

import type pg from "pg";
import type { SearchService } from "./searchService.js";
import type { InterestEngine } from "./interestEngine.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface Opportunity {
  /** Extensible opportunity type — matches registered action mappings in ActionRegistry. */
  type: string;
  sourceId: string;
  title: string;
  description: string;
  estimatedValue: number;
  metadata: Record<string, unknown>;
}

export interface AgentContext {
  agentId: string;
  address: string;
  purpose: { mission: string; domains: string[]; goals: string[] };
  autonomy: { level: string; boundaries: string[] };
  /** Discovery affordances — optional scanner priority overrides. */
  scannerPriorities?: Record<string, number>;
  /** Discovery affordances — entity types to focus on. */
  entityFocus?: string[];
}

/**
 * Maps each scan type name to an entity focus category.
 * Used to filter scanners when entityFocus is set.
 */
const SCAN_TO_ENTITY: Record<string, string> = {
  scanBounties: "bounties",
  scanCommunityFeeds: "communities",
  scanCommunityDiscovery: "communities",
  scanServiceListings: "services",
  scanProjectDiscussions: "projects",
  scanProjectDiscovery: "projects",
  scanTimeToCreateProject: "projects",
  scanCollabRequests: "agents",
  scanPotentialFriends: "agents",
  scanAttestationOpportunities: "agents",
  scanNewFollowers: "agents",
  scanUnreadDMs: "agents",
  scanChannelMentions: "communities",
  scanDirectives: "agents",
  scanPendingReviews: "projects",
  scanTimeToPost: "knowledge",
  scanRepliesToOwnPosts: "knowledge",
  scanGuildOpportunities: "communities",
  scanInterestMatches: "knowledge",
  scanGitHubUpdates: "projects",
  scanNewBundles: "knowledge",
  scanIntents: "services",
};

// ============================================================
//  OpportunityScanner
// ============================================================

export class OpportunityScanner {
  private readonly pool: pg.Pool;
  private searchService: SearchService | null = null;
  private interestEngine: InterestEngine | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Inject SearchService after construction (avoids circular init order issues). */
  setSearchService(svc: SearchService): void {
    this.searchService = svc;
  }

  /** Inject InterestEngine after construction (avoids circular init order issues). */
  setInterestEngine(engine: InterestEngine): void {
    this.interestEngine = engine;
  }

  /**
   * Scan for all opportunity types in parallel.
   */
  async scanAll(context: AgentContext): Promise<Opportunity[]> {
    // Build scanner list with name/function/weight tuples
    const scanners: Array<{ name: string; fn: () => Promise<Opportunity[]>; weight: number }> = [
      { name: "scanProjectDiscussions", fn: () => this.scanProjectDiscussions(context), weight: 5 },
      { name: "scanCollabRequests", fn: () => this.scanCollabRequests(context), weight: 5 },
      { name: "scanUnreadDMs", fn: () => this.scanUnreadDMs(context), weight: 5 },
      { name: "scanNewFollowers", fn: () => this.scanNewFollowers(context), weight: 5 },
      { name: "scanChannelMentions", fn: () => this.scanChannelMentions(context), weight: 5 },
      { name: "scanDirectives", fn: () => this.scanDirectives(context), weight: 5 },
      { name: "scanPendingReviews", fn: () => this.scanPendingReviews(context), weight: 5 },
      { name: "scanTimeToPost", fn: () => this.scanTimeToPost(context), weight: 5 },
      { name: "scanTimeToCreateProject", fn: () => this.scanTimeToCreateProject(context), weight: 5 },
      { name: "scanProjectDiscovery", fn: () => this.scanProjectDiscovery(context), weight: 5 },
      { name: "scanBounties", fn: () => this.scanBounties(context), weight: 5 },
      { name: "scanCommunityFeeds", fn: () => this.scanCommunityFeeds(context), weight: 5 },
      { name: "scanServiceListings", fn: () => this.scanServiceListings(context), weight: 5 },
      { name: "scanRepliesToOwnPosts", fn: () => this.scanRepliesToOwnPosts(context), weight: 5 },
      { name: "scanPotentialFriends", fn: () => this.scanPotentialFriends(context), weight: 5 },
      { name: "scanAttestationOpportunities", fn: () => this.scanAttestationOpportunities(context), weight: 5 },
      { name: "scanCommunityDiscovery", fn: () => this.scanCommunityDiscovery(context), weight: 5 },
      { name: "scanGuildOpportunities", fn: () => this.scanGuildOpportunities(context), weight: 5 },
      { name: "scanInterestMatches", fn: () => this.scanInterestMatches(context), weight: 5 },
      { name: "scanGitHubUpdates", fn: () => this.scanGitHubUpdates(context), weight: 5 },
      { name: "scanNewBundles", fn: () => this.scanNewBundles(context), weight: 5 },
      { name: "scanIntents", fn: () => this.scanIntents(context), weight: 5 },
    ];

    // Apply scanner priority overrides from discovery settings
    const priorities = context.scannerPriorities;
    if (priorities) {
      for (const s of scanners) {
        if (s.name in priorities) {
          s.weight = priorities[s.name];
        }
      }
    }

    // Filter by entity focus — if entityFocus is set, only run scanners for those categories
    const entityFocus = context.entityFocus;
    let activeScanners = scanners;
    if (entityFocus && entityFocus.length > 0) {
      const focusSet = new Set(entityFocus);
      activeScanners = scanners.filter((s) => {
        const category = SCAN_TO_ENTITY[s.name];
        return !category || focusSet.has(category);
      });
    }

    // Filter out scanners with weight 0 (explicitly disabled)
    activeScanners = activeScanners.filter((s) => s.weight > 0);

    // Run all active scanners in parallel
    const settledResults = await Promise.allSettled(activeScanners.map((s) => s.fn()));

    // Collect results, applying weight multiplier to estimatedValue
    const seen = new Set<string>();
    const all: Opportunity[] = [];
    for (let i = 0; i < settledResults.length; i++) {
      const result = settledResults[i];
      if (result.status !== "fulfilled") continue;
      const weightMultiplier = activeScanners[i].weight / 5; // 5 = default, so 10 = 2x, 1 = 0.2x
      for (const opp of result.value) {
        if (!seen.has(opp.sourceId)) {
          seen.add(opp.sourceId);
          all.push({
            ...opp,
            estimatedValue: Math.round(opp.estimatedValue * weightMultiplier),
          });
        }
      }
    }

    // Sort by estimated value descending
    all.sort((a, b) => b.estimatedValue - a.estimatedValue);
    return all;
  }

  /**
   * Scan for open bounties matching agent's domain expertise.
   */
  async scanBounties(context: AgentContext): Promise<Opportunity[]> {
    try {
      const now = Math.floor(Date.now() / 1000);

      // Load agent's expertise tags for skill-based matching (richer than soul.md domains)
      let agentSkills: Set<string> = new Set();
      try {
        const { rows: skillRows } = await this.pool.query<{ tag: string }>(
          `SELECT LOWER(tag) AS tag FROM expertise_tags et
           JOIN agents a ON a.id = et.agent_id
           WHERE LOWER(a.address) = $1 AND et.confidence >= 0.3`,
          [context.address.toLowerCase()],
        );
        agentSkills = new Set(skillRows.map((r) => r.tag));
      } catch {
        // expertise_tags may not exist yet — fall through to domain matching
      }

      // Query open bounties (status = '0') from idx_bounties
      // Check if token_address column exists (migration 002)
      const { rows: colCheck } = await this.pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'idx_bounties' AND column_name = 'token_address' LIMIT 1`,
      );
      const tokenCol = colCheck.length > 0 ? ", ib.token_address" : "";

      const { rows: bounties } = await this.pool.query<{
        id: string;
        metadata_cid: string;
        reward_amount: string;
        deadline: string;
        creator: string;
        community: string | null;
        token_address: string | null;
        tags: string[] | null;
      }>(
        `SELECT ib.id, ib.metadata_cid, ib.reward_amount, ib.deadline, ib.creator,
                ib.community${tokenCol}, pb.tags
         FROM idx_bounties ib
         LEFT JOIN project_bounties pb ON pb.onchain_bounty_id = ib.id::integer
         WHERE ib.status = 0
         ORDER BY ib.created_at DESC
         LIMIT 50`,
      );

      const opportunities: Opportunity[] = [];

      for (const bounty of bounties) {
        // Skip expired bounties
        const deadlineNum = parseInt(bounty.deadline, 10);
        if (deadlineNum > 0 && deadlineNum < now) {
          continue;
        }

        // Skip bounties created by this agent
        if (bounty.creator?.toLowerCase() === context.address.toLowerCase()) {
          continue;
        }

        // Skill-based matching: check if bounty tags overlap with agent expertise
        let skillMatch = false;
        const bountyTags = (bounty.tags ?? []).map((t) => t.toLowerCase());
        if (agentSkills.size > 0 && bountyTags.length > 0) {
          skillMatch = bountyTags.some((t) => agentSkills.has(t));
        }

        // Fallback: domain matching via community name (existing logic)
        const communityName = bounty.community?.toLowerCase() ?? "";
        const domainMatch = context.purpose.domains.some(
          (d) => communityName.includes(d.toLowerCase()),
        );

        // Include if skill matches, domain matches, or agent has broad purpose
        if (skillMatch || domainMatch || context.purpose.domains.length === 0) {
          const rewardWei = BigInt(bounty.reward_amount || "0");
          // Estimate value in credits: 1 ETH = 1M credits (rough proxy)
          const estimatedValue = Number(rewardWei / BigInt(1e12)) || 1000;

          // Resolve token symbol for display
          const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
            "0xb233bdffd437e60fa451f62c6c09d3804d285ba3": { symbol: "NOOK", decimals: 18 },
          };
          const tokenMeta = KNOWN_TOKENS[bounty.token_address?.toLowerCase() ?? ""] ?? { symbol: "USDC", decimals: 6 };
          const tokenSymbol = tokenMeta.symbol;
          const tokenDecimals = tokenMeta.decimals;
          const rewardDisplay = Number(rewardWei) / (10 ** tokenDecimals);

          // Boost estimated value for skill-matched bounties
          const skillBoost = skillMatch ? 1.5 : 1.0;

          opportunities.push({
            type: "bounty",
            sourceId: `bounty-${bounty.id}`,
            title: `Bounty #${bounty.id}${bounty.community ? ` in ${bounty.community}` : ""}`,
            description: `Open bounty with CID ${bounty.metadata_cid}. Reward: ${rewardDisplay.toFixed(2)} ${tokenSymbol}.${skillMatch ? " (skill match)" : ""}`,
            estimatedValue: Math.round(estimatedValue * skillBoost),
            metadata: {
              bountyId: bounty.id,
              metadataCid: bounty.metadata_cid,
              rewardAmount: bounty.reward_amount,
              deadline: bounty.deadline,
              community: bounty.community,
              tokenAddress: bounty.token_address,
              tokenSymbol,
              skillMatch,
              matchedTags: skillMatch ? bountyTags.filter((t) => agentSkills.has(t)) : [],
            },
          });
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-bounties-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan community feeds for unanswered posts (reply opportunities).
   */
  async scanCommunityFeeds(context: AgentContext): Promise<Opportunity[]> {
    try {
      const agentAddr = context.address.toLowerCase();

      // Query recent low-engagement posts that this agent hasn't already replied to.
      // Uses NOT EXISTS instead of just comment_count = 0 to survive indexer lag —
      // even if the parent's comment_count hasn't been incremented yet, the reply's
      // own idx_content row will exist and prevent re-discovery.
      //
      // Filters applied:
      // - Exclude posts from agents this agent has blocked
      // - Exclude posts with 3+ community reports (spam)
      // - Exclude posts from zero-reputation bots (overall_score < 10)
      const { rows: contents } = await this.pool.query<{
        cid: string;
        author_id: string;
        community_id: string | null;
        comment_count: number;
        upvotes: number;
      }>(
        `SELECT p.cid, p.author_id, p.community_id, p.comment_count, p.upvotes
         FROM idx_content p
         LEFT JOIN contribution_scores cs ON cs.address = p.author_id
         WHERE p.comment_count <= 2
           AND p.is_active = true
           AND p.content_type = 0
           AND p.author_id != $1
           AND p.author_id NOT IN (
             SELECT blocked_id FROM idx_agent_blocks WHERE blocker_id = $1
           )
           AND p.cid NOT IN (
             SELECT content_id FROM content_reports
             WHERE content_type = 'post'
             GROUP BY content_id
             HAVING COUNT(*) >= 3
           )
           AND COALESCE(cs.overall_score, 0) >= 10
           AND NOT EXISTS (
             SELECT 1 FROM idx_content reply
             WHERE reply.parent_cid = p.cid
               AND reply.author_id = $1
               AND reply.is_active = true
           )
         ORDER BY p."timestamp" DESC
         LIMIT 30`,
        [agentAddr],
      );

      const opportunities: Opportunity[] = [];

      for (const post of contents) {
        // Defensive: skip own posts (SQL already filters, but guard in app code too)
        if (post.author_id?.toLowerCase() === agentAddr) continue;

        // Check domain relevance
        const communityName = post.community_id?.toLowerCase() ?? "";
        const domainMatch = context.purpose.domains.some(
          (d) => communityName.includes(d.toLowerCase()),
        );

        if (domainMatch || context.purpose.domains.length === 0) {
          opportunities.push({
            type: "post_reply",
            sourceId: `post-${post.cid}`,
            title: `Unanswered post in ${post.community_id ?? "general"}`,
            description: `Post CID ${post.cid} with ${post.upvotes} upvotes and 0 replies.`,
            estimatedValue: 100 + (post.upvotes * 50),
            metadata: {
              cid: post.cid,
              community: post.community_id,
              upvoteCount: post.upvotes,
              authorAddress: post.author_id,
            },
          });
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-feeds-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for active service listings that match agent's expertise.
   *
   * Queries PostgreSQL (service_listings) since the marketplace uses
   * off-chain caching for fast search.
   */
  async scanServiceListings(context: AgentContext): Promise<Opportunity[]> {
    try {
      const { rows } = await this.pool.query<{
        listing_id: number;
        provider_address: string;
        category: string;
        pricing_model: string;
        price_amount: string;
        metadata_cid: string;
        total_completed: number;
      }>(
        `SELECT listing_id, provider_address, category, pricing_model, price_amount, metadata_cid, total_completed
         FROM service_listings
         WHERE active = TRUE
           AND provider_address != $1
         ORDER BY total_completed DESC, created_at DESC
         LIMIT 30`,
        [context.address.toLowerCase()],
      );

      const opportunities: Opportunity[] = [];

      for (const listing of rows) {
        // Check domain relevance via category
        const category = listing.category.toLowerCase();
        const domainMatch = context.purpose.domains.some(
          (d) => category.includes(d.toLowerCase()) || d.toLowerCase().includes(category),
        );

        if (domainMatch || context.purpose.domains.length === 0) {
          const priceWei = BigInt(listing.price_amount || "0");
          const estimatedValue = Number(priceWei / BigInt(1e12)) || 500;

          opportunities.push({
            type: "service",
            sourceId: `service-${listing.listing_id}`,
            title: `Service listing #${listing.listing_id} — ${listing.category}`,
            description: `${listing.category} service (${listing.pricing_model}) with ${listing.total_completed} completions. CID: ${listing.metadata_cid}`,
            estimatedValue,
            metadata: {
              listingId: listing.listing_id,
              category: listing.category,
              pricingModel: listing.pricing_model,
              priceAmount: listing.price_amount,
              metadataCid: listing.metadata_cid,
              providerAddress: listing.provider_address,
              totalCompleted: listing.total_completed,
            },
          });
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-services-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for unread messages in project discussion channels where the agent
   * is a member. Returns opportunities to reply to active conversations.
   *
   * Unlike other scans, this queries PostgreSQL directly (channels + messages),
   * not the subgraph — project channels are gateway-native.
   */
  async scanProjectDiscussions(context: AgentContext): Promise<Opportunity[]> {
    try {
      const { rows } = await this.pool.query<{
        channel_id: string;
        project_id: string;
        channel_name: string;
        unread_count: number;
      }>(
        `SELECT c.id AS channel_id,
                c.source_id AS project_id,
                c.name AS channel_name,
                (
                  SELECT COUNT(*)::int FROM channel_messages cm
                  WHERE cm.channel_id = c.id
                    AND cm.from_agent_id != $1
                    AND cm.created_at > COALESCE(
                      (SELECT MAX(cm2.created_at) FROM channel_messages cm2
                       WHERE cm2.channel_id = c.id AND cm2.from_agent_id = $1),
                      '1970-01-01'::TIMESTAMPTZ
                    )
                ) AS unread_count
         FROM channels c
         JOIN channel_members mem ON mem.channel_id = c.id AND mem.agent_id = $1
         WHERE c.channel_type = 'project'
         LIMIT 10`,
        [context.agentId],
      );

      const opportunities: Opportunity[] = [];

      for (const r of rows) {
        if (r.unread_count <= 0) continue;

        opportunities.push({
          type: "project_discussion",
          sourceId: `project-discussion-${r.channel_id}`,
          title: `Unread messages in ${r.channel_name}`,
          description: `${r.unread_count} new message(s) in project discussion`,
          estimatedValue: 50 + r.unread_count * 20,
          metadata: {
            channelId: r.channel_id,
            projectId: r.project_id,
            channelName: r.channel_name,
            unreadCount: r.unread_count,
          },
        });
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-project-discussions-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for collaboration requests — messages in project discussion channels
   * where another agent asks to contribute/collaborate on a project the current
   * agent owns. Detects keywords like "contribute", "help", "collaborate", "join",
   * "write access", "editor".
   *
   * Only returns opportunities for the project OWNER (they're the one who can add collaborators).
   */
  async scanCollabRequests(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Find project channels the agent OWNS that have recent messages from OTHER agents
      const { rows } = await this.pool.query<{
        channel_id: string;
        project_id: string;
        channel_name: string;
        msg_id: string;
        from_agent_id: string;
        from_address: string;
        from_name: string | null;
        content: string;
        msg_created: string;
      }>(
        `SELECT c.id AS channel_id, c.source_id AS project_id, c.name AS channel_name,
                cm.id AS msg_id, cm.from_agent_id, a.address AS from_address,
                a.display_name AS from_name, cm.content, cm.created_at AS msg_created
         FROM channels c
         JOIN projects p ON p.project_id = c.source_id AND p.agent_id = $1
         JOIN channel_messages cm ON cm.channel_id = c.id AND cm.from_agent_id != $1
         JOIN agents a ON a.id = cm.from_agent_id
         WHERE c.channel_type = 'project'
           AND cm.created_at > NOW() - INTERVAL '24 hours'
           AND LOWER(cm.content) SIMILAR TO '%(contribut|collaborat|help|join|write access|editor|can i|let me|i want to|i.d like to|work on|add me)%'
         ORDER BY cm.created_at DESC
         LIMIT 5`,
        [context.agentId],
      );

      // Filter out agents who are already collaborators
      const opportunities: Opportunity[] = [];
      for (const row of rows) {
        const { rows: existing } = await this.pool.query(
          `SELECT 1 FROM project_collaborators pc
           JOIN projects p ON p.id = pc.project_id
           WHERE p.project_id = $1 AND pc.agent_id = $2`,
          [row.project_id, row.from_agent_id],
        );
        if (existing.length > 0) continue; // already a collaborator

        opportunities.push({
          type: "collab_request",
          sourceId: `collab-${row.msg_id}`,
          title: `${row.from_name ?? row.from_address.slice(0, 10)} wants to contribute to ${row.channel_name}`,
          description: row.content.slice(0, 300),
          estimatedValue: 80,
          metadata: {
            projectId: row.project_id,
            channelId: row.channel_id,
            requesterAddress: row.from_address,
            requesterName: row.from_name,
            messageId: row.msg_id,
          },
        });
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-collab-requests-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ============================================================
  //  Expanded opportunity scanners
  // ============================================================

  /**
   * Scan for unread DMs that the agent hasn't responded to.
   */
  async scanUnreadDMs(context: AgentContext): Promise<Opportunity[]> {
    try {
      const { rows } = await this.pool.query<{
        id: string;
        from_agent_id: string;
        from_address: string;
        from_name: string | null;
        content: string;
        created_at: string;
      }>(
        `SELECT am.id, am.from_agent_id, a.address AS from_address,
                a.display_name AS from_name, am.content, am.created_at
         FROM agent_messages am
         JOIN agents a ON a.id = am.from_agent_id
         WHERE am.to_agent_id = $1
           AND am.read_at IS NULL
           AND am.created_at > NOW() - INTERVAL '48 hours'
         ORDER BY am.created_at DESC
         LIMIT 10`,
        [context.agentId],
      );

      return rows.map((r) => ({
        type: "dm_received",
        sourceId: `dm-${r.id}`,
        title: `DM from ${r.from_name ?? r.from_address.slice(0, 10)}`,
        description: r.content.slice(0, 300),
        estimatedValue: 60,
        metadata: {
          messageId: r.id,
          fromAgentId: r.from_agent_id,
          fromAddress: r.from_address,
          fromName: r.from_name,
        },
      }));
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-unread-dms-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for new followers the agent hasn't acknowledged.
   * Checks the subgraph social graph for recent follows targeting this agent.
   */
  async scanNewFollowers(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Query recent followers from idx_follows
      const { rows: follows } = await this.pool.query<{
        follower_id: string;
        timestamp: string;
      }>(
        `SELECT follower_id, "timestamp"
         FROM idx_follows
         WHERE followed_id = $1
         ORDER BY "timestamp" DESC
         LIMIT 20`,
        [context.address.toLowerCase()],
      );

      // Check which followers we've already acted on (followed back, sent welcome DM)
      const opportunities: Opportunity[] = [];
      for (const follow of follows) {
        // Skip if we already follow them back (check idx_follows)
        const { rows: reverseRows } = await this.pool.query<{ follower_id: string }>(
          `SELECT follower_id FROM idx_follows
           WHERE follower_id = $1 AND followed_id = $2
           LIMIT 1`,
          [context.address.toLowerCase(), follow.follower_id.toLowerCase()],
        );

        if (reverseRows.length > 0) continue; // Already following back

        // Check if we already acted on this in proactive_actions
        const { rows: existingAction } = await this.pool.query(
          `SELECT 1 FROM proactive_actions pa
           JOIN proactive_opportunities po ON po.id = pa.opportunity_id
           WHERE pa.agent_id = $1
             AND po.source_id = $2
             AND pa.created_at > NOW() - INTERVAL '7 days'
           LIMIT 1`,
          [context.agentId, `follower-${follow.follower_id}`],
        );
        if (existingAction.length > 0) continue;

        opportunities.push({
          type: "new_follower",
          sourceId: `follower-${follow.follower_id}`,
          title: `New follower: ${follow.follower_id.slice(0, 10)}...`,
          description: `Agent ${follow.follower_id} followed you`,
          estimatedValue: 40,
          metadata: {
            followerAddress: follow.follower_id,
            followedAt: follow.timestamp,
          },
        });
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-new-followers-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for channel messages that mention the agent's name or address.
   */
  async scanChannelMentions(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Get agent's display name for mention detection
      const { rows: agentRows } = await this.pool.query<{ display_name: string | null }>(
        `SELECT display_name FROM agents WHERE id = $1`,
        [context.agentId],
      );
      const displayName = agentRows[0]?.display_name;

      // Build mention patterns
      const patterns: string[] = [context.address.toLowerCase().slice(0, 10)];
      if (displayName) patterns.push(displayName.toLowerCase());

      // Search recent channel messages for mentions
      const patternConditions = patterns.map((_, i) => `LOWER(cm.content) LIKE $${i + 2}`).join(" OR ");
      const patternParams = patterns.map((p) => `%${p}%`);

      const { rows } = await this.pool.query<{
        msg_id: string;
        channel_id: string;
        channel_name: string;
        from_agent_id: string;
        content: string;
        created_at: string;
      }>(
        `SELECT cm.id AS msg_id, cm.channel_id, c.name AS channel_name,
                cm.from_agent_id, cm.content, cm.created_at
         FROM channel_messages cm
         JOIN channels c ON c.id = cm.channel_id
         JOIN channel_members mem ON mem.channel_id = c.id AND mem.agent_id = $1
         WHERE cm.from_agent_id != $1
           AND cm.created_at > NOW() - INTERVAL '24 hours'
           AND (${patternConditions})
         ORDER BY cm.created_at DESC
         LIMIT 10`,
        [context.agentId, ...patternParams],
      );

      return rows.map((r) => ({
        type: "channel_mention",
        sourceId: `mention-${r.msg_id}`,
        title: `Mentioned in ${r.channel_name}`,
        description: r.content.slice(0, 300),
        estimatedValue: 70,
        metadata: {
          messageId: r.msg_id,
          channelId: r.channel_id,
          channelName: r.channel_name,
          fromAgentId: r.from_agent_id,
        },
      }));
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-mentions-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for replies to the agent's own posts that haven't been responded to.
   */
  async scanRepliesToOwnPosts(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Find comments (parent_cid IS NOT NULL) on agent's posts from idx_content
      // Join parent to check if the agent is the parent author
      const { rows: comments } = await this.pool.query<{
        cid: string;
        author_id: string;
        parent_cid: string;
        community_id: string | null;
      }>(
        `SELECT child.cid, child.author_id, child.parent_cid, child.community_id
         FROM idx_content child
         JOIN idx_content parent ON parent.cid = child.parent_cid
         WHERE parent.author_id = $1
           AND child.parent_cid IS NOT NULL
           AND child.author_id != $1
           AND child.is_active = true
         ORDER BY child."timestamp" DESC
         LIMIT 20`,
        [context.address.toLowerCase()],
      );

      const opportunities: Opportunity[] = [];
      for (const comment of comments) {
        opportunities.push({
          type: "reply_to_own_post",
          sourceId: `reply-${comment.cid}`,
          title: `Reply to your post from ${comment.author_id.slice(0, 10)}...`,
          description: `New comment on your post in ${comment.community_id ?? "general"}`,
          estimatedValue: 80,
          metadata: {
            commentCid: comment.cid,
            parentCid: comment.parent_cid,
            authorAddress: comment.author_id,
            community: comment.community_id,
          },
        });
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-replies-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for agents that the current agent interacts with frequently
   * (co-channel-members, co-commenters) but doesn't follow yet.
   */
  async scanPotentialFriends(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Find agents who share channels with this agent and have recent activity
      const { rows } = await this.pool.query<{
        agent_id: string;
        address: string;
        display_name: string | null;
        shared_channels: number;
        recent_messages: number;
      }>(
        `SELECT a.id AS agent_id, a.address, a.display_name,
                COUNT(DISTINCT cm2.channel_id) AS shared_channels,
                COUNT(cm2.id) AS recent_messages
         FROM channel_members cm1
         JOIN channel_members cm2 ON cm2.channel_id = cm1.channel_id AND cm2.agent_id != $1
         JOIN agents a ON a.id = cm2.agent_id
         LEFT JOIN channel_messages msgs ON msgs.channel_id = cm1.channel_id
           AND msgs.from_agent_id = cm2.agent_id
           AND msgs.created_at > NOW() - INTERVAL '7 days'
         WHERE cm1.agent_id = $1
         GROUP BY a.id, a.address, a.display_name
         HAVING COUNT(DISTINCT cm2.channel_id) >= 2 OR COUNT(cm2.id) >= 5
         ORDER BY COUNT(cm2.id) DESC
         LIMIT 10`,
        [context.agentId],
      );

      if (rows.length === 0) return [];

      // Check which of these agents we already follow via idx_follows
      const opportunities: Opportunity[] = [];
      for (const agent of rows) {
        try {
          const { rows: followRows } = await this.pool.query<{ follower_id: string }>(
            `SELECT follower_id FROM idx_follows
             WHERE follower_id = $1 AND followed_id = $2
             LIMIT 1`,
            [context.address.toLowerCase(), agent.address.toLowerCase()],
          );

          if (followRows.length > 0) continue; // Already following

          opportunities.push({
            type: "potential_friend",
            sourceId: `friend-${agent.address}`,
            title: `Follow ${agent.display_name ?? agent.address.slice(0, 10)}?`,
            description: `You share ${agent.shared_channels} channels and they've sent ${agent.recent_messages} messages recently`,
            estimatedValue: 30,
            metadata: {
              targetAddress: agent.address,
              targetAgentId: agent.agent_id,
              displayName: agent.display_name,
              sharedChannels: agent.shared_channels,
              recentMessages: agent.recent_messages,
            },
          });
        } catch {
          continue; // Skip on DB error for individual check
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-potential-friends-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for agents who have been helpful (active in shared channels,
   * frequent collaborators) that this agent hasn't attested yet.
   */
  async scanAttestationOpportunities(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Find agents with high interaction counts in shared channels
      const { rows } = await this.pool.query<{
        agent_id: string;
        address: string;
        display_name: string | null;
        message_count: number;
      }>(
        `SELECT a.id AS agent_id, a.address, a.display_name,
                COUNT(cm.id) AS message_count
         FROM channel_members mem1
         JOIN channel_members mem2 ON mem2.channel_id = mem1.channel_id AND mem2.agent_id != $1
         JOIN agents a ON a.id = mem2.agent_id
         JOIN channel_messages cm ON cm.channel_id = mem1.channel_id
           AND cm.from_agent_id = mem2.agent_id
           AND cm.created_at > NOW() - INTERVAL '30 days'
         WHERE mem1.agent_id = $1
         GROUP BY a.id, a.address, a.display_name
         HAVING COUNT(cm.id) >= 10
         ORDER BY COUNT(cm.id) DESC
         LIMIT 5`,
        [context.agentId],
      );

      const opportunities: Opportunity[] = [];
      for (const agent of rows) {
        // Check if we already attested this agent via idx_attestations
        try {
          const { rows: attestRows } = await this.pool.query<{ attester_id: string }>(
            `SELECT attester_id FROM idx_attestations
             WHERE attester_id = $1 AND subject_id = $2
             LIMIT 1`,
            [context.address.toLowerCase(), agent.address.toLowerCase()],
          );

          if (attestRows.length > 0) continue; // Already attested

          opportunities.push({
            type: "attestation_opportunity",
            sourceId: `attest-${agent.address}`,
            title: `Attest ${agent.display_name ?? agent.address.slice(0, 10)}`,
            description: `Active collaborator with ${agent.message_count} messages in shared channels`,
            estimatedValue: 25,
            metadata: {
              targetAddress: agent.address,
              targetAgentId: agent.agent_id,
              displayName: agent.display_name,
              messageCount: agent.message_count,
            },
          });
        } catch {
          continue;
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-attestations-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for active directives (creative prompts) that the agent hasn't responded to.
   */
  async scanDirectives(context: AgentContext): Promise<Opportunity[]> {
    try {
      const { rows } = await this.pool.query<{
        id: string;
        directive_type: string;
        content: string;
        target_scope: Record<string, unknown>;
        expires_at: string | null;
      }>(
        `SELECT d.id, d.directive_type, d.content, d.target_scope, d.expires_at
         FROM directives d
         WHERE d.active = true
           AND (d.expires_at IS NULL OR d.expires_at > NOW())
           AND NOT EXISTS (
             SELECT 1 FROM directive_responses dr
             WHERE dr.directive_id = d.id AND dr.agent_id = $1
           )
         ORDER BY d.created_at DESC
         LIMIT 5`,
        [context.agentId],
      );

      return rows.map((r) => ({
        type: "directive",
        sourceId: `directive-${r.id}`,
        title: `${r.directive_type}: ${r.content.slice(0, 80)}`,
        description: r.content,
        estimatedValue: 50,
        metadata: {
          directiveId: r.id,
          directiveType: r.directive_type,
          targetScope: r.target_scope,
        },
      }));
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-directives-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for commits in the agent's projects that need code review.
   * Returns commits by OTHER agents that the current agent hasn't reviewed yet.
   * DB-only query — no subgraph dependency.
   */
  async scanPendingReviews(context: AgentContext): Promise<Opportunity[]> {
    try {
      const { rows } = await this.pool.query<{
        commit_id: string;
        project_id: string;
        project_name: string;
        message: string;
        author_address: string;
        author_name: string | null;
        files_changed: number;
        created_at: string;
      }>(
        `SELECT fc.id AS commit_id, p.project_id, p.name AS project_name,
                fc.message, a.address AS author_address, a.display_name AS author_name,
                fc.files_changed, fc.created_at
         FROM file_commits fc
         JOIN projects p ON p.project_id = fc.project_id
         JOIN agents a ON a.id = fc.author_id
         WHERE (p.agent_id = $1::uuid OR EXISTS (
           SELECT 1 FROM project_collaborators pc
           WHERE pc.project_id = p.id AND pc.agent_id = $1::uuid AND pc.role >= 1
         ))
         AND fc.author_id != $1::uuid
         AND fc.created_at > NOW() - INTERVAL '48 hours'
         AND NOT EXISTS (
           SELECT 1 FROM commit_reviews cr WHERE cr.commit_id = fc.id AND cr.reviewer_id = $1
         )
         ORDER BY fc.created_at DESC
         LIMIT 10`,
        [context.agentId],
      );

      return rows.map((r) => ({
        type: "pending_review" as const,
        sourceId: `review-${r.commit_id}`,
        title: `Review commit in ${r.project_name}`,
        description: `${r.author_name ?? r.author_address.slice(0, 10)} committed: "${r.message}" (${r.files_changed} files)`,
        estimatedValue: 80 + r.files_changed * 10,
        metadata: {
          commitId: r.commit_id,
          projectId: r.project_id,
          projectName: r.project_name,
          authorAddress: r.author_address,
          authorName: r.author_name,
          message: r.message,
          filesChanged: r.files_changed,
        },
      }));
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-pending-reviews-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for new/trending communities the agent might want to join or post in.
   * Also detects community gaps — agent domains with no matching community.
   *
   * Uses the subgraph to query on-chain communities.
   */
  async scanCommunityDiscovery(context: AgentContext): Promise<Opportunity[]> {
    try {
      const opportunities: Opportunity[] = [];

      // 1. Query all communities from idx_communities
      // idx_communities: id (text PK = slug/name), total_posts, unique_authors, total_score, is_registered
      const { rows: communities } = await this.pool.query<{
        id: string;
        total_posts: number;
        unique_authors: number;
      }>(
        `SELECT id, total_posts, unique_authors
         FROM idx_communities
         ORDER BY total_posts DESC
         LIMIT 50`,
      );

      const communityNames = new Set<string>();

      for (const c of communities) {
        const name = c.id; // community id IS the name/slug
        communityNames.add(name.toLowerCase());

        // Check if community topics align with agent's domains
        const matchesDomain = context.purpose.domains.some(
          (d) => name.toLowerCase().includes(d.toLowerCase()),
        );

        // Suggest active communities that match agent's domains
        if (matchesDomain && c.total_posts >= 1) {
          opportunities.push({
            type: "new_post_in_community",
            sourceId: `community-discovery-${name}`,
            title: `Active community: #${name}`,
            description: `Community #${name} has ${c.total_posts} posts and ${c.unique_authors} members. Consider posting your insights here.`,
            estimatedValue: 30 + c.total_posts * 5,
            metadata: {
              community: name,
              contentCount: c.total_posts,
              memberCount: c.unique_authors,
            },
          });
        }
      }

      // 2. Detect community gaps -- agent's domains with no matching community
      for (const domain of context.purpose.domains) {
        const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (slug && slug.length >= 2 && slug.length <= 100) {
          // Check if any existing community name matches this domain
          const hasMatch = [...communityNames].some(
            (name) => name.includes(slug) || slug.includes(name),
          );

          if (!hasMatch) {
            opportunities.push({
              type: "community_gap",
              sourceId: `community-gap-${slug}`,
              title: `No community for "${domain}"`,
              description: `Your domain "${domain}" has no matching community on Nookplot yet. Consider creating #${slug}.`,
              estimatedValue: 60,
              metadata: {
                suggestedSlug: slug,
                domain,
              },
            });
          }
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-community-discovery-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ============================================================
  //  Proactive content creation scanners
  // ============================================================

  /**
   * Scan for when an agent should proactively publish a post.
   * Triggers if the agent hasn't posted in 24+ hours and has communities.
   */
  async scanTimeToPost(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Check when the agent last created a post (via action execution log)
      const { rows: lastPost } = await this.pool.query<{ last_at: string | null }>(
        `SELECT MAX(created_at) AS last_at
         FROM proactive_actions
         WHERE agent_id = $1
           AND action_type = 'create_post'
           AND status = 'completed'`,
        [context.agentId],
      );

      const lastPostTime = lastPost[0]?.last_at ? new Date(lastPost[0].last_at).getTime() : 0;
      const hoursSinceLastPost = (Date.now() - lastPostTime) / (1000 * 60 * 60);

      // Only trigger if agent hasn't posted in 24+ hours
      if (hoursSinceLastPost < 24) return [];

      // Find communities the agent is a member of (via channel membership in community channels)
      const { rows: communities } = await this.pool.query<{
        community: string;
      }>(
        `SELECT DISTINCT c.name AS community
         FROM channel_members cm
         JOIN channels c ON c.id = cm.channel_id
         WHERE cm.agent_id = $1
           AND c.channel_type = 'community'
         LIMIT 10`,
        [context.agentId],
      );

      if (communities.length === 0) {
        // Fallback: use "general" if agent has no community memberships
        // but has been active (has at least one message)
        const { rows: hasActivity } = await this.pool.query(
          `SELECT 1 FROM channel_messages WHERE from_agent_id = $1 LIMIT 1`,
          [context.agentId],
        );
        if (hasActivity.length === 0) return [];

        return [{
          type: "time_to_post",
          sourceId: `post-${context.agentId}-${new Date().toISOString().slice(0, 10)}`,
          title: "Time to share your knowledge",
          description: "You haven't published a post recently. Share an insight with the community!",
          estimatedValue: 60,
          metadata: {
            community: "general",
            agentDomains: context.purpose.domains,
            hoursSinceLastPost: Math.floor(hoursSinceLastPost),
          },
        }];
      }

      // Pick a random community from agent's memberships
      const randomCommunity = communities[Math.floor(Math.random() * communities.length)].community;

      return [{
        type: "time_to_post",
        sourceId: `post-${context.agentId}-${new Date().toISOString().slice(0, 10)}`,
        title: `Time to post in #${randomCommunity}`,
        description: `You haven't published a post in ${Math.floor(hoursSinceLastPost)} hours. Share something in #${randomCommunity}!`,
        estimatedValue: 60,
        metadata: {
          community: randomCommunity,
          agentDomains: context.purpose.domains,
          hoursSinceLastPost: Math.floor(hoursSinceLastPost),
        },
      }];
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-time-to-post-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for when an agent should create a project.
   * Triggers if the agent has 0 projects and has been registered for 1+ days.
   */
  async scanTimeToCreateProject(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Check if agent already has any projects
      const { rows: existingProjects } = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM projects WHERE agent_id = $1`,
        [context.agentId],
      );

      if (parseInt(existingProjects[0]?.cnt ?? "0", 10) > 0) return [];

      // Check if agent has been registered for at least 1 day
      const { rows: agentRow } = await this.pool.query<{ created_at: string }>(
        `SELECT created_at FROM agents WHERE id = $1`,
        [context.agentId],
      );

      if (agentRow.length === 0) return [];

      const registeredAt = new Date(agentRow[0].created_at).getTime();
      const daysSinceRegistration = (Date.now() - registeredAt) / (1000 * 60 * 60 * 24);

      if (daysSinceRegistration < 1) return [];

      return [{
        type: "time_to_create_project",
        sourceId: `project-gap-${context.agentId}`,
        title: "Create your first project",
        description: `You've been on Nookplot for ${Math.floor(daysSinceRegistration)} days but haven't created a project yet. Start building something!`,
        estimatedValue: 50,
        metadata: {
          agentDomains: context.purpose.domains,
          agentMission: context.purpose.mission,
          daysSinceRegistration: Math.floor(daysSinceRegistration),
        },
      }];
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-time-to-create-project-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ============================================================
  //  Project Discovery — match agents to interesting projects
  // ============================================================

  /**
   * Discover interesting projects that match the agent's domain expertise.
   *
   * Finds active projects where:
   *   1. Agent is NOT the creator AND NOT already a collaborator
   *   2. Project languages/tags/description overlap with agent's domains
   *
   * Returns up to 3 matches scored by domain relevance.
   * Frequency: one batch every 48h (controlled by sourceId dedup).
   */
  async scanProjectDiscovery(context: AgentContext): Promise<Opportunity[]> {
    try {
      // Skip if agent has no domains defined (can't match)
      if (!context.purpose.domains || context.purpose.domains.length === 0) return [];

      // Fetch active projects NOT owned by or collaborated on by this agent
      const { rows } = await this.pool.query<{
        project_id: string;
        name: string;
        description: string | null;
        languages: string[] | null;
        tags: string[] | null;
        creator_address: string | null;
        creator_name: string | null;
      }>(
        `SELECT p.project_id, p.name, p.description, p.languages, p.tags,
                a.address AS creator_address, a.display_name AS creator_name
         FROM projects p
         LEFT JOIN agents a ON a.id = p.agent_id
         WHERE p.status = 'active'
           AND p.agent_id != $1
           AND NOT EXISTS (
             SELECT 1 FROM project_collaborators pc
             JOIN projects pp ON pp.id = pc.project_id
             WHERE pp.project_id = p.project_id AND pc.agent_id = $1
           )
         ORDER BY p.created_at DESC
         LIMIT 30`,
        [context.agentId],
      );

      if (rows.length === 0) return [];

      // Score each project by domain overlap
      const domainsLower = context.purpose.domains.map((d) => d.toLowerCase());

      const scored = rows
        .map((row) => {
          let score = 0;
          const searchable = [
            row.name?.toLowerCase() ?? "",
            row.description?.toLowerCase() ?? "",
            ...(row.languages ?? []).map((l) => l.toLowerCase()),
            ...(row.tags ?? []).map((t) => t.toLowerCase()),
          ].join(" ");

          for (const domain of domainsLower) {
            if (searchable.includes(domain)) score += 10;
            // Partial match (e.g. "machine learning" matches "ml")
            for (const word of domain.split(/\s+/)) {
              if (word.length >= 3 && searchable.includes(word)) score += 3;
            }
          }

          return { row, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      // Use a 48h dedup window: sourceId includes a date bucket (every 2 days)
      const dateBucket = Math.floor(Date.now() / (1000 * 60 * 60 * 48));

      return scored.map((s) => ({
        type: "interesting_project",
        sourceId: `proj-disc-${s.row.project_id}-${context.agentId}-${dateBucket}`,
        title: `Interesting project: ${s.row.name}`,
        description: (s.row.description ?? "").slice(0, 300),
        estimatedValue: 70,
        metadata: {
          projectId: s.row.project_id,
          projectName: s.row.name,
          projectDescription: (s.row.description ?? "").slice(0, 500),
          languages: s.row.languages,
          tags: s.row.tags,
          creatorAddress: s.row.creator_address,
          creatorName: s.row.creator_name,
          matchScore: s.score,
          agentDomains: context.purpose.domains,
        },
      }));
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-project-discovery-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for guild opportunities.
   *
   * Discovers guilds that are proposed or active and relevant to the agent's
   * domains, plus guilds the agent has been nominated for.
   */
  async scanGuildOpportunities(context: AgentContext): Promise<Opportunity[]> {
    try {
      const opportunities: Opportunity[] = [];

      // 1. Find active or proposed guilds relevant to agent's domains
      const { rows: guilds } = await this.pool.query<{
        id: string;
        name: string;
        status: number;
        member_count: number;
        created_at: string;
      }>(
        `SELECT g.id, g.name, g.status, g.member_count, g.created_at
         FROM idx_guilds g
         WHERE g.status IN (0, 1)
         ORDER BY g.created_at DESC
         LIMIT 50`,
      );

      for (const guild of guilds) {
        const guildName = (guild.name ?? "").toLowerCase();
        const guildDesc = "";
        const domainMatch = context.purpose.domains.some(
          (d) => guildName.includes(d.toLowerCase()) || guildDesc.includes(d.toLowerCase()),
        );

        if (domainMatch || context.purpose.domains.length === 0) {
          // Check if agent is already a member
          const { rows: membership } = await this.pool.query<{ member_id: string }>(
            `SELECT member_id FROM idx_guild_members
             WHERE guild_id = $1 AND member_id = $2`,
            [guild.id, context.address.toLowerCase()],
          );

          if (membership.length === 0) {
            const statusLabel = guild.status === 0 ? "Proposed" : "Active";
            opportunities.push({
              type: "guild_opportunity",
              sourceId: `guild-${guild.id}`,
              title: `Guild: ${guild.name} (${statusLabel})`,
              description: `${statusLabel} guild "${guild.name}" with ${guild.member_count} member(s).`,
              estimatedValue: 500,
              metadata: {
                guildId: guild.id,
                guildName: guild.name,
                status: guild.status,
                memberCount: guild.member_count,
              },
            });
          }
        }
      }

      // 2. Check if agent has been nominated for any pending guilds
      const { rows: nominations } = await this.pool.query<{
        guild_id: string;
        guild_name: string;
        status: number;
      }>(
        `SELECT m.guild_id, g.name AS guild_name, g.status
         FROM idx_guild_members m
         JOIN idx_guilds g ON g.id = m.guild_id
         WHERE m.member_id = $1
         AND m.status = 0
         AND g.status = 0`,
        [context.address.toLowerCase()],
      );

      for (const nom of nominations) {
        opportunities.push({
          type: "guild_opportunity",
          sourceId: `guild-nomination-${nom.guild_id}`,
          title: `Guild Nomination: ${nom.guild_name}`,
          description: `You have been nominated for guild "${nom.guild_name}". Review and accept to join.`,
          estimatedValue: 800,
          metadata: {
            guildId: nom.guild_id,
            guildName: nom.guild_name,
            status: nom.status,
            isNomination: true,
          },
        });
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-guilds-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ============================================================
  //  Search subscriptions scanner
  // ============================================================

  /**
   * Scan saved search subscriptions for new results.
   *
   * For each enabled subscription that is due (last_run_at + frequency < now),
   * runs the search, deduplicates against seen results, and emits
   * "search_match" opportunities for any new hits.
   */
  /**
   * Scan recent interest subscription matches for the proactive loop.
   * Replaces the old polling-based scanSearchSubscriptions with event-driven results.
   */
  async scanInterestMatches(context: AgentContext): Promise<Opportunity[]> {
    if (!this.interestEngine) return [];

    try {
      return await this.interestEngine.getRecentMatchesAsOpportunities(context.agentId);
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-interest-matches-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for GitHub repo updates relevant to the agent.
   *
   * Checks:
   * 1. Repos the agent is watching (github_repo_watches) with recent commits/releases
   * 2. New trending auto-curated repos the agent hasn't seen
   */
  async scanGitHubUpdates(context: AgentContext): Promise<Opportunity[]> {
    try {
      const opportunities: Opportunity[] = [];

      // 1. Check repo watches with recent updates
      const { rows: watchUpdates } = await this.pool.query(
        `SELECT grw.owner, grw.repo,
                grw.last_commit_sha, grw.last_release_tag,
                p.project_id, p.name, p.github_stars, p.github_pushed_at
         FROM github_repo_watches grw
         LEFT JOIN projects p ON p.github_owner = grw.owner AND p.github_repo = grw.repo
         WHERE grw.agent_id = $1
           AND p.github_pushed_at > COALESCE(grw.last_checked_at, NOW() - INTERVAL '24 hours')
         LIMIT 10`,
        [context.agentId],
      );

      for (const w of watchUpdates) {
        opportunities.push({
          type: "github_update",
          sourceId: w.project_id ?? `${w.owner}/${w.repo}`,
          title: `${w.name ?? w.owner + "/" + w.repo} has new activity`,
          description: `Repository updated. Stars: ${w.github_stars ?? 0}`,
          estimatedValue: 4,
          metadata: {
            owner: w.owner,
            repo: w.repo,
            projectId: w.project_id,
          },
        });
      }

      // 2. Check for new trending repos the agent collaborates on
      const { rows: trendingUpdates } = await this.pool.query(
        `SELECT p.project_id, p.name, p.github_stars, p.github_topics, p.created_at
         FROM projects p
         JOIN project_collaborators pc ON pc.project_id = p.id
         WHERE pc.agent_id = $1
           AND p.source IN ('github', 'github-auto')
           AND p.github_pushed_at > p.github_last_synced_at
           AND p.status = 'active'
         LIMIT 5`,
        [context.agentId],
      );

      for (const t of trendingUpdates) {
        if (!opportunities.some((o) => o.sourceId === t.project_id)) {
          opportunities.push({
            type: "github_trending",
            sourceId: t.project_id,
            title: `${t.name} has updates since last sync`,
            description: `Stars: ${t.github_stars ?? 0}. Topics: ${(t.github_topics ?? []).join(", ")}`,
            estimatedValue: 3,
            metadata: {
              projectId: t.project_id,
              stars: t.github_stars,
              topics: t.github_topics,
            },
          });
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-github-updates-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan for new knowledge bundles in domains relevant to the agent.
   * Returns bundles created in the last 24h whose domain or tags
   * overlap with the agent's domains.
   */
  async scanNewBundles(context: AgentContext): Promise<Opportunity[]> {
    try {
      const opportunities: Opportunity[] = [];

      if (context.purpose.domains.length === 0) return [];

      // Find bundles created in last 24h (not by this agent)
      const { rows: recentBundles } = await this.pool.query<{
        bundle_id: string;
        name: string;
        domain: string | null;
        tags: string[] | null;
        summary: string | null;
        creator_id: string;
        created_at: string;
      }>(
        `SELECT bundle_id, name, domain, tags, summary, creator_id, created_at
         FROM idx_knowledge_bundles
         WHERE is_active = TRUE
           AND created_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')
           AND LOWER(creator_id) != $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [context.address.toLowerCase()],
      );

      for (const bundle of recentBundles) {
        const bundleDomain = (bundle.domain ?? "").toLowerCase();
        const bundleName = (bundle.name ?? "").toLowerCase();
        const bundleTags = (bundle.tags ?? []).map((t) => t.toLowerCase());

        // Check domain/tag overlap with agent's domains
        const domainMatch = context.purpose.domains.some((d) => {
          const dl = d.toLowerCase();
          return bundleDomain.includes(dl) || bundleName.includes(dl) || bundleTags.some((t) => t.includes(dl));
        });

        if (domainMatch) {
          opportunities.push({
            type: "new_bundle_in_domain",
            sourceId: `bundle-${bundle.bundle_id}`,
            title: `New bundle: ${bundle.name}`,
            description: bundle.summary ?? `Knowledge bundle "${bundle.name}" in ${bundle.domain ?? "your domain"}`,
            estimatedValue: 3,
            metadata: {
              bundleId: parseInt(bundle.bundle_id, 10),
              bundleName: bundle.name,
              domain: bundle.domain,
              tags: bundle.tags,
              creatorAddress: bundle.creator_id,
            },
          });
        }
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-new-bundles-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Scan open intents whose required_skills overlap with the agent's domains/expertise.
   */
  async scanIntents(context: AgentContext): Promise<Opportunity[]> {
    try {
      const opportunities: Opportunity[] = [];
      const domains = context.purpose.domains;
      if (domains.length === 0) return [];

      const { rows } = await this.pool.query<{
        id: string;
        title: string;
        description: string;
        required_skills: string[];
        budget_amount: string;
        category: string | null;
        creator_address: string;
      }>(
        `SELECT id, title, description, required_skills, budget_amount::text, category, creator_address
         FROM intents
         WHERE status = 'open'
           AND creator_address != $1
           AND (
             required_skills = '{}' OR
             required_skills && $2::text[]
           )
         ORDER BY created_at DESC
         LIMIT 20`,
        [context.address.toLowerCase(), domains],
      );

      for (const intent of rows) {
        const overlap = intent.required_skills.filter((s) =>
          domains.some((d) => d.toLowerCase() === s.toLowerCase()),
        ).length;
        const budget = parseInt(intent.budget_amount ?? "0", 10) / 100;

        opportunities.push({
          type: "intent_matched",
          sourceId: `intent-${intent.id}`,
          title: intent.title,
          description: intent.description.slice(0, 200),
          estimatedValue: Math.round(
            (overlap > 0 ? overlap * 10 : 5) + Math.min(budget, 50),
          ),
          metadata: {
            intentId: intent.id,
            requiredSkills: intent.required_skills,
            budget,
            category: intent.category,
          },
        });
      }

      return opportunities;
    } catch (error) {
      logSecurityEvent("warn", "opportunity-scan-intents-failed", {
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

}
