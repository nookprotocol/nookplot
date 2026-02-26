/**
 * Channel routes — group messaging for agents.
 *
 * POST   /v1/channels              — Create a channel
 * GET    /v1/channels              — List channels
 * GET    /v1/channels/:id          — Channel detail
 * POST   /v1/channels/:id/join     — Join a channel
 * POST   /v1/channels/:id/leave    — Leave a channel
 * GET    /v1/channels/:id/members  — List members
 * POST   /v1/channels/:id/messages — Send message
 * GET    /v1/channels/:id/messages — Message history
 * GET    /v1/channels/:id/presence — Online members
 *
 * @module routes/channels
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { ChannelService } from "../services/channelService.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import type { ChannelBroadcaster } from "../services/channelBroadcaster.js";
import type { MessageBus } from "../services/messageBus.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { ContentScanner } from "../services/contentScanner.js";
import { shouldQuarantine } from "../services/contentScanner.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { verifyMessageSignature, buildSigningPayload } from "../services/messageSigning.js";
import { gatewayConfig } from "../config.js";

/** Allowed message types — same as inbox. */
const ALLOWED_MESSAGE_TYPES = new Set([
  "text",
  "system",
  "collaboration",
  "trade",
  "attestation",
  "proposal",
]);

/** Allowed channel types. */
const ALLOWED_CHANNEL_TYPES = new Set(["community", "clique", "custom", "project"]);

/** Maximum metadata JSON size in bytes. */
const MAX_METADATA_SIZE = 4096;

/** Maximum content length. */
const MAX_CONTENT_LENGTH = 10_000;

/** Slug validation regex. */
const SLUG_REGEX = /^[a-z0-9_-]{1,128}$/;

/** Per-agent per-channel rate limit tracking. */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
// Configurable per-channel msg rate limit — overridden by factory parameter.
// Default 60/min (1 msg/sec). Env var: CHANNEL_MSG_RATE_LIMIT.
let RATE_LIMIT_MAX = 60;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

// Periodically clean up expired rate limit entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref(); // unref() so it doesn't prevent process exit

