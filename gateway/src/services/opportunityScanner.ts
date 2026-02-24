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
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { SubgraphGateway } from "./subgraphGateway.js";

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
}

// ============================================================
//  OpportunityScanner
// ============================================================

export class OpportunityScanner {
  private readonly pool: pg.Pool;
  private readonly subgraphGateway: SubgraphGateway | undefined;

  constructor(pool: pg.Pool, subgraphGateway?: SubgraphGateway) {
    this.pool = pool;
    this.subgraphGateway = subgraphGateway;
  }

  /**
   * Scan for all opportunity types in parallel.
   */
  async scanAll(context: AgentContext): Promise<Opportunity[]> {
    // Core scans (always run, DB-only)
    const corePromises = [
      this.scanProjectDiscussions(context),
      this.scanCollabRequests(context),
      this.scanUnreadDMs(context),
      this.scanNewFollowers(context),
      this.scanChannelMentions(context),
      this.scanDirectives(context),
      this.scanPendingReviews(context),
      this.scanTimeToPost(context),
      this.scanTimeToCreateProject(context),
      this.scanProjectDiscovery(context),
    ];

    // Subgraph-dependent scans (only if subgraph is configured)
    if (this.subgraphGateway) {
      corePromises.push(
        this.scanBounties(context),
        this.scanCommunityFeeds(context),
        this.scanServiceListings(context),
        this.scanRepliesToOwnPosts(context),
        this.scanPotentialFriends(context),
        this.scanAttestationOpportunities(context),
        this.scanCommunityDiscovery(context),
      );
    }

    const results = await Promise.all(corePromises);

    // Deduplicate by sourceId
    const seen = new Set<string>();
    const all: Opportunity[] = [];
    for (const batch of results) {
      for (const opp of batch) {
        if (!seen.has(opp.sourceId)) {
          seen.add(opp.sourceId);
          all.push(opp);
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
    if (!this.subgraphGateway) return [];

    try {
      const data = await this.querySubgraph<{
        bounties: Array<{
          id: string;
          bountyId: string;
          metadataCid: string;
          rewardAmount: string;
          deadline: string;
          creator: { id: string };
          community: { id: string; name: string } | null;
        }>;
      }>(`
        query {
          bounties(
            where: { status: 0 }
            orderBy: createdAt
            orderDirection: desc
            first: 50
          ) {
            id
            bountyId
            metadataCid
            rewardAmount
            deadline
            creator { id }
            community { id name }
          }
        }
      `);

      const now = Math.floor(Date.now() / 1000);
      const opportunities: Opportunity[] = [];

      for (const bounty of data.bounties) {
        // Skip expired bounties
        if (parseInt(bounty.deadline, 10) > 0 && parseInt(bounty.deadline, 10) < now) {
          continue;
        }

        // Skip bounties created by this agent
        if (bounty.creator.id.toLowerCase() === context.address.toLowerCase()) {
          continue;
        }

        // Check domain relevance via community name or metadata
        const communityName = bounty.community?.name?.toLowerCase() ?? "";
        const domainMatch = context.purpose.domains.some(
          (d) => communityName.includes(d.toLowerCase()),
        );

        // Include if domain matches or if agent has broad purpose
        if (domainMatch || context.purpose.domains.length === 0) {
          const rewardWei = BigInt(bounty.rewardAmount || "0");
          // Estimate value in credits: 1 ETH ≈ 1M credits (rough proxy)
          const estimatedValue = Number(rewardWei / BigInt(1e12)) || 1000;

          opportunities.push({
            type: "bounty",
            sourceId: `bounty-${bounty.bountyId}`,
            title: `Bounty #${bounty.bountyId}${bounty.community ? ` in ${bounty.community.name}` : ""}`,
            description: `Open bounty with CID ${bounty.metadataCid}. Reward: ${rewardWei} wei.`,
            estimatedValue,
            metadata: {
              bountyId: bounty.bountyId,
              metadataCid: bounty.metadataCid,
              rewardAmount: bounty.rewardAmount,
              deadline: bounty.deadline,
              community: bounty.community?.name,
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
    if (!this.subgraphGateway) return [];

    try {
      // Query recent posts that have 0 comments (unanswered questions)
      const data = await this.querySubgraph<{
        contents: Array<{
          id: string;
          cid: string;
          author: { id: string };
          community: { id: string; name: string } | null;
          commentCount: number;
          upvoteCount: number;
          createdAt: string;
        }>;
      }>(`
        query {
          contents(
            where: { commentCount: 0 }
            orderBy: createdAt
            orderDirection: desc
            first: 30
          ) {
            id
            cid
            author { id }
            community { id name }
            commentCount
            upvoteCount
            createdAt
          }
        }
      `);

      const opportunities: Opportunity[] = [];

      for (const post of data.contents) {
        // Skip own posts
        if (post.author.id.toLowerCase() === context.address.toLowerCase()) {
          continue;
        }

        // Check domain relevance
        const communityName = post.community?.name?.toLowerCase() ?? "";
        const domainMatch = context.purpose.domains.some(
          (d) => communityName.includes(d.toLowerCase()),
        );

        if (domainMatch || context.purpose.domains.length === 0) {
          opportunities.push({
            type: "post_reply",
            sourceId: `post-${post.cid}`,
            title: `Unanswered post in ${post.community?.name ?? "general"}`,
            description: `Post CID ${post.cid} with ${post.upvoteCount} upvotes and 0 replies.`,
            estimatedValue: 100 + (post.upvoteCount * 50), // Higher value for popular unanswered posts
            metadata: {
              cid: post.cid,
              community: post.community?.name,
              upvoteCount: post.upvoteCount,
              authorAddress: post.author.id,
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
  //  Phase 4: Expanded opportunity scanners
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
    if (!this.subgraphGateway) return [];

    try {
      const data = await this.querySubgraph<{
        follows: Array<{
          id: string;
          follower: { id: string };
          timestamp: string;
        }>;
      }>(`
        query {
          follows(
            where: { followed: "${context.address.toLowerCase()}" }
            orderBy: timestamp
            orderDirection: desc
            first: 20
          ) {
            id
            follower { id }
            timestamp
          }
        }
      `);

      // Check which followers we've already acted on (followed back, sent welcome DM)
      const opportunities: Opportunity[] = [];
      for (const follow of data.follows) {
        // Skip if we already follow them back (check subgraph)
        const reverseData = await this.querySubgraph<{
          follows: Array<{ id: string }>;
        }>(`
          query {
            follows(
              where: {
                follower: "${context.address.toLowerCase()}",
                followed: "${follow.follower.id.toLowerCase()}"
              }
              first: 1
            ) { id }
          }
        `);

        if (reverseData.follows.length > 0) continue; // Already following back

        // Check if we already acted on this in proactive_actions
        const { rows: existingAction } = await this.pool.query(
          `SELECT 1 FROM proactive_actions pa
           JOIN proactive_opportunities po ON po.id = pa.opportunity_id
           WHERE pa.agent_id = $1
             AND po.source_id = $2
             AND pa.created_at > NOW() - INTERVAL '7 days'
           LIMIT 1`,
          [context.agentId, `follower-${follow.follower.id}`],
        );
        if (existingAction.length > 0) continue;

        opportunities.push({
          type: "new_follower",
          sourceId: `follower-${follow.follower.id}`,
          title: `New follower: ${follow.follower.id.slice(0, 10)}...`,
          description: `Agent ${follow.follower.id} followed you`,
          estimatedValue: 40,
          metadata: {
            followerAddress: follow.follower.id,
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
    if (!this.subgraphGateway) return [];

    try {
      // Find comments on agent's posts where the agent hasn't replied
      const data = await this.querySubgraph<{
        contents: Array<{
          cid: string;
          author: { id: string };
          parent: { cid: string; author: { id: string } } | null;
          community: { id: string; name: string } | null;
          timestamp: string;
        }>;
      }>(`
        query {
          contents(
            where: {
              parent_not: null,
              parent_: { author: "${context.address.toLowerCase()}" }
            }
            orderBy: timestamp
            orderDirection: desc
            first: 20
          ) {
            cid
            author { id }
            parent { cid author { id } }
            community { id name }
            timestamp
          }
        }
      `);

      const opportunities: Opportunity[] = [];
      for (const comment of data.contents) {
        // Skip own replies
        if (comment.author.id.toLowerCase() === context.address.toLowerCase()) continue;

        opportunities.push({
          type: "reply_to_own_post",
          sourceId: `reply-${comment.cid}`,
          title: `Reply to your post from ${comment.author.id.slice(0, 10)}...`,
          description: `New comment on your post in ${comment.community?.name ?? "general"}`,
          estimatedValue: 80,
          metadata: {
            commentCid: comment.cid,
            parentCid: comment.parent?.cid,
            authorAddress: comment.author.id,
            community: comment.community?.name,
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

      if (rows.length === 0 || !this.subgraphGateway) return [];

      // Check which of these agents we already follow
      const opportunities: Opportunity[] = [];
      for (const agent of rows) {
        try {
          const followData = await this.querySubgraph<{
            follows: Array<{ id: string }>;
          }>(`
            query {
              follows(
                where: {
                  follower: "${context.address.toLowerCase()}",
                  followed: "${agent.address.toLowerCase()}"
                }
                first: 1
              ) { id }
            }
          `);

          if (followData.follows.length > 0) continue; // Already following

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
          continue; // Skip on subgraph error for individual check
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
    if (!this.subgraphGateway) return [];

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
        // Check if we already attested this agent
        try {
          const attestData = await this.querySubgraph<{
            attestations: Array<{ id: string }>;
          }>(`
            query {
              attestations(
                where: {
                  attester: "${context.address.toLowerCase()}",
                  subject: "${agent.address.toLowerCase()}"
                }
                first: 1
              ) { id }
            }
          `);

          if (attestData.attestations.length > 0) continue; // Already attested

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
         JOIN projects p ON p.id = fc.project_id
         JOIN agents a ON a.id = fc.author_id
         WHERE (p.agent_id = $1 OR EXISTS (
           SELECT 1 FROM project_collaborators pc
           WHERE pc.project_id = p.id AND pc.agent_id = $1 AND pc.role >= 1
         ))
         AND fc.author_id != $1
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
    if (!this.subgraphGateway) return [];

    try {
      const opportunities: Opportunity[] = [];

      // 1. Query all communities from the subgraph
      const data = await this.querySubgraph<{
        communities: Array<{
          id: string;
          name: string;
          contentCount: number;
          memberCount: number;
        }>;
      }>(`
        query {
          communities(
            orderBy: contentCount
            orderDirection: desc
            first: 50
          ) {
            id
            name
            contentCount
            memberCount
          }
        }
      `);

      const communityNames = new Set<string>();

      for (const c of data.communities) {
        communityNames.add(c.name.toLowerCase());

        // Check if community topics align with agent's domains
        const matchesDomain = context.purpose.domains.some(
          (d) => c.name.toLowerCase().includes(d.toLowerCase()),
        );

        // Suggest active communities that match agent's domains
        if (matchesDomain && c.contentCount >= 1) {
          opportunities.push({
            type: "new_post_in_community",
            sourceId: `community-discovery-${c.name}`,
            title: `Active community: #${c.name}`,
            description: `Community #${c.name} has ${c.contentCount} posts and ${c.memberCount} members. Consider posting your insights here.`,
            estimatedValue: 30 + c.contentCount * 5,
            metadata: {
              community: c.name,
              contentCount: c.contentCount,
              memberCount: c.memberCount,
            },
          });
        }
      }

      // 2. Detect community gaps — agent's domains with no matching community
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

  // ---- Private helpers ----

  private async querySubgraph<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await this.subgraphGateway!.query<T>(query, variables);
    return result.data;
  }
}
