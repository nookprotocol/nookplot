/**
 * Webhook routes — inbound webhook receiver + management endpoints.
 *
 * POST   /v1/webhooks/:address/:source   — Public inbound webhook (HMAC verified)
 * POST   /v1/agents/me/webhooks          — Register a webhook source
 * GET    /v1/agents/me/webhooks          — List webhook registrations
 * DELETE /v1/agents/me/webhooks/:source  — Remove a webhook registration
 * GET    /v1/agents/me/webhooks/log      — Webhook event log
 *
 * @module routes/webhooks
 */

import { Router } from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { WebhookManager, WebhookError } from "../services/webhookManager.js";
import { createAuthMiddleware, registeredMiddleware, ownerOnlyMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

/** Rate limiter for the public inbound webhook endpoint (per address+source). */
const webhookInboundLimiter = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const address = String(req.params.address).toLowerCase();
    const source = String(req.params.source).toLowerCase();
    return `wh:${address}:${source}`;
  },
  message: {
    error: "Too many webhook requests",
    message: "Rate limit exceeded. Maximum 100 webhook deliveries per minute per source.",
  },
});

export function createWebhooksRouter(
  pool: pg.Pool,
  hmacSecret: string,
  webhookManager: WebhookManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // ============================================================
  //  Public inbound webhook receiver (NO auth — HMAC verified)
  // ============================================================

  /**
   * POST /v1/webhooks/:address/:source
   *
   * External services POST here to trigger agent events.
   * Verification is done by the WebhookManager (HMAC + replay protection).
   */
  router.post(
    "/webhooks/:address/:source",
    webhookInboundLimiter,
    async (req: Request, res: Response) => {
      try {
        const agentAddress = String(req.params.address);
        const source = String(req.params.source);

        // Collect raw body as string
        const body = typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});

        // Flatten headers to Record<string, string>
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers[key.toLowerCase()] = value;
          } else if (Array.isArray(value)) {
            headers[key.toLowerCase()] = value[0];
          }
        }

        await webhookManager.handleIncoming(agentAddress, source, headers, body);

        res.json({ ok: true });
      } catch (error) {
        if (error instanceof WebhookError) {
          if (error.retryAfter) {
            res.set("Retry-After", error.retryAfter);
          }
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        logSecurityEvent("warn", "webhook-handler-error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal webhook processing error" });
      }
    },
  );

  // ============================================================
  //  Authenticated webhook management endpoints
  // ============================================================

  /**
   * POST /v1/agents/me/webhooks — Register a webhook source.
   */
  router.post(
    "/agents/me/webhooks",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const { source, config } = req.body;

        if (!source || typeof source !== "string") {
          res.status(400).json({ error: "source is required (string)" });
          return;
        }

        // Validate config fields if provided
        const cfg = config ?? {};
        if (typeof cfg !== "object" || Array.isArray(cfg)) {
          res.status(400).json({ error: "config must be an object" });
          return;
        }
        if (cfg.secret !== undefined && (typeof cfg.secret !== "string" || cfg.secret.length > 500)) {
          res.status(400).json({ error: "config.secret must be a string (max 500 chars)" });
          return;
        }
        if (cfg.signatureHeader !== undefined && (typeof cfg.signatureHeader !== "string" || cfg.signatureHeader.length > 100)) {
          res.status(400).json({ error: "config.signatureHeader must be a string (max 100 chars)" });
          return;
        }
        if (cfg.timestampHeader !== undefined && (typeof cfg.timestampHeader !== "string" || cfg.timestampHeader.length > 100)) {
          res.status(400).json({ error: "config.timestampHeader must be a string (max 100 chars)" });
          return;
        }
        if (cfg.maxAgeSeconds !== undefined && (typeof cfg.maxAgeSeconds !== "number" || cfg.maxAgeSeconds < 30 || cfg.maxAgeSeconds > 86400)) {
          res.status(400).json({ error: "config.maxAgeSeconds must be a number between 30 and 86400" });
          return;
        }
        if (cfg.eventMapping !== undefined) {
          if (typeof cfg.eventMapping !== "object" || Array.isArray(cfg.eventMapping)) {
            res.status(400).json({ error: "config.eventMapping must be an object" });
            return;
          }
          if (Object.keys(cfg.eventMapping).length > 50) {
            res.status(400).json({ error: "config.eventMapping: max 50 entries" });
            return;
          }
        }

        const registration = await webhookManager.register(
          agentId,
          source,
          cfg,
        );

        // Build the webhook URL for the user
        const protocol = req.protocol;
        const host = req.get("host") ?? "localhost";
        const webhookUrl = `${protocol}://${host}/v1/webhooks/${req.agent!.address}/${source}`;

        res.status(201).json({
          data: {
            ...registration,
            webhookUrl,
          },
        });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "Failed to register webhook",
        });
      }
    },
  );

  /**
   * GET /v1/agents/me/webhooks — List webhook registrations.
   */
  router.get(
    "/agents/me/webhooks",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const registrations = await webhookManager.list(agentId);

        // Add webhook URLs
        const protocol = req.protocol;
        const host = req.get("host") ?? "localhost";

        const data = registrations.map((r) => ({
          ...r,
          webhookUrl: `${protocol}://${host}/v1/webhooks/${req.agent!.address}/${r.source}`,
        }));

        res.json({ data });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to list webhooks",
        });
      }
    },
  );

  /**
   * DELETE /v1/agents/me/webhooks/:source — Remove a webhook registration.
   */
  router.delete(
    "/agents/me/webhooks/:source",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const source = String(req.params.source);

        const removed = await webhookManager.remove(agentId, source);
        if (!removed) {
          res.status(404).json({ error: "Webhook registration not found" });
          return;
        }

        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to remove webhook",
        });
      }
    },
  );

  /**
   * GET /v1/agents/me/webhooks/log — Webhook event log.
   */
  router.get(
    "/agents/me/webhooks/log",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const agentId = req.agent!.id;
        const rawPage = parseInt(String(req.query.page ?? "0"), 10);
        const page = isNaN(rawPage) || rawPage < 0 ? 0 : Math.min(rawPage, 10000);

        const entries = await webhookManager.getEventLog(agentId, page);

        res.json({ data: entries, page });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Failed to get webhook log",
        });
      }
    },
  );

  return router;
}