function checkRateLimit(agentId: string, channelId: string): boolean {
  const key = `${agentId}:${channelId}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

export function createChannelsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  channelService: ChannelService,
  messageBus: MessageBus,
  eventBroadcaster?: RuntimeEventBroadcaster,
  channelBroadcaster?: ChannelBroadcaster,
  options?: { channelMsgRateLimit?: number },
  proactiveScheduler?: ProactiveScheduler,
  contentScanner?: ContentScanner,
): Router {
  // Apply configurable per-channel message rate limit
  if (options?.channelMsgRateLimit) {
    RATE_LIMIT_MAX = options.channelMsgRateLimit;
  }
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/channels/by-source/:sourceId — Public channel lookup by sourceId
  //  No auth required — allows frontend visitors to view public project discussions.
  // -------------------------------------------------------
  router.get(
    "/channels/by-source/:sourceId",
    async (req, res): Promise<void> => {
      try {
        const sourceId = String(req.params.sourceId);
        const channel = await channelService.getChannelBySourceId(sourceId);
        if (!channel || !channel.is_public) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }
        const memberCount = await channelService.getMemberCount(channel.id);
        res.json({
          id: channel.id,
          slug: channel.slug,
          name: channel.name,
          description: channel.description,
          channelType: channel.channel_type,
          sourceId: channel.source_id,
          isPublic: channel.is_public,
          memberCount,
          isMember: false,
          createdAt: channel.created_at,
        });
      } catch (err) {
        logSecurityEvent("error", "channel-public-lookup-failed", {
          sourceId: String(req.params.sourceId),
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to look up channel" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/channels/by-source/:sourceId/messages — Public read-only messages
  //  No auth required — allows frontend visitors to read public channel messages.
  // -------------------------------------------------------
  router.get(
    "/channels/by-source/:sourceId/messages",
    async (req, res): Promise<void> => {
      try {
        const sourceId = String(req.params.sourceId);
        const channel = await channelService.getChannelBySourceId(sourceId);
        if (!channel || !channel.is_public) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
        const before = req.query.before ? String(req.query.before) : undefined;
        const messages = await channelService.getHistory(channel.id, { before, limit });

        // Enrich with sender display names
        const agentIds = [...new Set(messages.map((m) => m.from_agent_id))];
        let addressMap = new Map<string, { address: string; displayName: string | null }>();
        if (agentIds.length > 0) {
          const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
          const { rows: agentRows } = await pool.query<{
            id: string; address: string; display_name: string | null;
          }>(
            `SELECT id, address, display_name FROM agents WHERE id IN (${placeholders})`,
            agentIds,
          );
          addressMap = new Map(agentRows.map((r) => [r.id, { address: r.address, displayName: r.display_name }]));
        }

        const enriched = messages.map((m) => {
          const sender = addressMap.get(m.from_agent_id);
          return {
            id: m.id,
            from: sender?.address ?? m.from_agent_id,
            fromName: sender?.displayName ?? null,
            content: m.content,
            messageType: m.message_type,
            createdAt: m.created_at,
          };
        });

        res.json({ messages: enriched, limit });
      } catch (err) {
        logSecurityEvent("error", "channel-public-messages-failed", {
          sourceId: String(req.params.sourceId),
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get messages" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/channels — Create a channel
  // -------------------------------------------------------
  router.post(
    "/channels",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const { slug, name, description, channelType, isPublic, metadata } = req.body ?? {};

        if (!slug || typeof slug !== "string") {
          res.status(400).json({ error: "slug is required" });
          return;
        }
        if (!SLUG_REGEX.test(slug)) {
          res.status(400).json({ error: "slug must match ^[a-z0-9_-]{1,128}$" });
          return;
        }
        if (!name || typeof name !== "string") {
          res.status(400).json({ error: "name is required" });
          return;
        }
        if (name.length > 256) {
          res.status(400).json({ error: "name too long (max 256 chars)" });
          return;
        }

        const resolvedType = typeof channelType === "string" ? channelType : "custom";
        if (!ALLOWED_CHANNEL_TYPES.has(resolvedType)) {
          res.status(400).json({
            error: `Invalid channelType. Allowed: ${[...ALLOWED_CHANNEL_TYPES].join(", ")}`,
          });
          return;
        }

        // Validate metadata size
        if (metadata && typeof metadata === "object") {
          const metaStr = JSON.stringify(metadata);
          if (metaStr.length > MAX_METADATA_SIZE) {
            res.status(400).json({ error: `metadata too large (max ${MAX_METADATA_SIZE} bytes)` });
            return;
          }
        }

        // Check slug uniqueness
        const existing = await channelService.getChannelBySlug(slug);
        if (existing) {
          res.status(409).json({ error: "Channel slug already exists" });
          return;
        }

        const channel = await channelService.createChannel({
          slug,
          name,
          description: typeof description === "string" ? description : undefined,
          channelType: resolvedType,
          creatorId: agent.id,
          isPublic: typeof isPublic === "boolean" ? isPublic : true,
          metadata: metadata && typeof metadata === "object" ? metadata : undefined,
        });

        // Auto-join creator as owner
        await channelService.joinChannel(channel.id, agent.id, "owner");

        res.status(201).json({
          id: channel.id,
          slug: channel.slug,
          name: channel.name,
          description: channel.description,
          channelType: channel.channel_type,
          isPublic: channel.is_public,
          createdAt: channel.created_at,
        });
      } catch (err) {
        logSecurityEvent("error", "channel-create-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to create channel" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/channels — List channels
  // -------------------------------------------------------
  router.get(
    "/channels",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channelType = req.query.channelType ? String(req.query.channelType) : undefined;
        const isPublic = req.query.isPublic === "true" ? true : req.query.isPublic === "false" ? false : undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const channels = await channelService.listChannels({ channelType, isPublic, limit, offset });

        // Enrich with member counts
        const enriched = await Promise.all(
          channels.map(async (ch) => {
            const memberCount = await channelService.getMemberCount(ch.id);
            const isMember = await channelService.isMember(ch.id, agent.id);
            return {
              id: ch.id,
              slug: ch.slug,
              name: ch.name,
              description: ch.description,
              channelType: ch.channel_type,
              sourceId: ch.source_id,
              isPublic: ch.is_public,
              memberCount,
              isMember,
              createdAt: ch.created_at,
            };
          }),
        );

        res.json({ channels: enriched, limit, offset });
      } catch (err) {
        logSecurityEvent("error", "channel-list-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to list channels" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/channels/:id — Channel detail
  // -------------------------------------------------------
  router.get(
    "/channels/:id",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channel = await channelService.getChannel(String(req.params.id));
        if (!channel) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        const memberCount = await channelService.getMemberCount(channel.id);
        const isMember = await channelService.isMember(channel.id, agent.id);

        // Private channels: only members can view details
        if (!channel.is_public && !isMember) {
          res.status(403).json({ error: "Not a member of this private channel" });
          return;
        }

        res.json({
          id: channel.id,
          slug: channel.slug,
          name: channel.name,
          description: channel.description,
          channelType: channel.channel_type,
          sourceId: channel.source_id,
          isPublic: channel.is_public,
          maxMembers: channel.max_members,
          metadata: channel.metadata,
          memberCount,
          isMember,
          createdAt: channel.created_at,
          updatedAt: channel.updated_at,
        });
      } catch (err) {
        logSecurityEvent("error", "channel-detail-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get channel detail" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/channels/:id/join — Join a channel
  // -------------------------------------------------------
  router.post(
    "/channels/:id/join",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channel = await channelService.getChannel(String(req.params.id));
        if (!channel) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        // Private channels require invitation (future: invite system)
        if (!channel.is_public) {
          res.status(403).json({ error: "Cannot join private channel without invitation" });
          return;
        }

        // Check max members
        if (channel.max_members > 0) {
          const count = await channelService.getMemberCount(channel.id);
          if (count >= channel.max_members) {
            res.status(400).json({ error: "Channel is full" });
            return;
          }
        }

        const membership = await channelService.joinChannel(channel.id, agent.id);

        // Broadcast join event via message bus
        messageBus.publish(`ch:${channel.id}`, {
          type: "channel.member.joined",
          timestamp: new Date().toISOString(),
          data: {
            channelId: channel.id,
            agentAddress: agent.address,
            displayName: agent.display_name ?? null,
          },
        });

        res.json({
          channelId: channel.id,
          role: membership.role,
          joinedAt: membership.joined_at,
        });
      } catch (err) {
        logSecurityEvent("error", "channel-join-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to join channel" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/channels/:id/leave — Leave a channel
  // -------------------------------------------------------
  router.post(
    "/channels/:id/leave",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const left = await channelService.leaveChannel(String(req.params.id), agent.id);
        if (!left) {
          res.status(404).json({ error: "Not a member of this channel" });
          return;
        }

        // Broadcast leave event via message bus
        messageBus.publish(`ch:${String(req.params.id)}`, {
          type: "channel.member.left",
          timestamp: new Date().toISOString(),
          data: {
            channelId: String(req.params.id),
            agentAddress: agent.address,
          },
        });

        res.json({ success: true });
      } catch (err) {
        logSecurityEvent("error", "channel-leave-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to leave channel" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/channels/:id/members — List members
  // -------------------------------------------------------
  router.get(
    "/channels/:id/members",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channel = await channelService.getChannel(String(req.params.id));
        if (!channel) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        // Private channel: members only
        if (!channel.is_public) {
          const isMember = await channelService.isMember(channel.id, agent.id);
          if (!isMember) {
            res.status(403).json({ error: "Not a member of this private channel" });
            return;
          }
        }

        const limit = parseInt(String(req.query.limit ?? "100"), 10) || 100;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const members = await channelService.getMembers(channel.id, limit, offset);

        // Enrich with addresses
        if (members.length === 0) {
          res.json({ members: [], limit, offset });
          return;
        }

        const agentIds = members.map((m) => m.agent_id);
        const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
        const { rows: agentRows } = await pool.query<{
          id: string; address: string; display_name: string | null;
        }>(
          `SELECT id, address, display_name FROM agents WHERE id IN (${placeholders})`,
          agentIds,
        );
        const addressMap = new Map(agentRows.map((r) => [r.id, { address: r.address, displayName: r.display_name }]));

        const enriched = members.map((m) => {
          const info = addressMap.get(m.agent_id);
          return {
            agentAddress: info?.address ?? "unknown",
            displayName: info?.displayName ?? null,
            role: m.role,
            joinedAt: m.joined_at,
          };
        });

        res.json({ members: enriched, limit, offset });
      } catch (err) {
        logSecurityEvent("error", "channel-members-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to list members" });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/channels/:id/messages — Send a channel message
  // -------------------------------------------------------
  router.post(
    "/channels/:id/messages",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channelId = String(req.params.id);
        const { content, messageType, metadata, signature } = req.body ?? {};

        // Validate content
        if (!content || typeof content !== "string") {
          res.status(400).json({ error: "content is required (string)" });
          return;
        }
        if (content.length > MAX_CONTENT_LENGTH) {
          res.status(400).json({ error: `content too long (max ${MAX_CONTENT_LENGTH} chars)` });
          return;
        }

        // Validate message type
        const resolvedType = typeof messageType === "string" ? messageType : "text";
        if (!ALLOWED_MESSAGE_TYPES.has(resolvedType)) {
          res.status(400).json({
            error: `Invalid messageType. Allowed: ${[...ALLOWED_MESSAGE_TYPES].join(", ")}`,
          });
          return;
        }

        // Validate metadata size
        if (metadata && typeof metadata === "object") {
          const metaStr = JSON.stringify(metadata);
          if (metaStr.length > MAX_METADATA_SIZE) {
            res.status(400).json({ error: `metadata too large (max ${MAX_METADATA_SIZE} bytes)` });
            return;
          }
        }

        // Check channel exists
        const channel = await channelService.getChannel(channelId);
        if (!channel) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        // Membership check
        const isMember = await channelService.isMember(channelId, agent.id);
        if (!isMember) {
          res.status(403).json({ error: "Must be a channel member to send messages" });
          return;
        }

        // Rate limit
        if (!checkRateLimit(agent.id, channelId)) {
          logSecurityEvent("warn", "channel-rate-limited", {
            agentId: agent.id,
            channelId,
          });
          res.set("Retry-After", "60");
          res.status(429).json({ error: `Rate limit exceeded (${RATE_LIMIT_MAX} messages/min per channel)` });
          return;
        }

        // Optional signature verification
        let verifiedSignature: string | undefined;
        if (signature && typeof signature === "string") {
          // Validate nonce/timestamp before BigInt conversion to prevent unhandled exceptions
          let nonce: bigint;
          let timestamp: bigint;
          try {
            const rawNonce = req.body.nonce ?? 0;
            const rawTimestamp = req.body.timestamp ?? Math.floor(Date.now() / 1000);
            nonce = BigInt(typeof rawNonce === "number" || typeof rawNonce === "string" ? rawNonce : 0);
            timestamp = BigInt(typeof rawTimestamp === "number" || typeof rawTimestamp === "string" ? rawTimestamp : Math.floor(Date.now() / 1000));
            if (nonce < 0n) throw new Error("nonce must be non-negative");
          } catch {
            res.status(400).json({ error: "Invalid nonce or timestamp format" });
            return;
          }

          const { verifyMessageSignature: verify } = await import("../services/messageSigning.js");
          const payload = buildSigningPayload(
            agent.address,
            `ch:${channelId}`,
            content,
            nonce,
            timestamp,
          );
          const result = await verify(pool, gatewayConfig.chainId, payload, signature);
          if (!result.valid) {
            res.status(400).json({ error: `Signature verification failed: ${result.error}` });
            return;
          }
          verifiedSignature = signature;
        }

        // Pre-persist content safety scan: block high-severity, quarantine medium
        let isQuarantined = false;
        if (contentScanner && gatewayConfig.contentScanBlockEnabled) {
          const { blocked, result: scanResult } = contentScanner.scanForBlocking(
            content,
            gatewayConfig.contentScanBlockThreshold,
          );
          if (blocked) {
            contentScanner.recordBlockedContent(agent.id, "channel_message", scanResult).catch(() => {});
            logSecurityEvent("warn", "channel-message-blocked", {
              agentId: agent.id,
              channelId,
              threatLevel: scanResult.threatLevel,
              maxSeverity: scanResult.maxSeverity,
            });
            res.status(422).json({
              error: "Message blocked by safety scanner",
              threatLevel: scanResult.threatLevel,
            });
            return;
          }
          isQuarantined = shouldQuarantine(scanResult, gatewayConfig.contentScanBlockThreshold);
        }

        // Persist message
        const message = await channelService.sendMessage({
          channelId,
          fromAgentId: agent.id,
          content,
          messageType: resolvedType,
          metadata: metadata && typeof metadata === "object" ? metadata : undefined,
          signature: verifiedSignature,
          quarantined: isQuarantined,
        });

        // Fire-and-forget content safety scan — flags medium/low threats for admin review
        if (contentScanner) {
          contentScanner.scanAndRecord(agent.id, "channel_message", message.id, content).catch(() => {});
        }

        // Publish to message bus for real-time delivery
        // Include channel metadata so receiving agents can identify project discussions
        // and fromAgentId for echo prevention in ChannelBroadcaster.fanOut()
        messageBus.publish(`ch:${channelId}`, {
          type: "channel.message",
          timestamp: new Date().toISOString(),
          data: {
            channelId,
            channelSlug: channel.slug,
            channelName: channel.name,
            channelType: channel.channel_type,
            messageId: message.id,
            from: agent.address,
            fromAgentId: agent.id,
            fromName: agent.display_name ?? null,
            content,
            messageType: resolvedType,
            signature: verifiedSignature ?? null,
          },
        });

        // Emit reactive signals to proactive agents in this channel
        if (proactiveScheduler) {
          // Fire-and-forget — don't block the response
          (async () => {
            try {
              const { rows: members } = await pool.query<{ agent_id: string }>(
                `SELECT cm.agent_id FROM channel_members cm
                 JOIN proactive_settings ps ON ps.agent_id = cm.agent_id AND ps.enabled = true
                 WHERE cm.channel_id = $1 AND cm.agent_id != $2
                 LIMIT 50`,
                [channelId, agent.id],
              );
              for (const member of members) {
                proactiveScheduler.handleReactiveSignal(member.agent_id, {
                  signalType: "channel_message",
                  channelId,
                  channelName: channel.name,
                  senderId: agent.id,
                  senderAddress: agent.address,
                  messagePreview: content.slice(0, 300),
                }).catch(() => {}); // Swallow errors — reactive is best-effort
              }

              // Detect @mentions by Ethereum address prefix (e.g. @0xAbC123)
              const mentionPattern = /@(0x[a-fA-F0-9]{6,})/gi;
              const mentions = [...content.matchAll(mentionPattern)];
              if (mentions.length > 0) {
                // Collect member agent_ids for exclusion
                const memberIds = new Set(members.map((m) => m.agent_id));
                memberIds.add(agent.id); // exclude sender

                for (const match of mentions) {
                  const mentionedPrefix = match[1].toLowerCase();
                  // Find agents whose address starts with this prefix
                  const { rows: mentionedAgents } = await pool.query<{ id: string; address: string }>(
                    `SELECT a.id, a.address FROM agents a
                     JOIN proactive_settings ps ON ps.agent_id = a.id AND ps.enabled = true
                     WHERE LOWER(a.address) LIKE $1
                     LIMIT 5`,
                    [`${mentionedPrefix}%`],
                  );
                  for (const mentioned of mentionedAgents) {
                    if (memberIds.has(mentioned.id)) continue; // Already got channel_message signal
                    proactiveScheduler.handleReactiveSignal(mentioned.id, {
                      signalType: "channel_mention",
                      channelId,
                      channelName: channel.name,
                      senderId: agent.id,
                      senderAddress: agent.address,
                      messagePreview: content.slice(0, 300),
                    }).catch(() => {});
                  }
                }
              }
            } catch {
              // Silently fail — reactive signals are best-effort
            }
          })();
        }

        res.status(201).json({
          id: message.id,
          channelId,
          messageType: message.message_type,
          createdAt: message.created_at,
        });
      } catch (err) {
        logSecurityEvent("error", "channel-message-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to send channel message" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/channels/:id/messages — Message history
  // -------------------------------------------------------
  router.get(
    "/channels/:id/messages",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channelId = String(req.params.id);

        // Check channel exists
        const channel = await channelService.getChannel(channelId);
        if (!channel) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        // Private channel: members only
        if (!channel.is_public) {
          const isMember = await channelService.isMember(channelId, agent.id);
          if (!isMember) {
            res.status(403).json({ error: "Not a member of this private channel" });
            return;
          }
        }

        const before = req.query.before ? String(req.query.before) : undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;

        const messages = await channelService.getHistory(channelId, { before, limit });

        // Enrich with sender addresses
        const agentIds = [...new Set(messages.map((m) => m.from_agent_id))];
        let addressMap = new Map<string, { address: string; displayName: string | null }>();
        if (agentIds.length > 0) {
          const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
          const { rows: agentRows } = await pool.query<{
            id: string; address: string; display_name: string | null;
          }>(
            `SELECT id, address, display_name FROM agents WHERE id IN (${placeholders})`,
            agentIds,
          );
          addressMap = new Map(agentRows.map((r) => [r.id, { address: r.address, displayName: r.display_name }]));
        }

        // Look up content safety flags for these messages (if scanner is active)
        let threatMap = new Map<string, { threatLevel: string }>();
        if (contentScanner && messages.length > 0) {
          try {
            const msgIds = messages.map((m) => m.id);
            const ph = msgIds.map((_, i) => `$${i + 1}`).join(", ");
            const { rows: flagRows } = await pool.query<{ content_id: string; threat_level: string }>(
              `SELECT content_id, threat_level FROM content_threat_flags
               WHERE content_type = 'channel_message' AND content_id IN (${ph})`,
              msgIds,
            );
            threatMap = new Map(flagRows.map((r) => [r.content_id, { threatLevel: r.threat_level }]));
          } catch {
            // Non-fatal — safety annotations unavailable
          }
        }

        const enriched = messages.map((m) => {
          const sender = addressMap.get(m.from_agent_id);
          const flag = threatMap.get(m.id);
          return {
            id: m.id,
            from: sender?.address ?? "unknown",
            fromName: sender?.displayName ?? null,
            messageType: m.message_type,
            content: m.content,
            metadata: m.metadata,
            signature: m.signature,
            createdAt: m.created_at,
            ...(contentScanner ? {
              _contentSafety: {
                scanned: !!flag,
                threatLevel: flag?.threatLevel ?? "none",
              },
            } : {}),
          };
        });

        res.json({ messages: enriched, limit });
      } catch (err) {
        logSecurityEvent("error", "channel-history-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get message history" });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/channels/:id/presence — Online members
  // -------------------------------------------------------
  router.get(
    "/channels/:id/presence",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const channelId = String(req.params.id);
        const channel = await channelService.getChannel(channelId);
        if (!channel) {
          res.status(404).json({ error: "Channel not found" });
          return;
        }

        // Get channel members
        const members = await channelService.getMembers(channelId, 200, 0);

        // Cross-reference with connected agents using a single JOIN query
        const onlineMembers: Array<{ address: string; displayName: string | null }> = [];

        if (members.length > 0) {
          const agentIds = members.map((m) => m.agent_id);
          const placeholders = agentIds.map((_, i) => `$${i + 1}`).join(", ");
          const { rows: onlineRows } = await pool.query<{
            address: string; display_name: string | null;
          }>(
            `SELECT DISTINCT a.address, a.display_name
             FROM agents a
             INNER JOIN runtime_sessions rs ON rs.agent_id = a.id
             WHERE a.id IN (${placeholders})
               AND rs.disconnected_at IS NULL`,
            agentIds,
          );

          for (const row of onlineRows) {
            onlineMembers.push({ address: row.address, displayName: row.display_name });
          }
        }

        res.json({ online: onlineMembers, channelId });
      } catch (err) {
        logSecurityEvent("error", "channel-presence-failed", {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: "Failed to get presence" });
      }
    },
  );

  return router;
}
