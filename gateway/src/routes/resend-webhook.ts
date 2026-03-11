/**
 * Resend webhook routes — inbound email, bounces, complaints, delivery.
 *
 * POST /v1/webhooks/resend — all Resend events (dispatched by type)
 *
 * No auth — webhook signature verified via svix.
 * Feature-gated behind EMAIL_ENABLED.
 *
 * @module routes/resend-webhook
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { Webhook } from "svix";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { EmailService, ResendInboundPayload } from "../services/emailService.js";

export function createResendWebhookRouter(
  emailService: EmailService,
  webhookSecret: string,
): Router {
  const router = Router();

  router.post("/webhooks/resend", async (req: Request, res: Response): Promise<void> => {
    try {
      // Verify webhook signature via svix
      const svixId = req.headers["svix-id"] as string;
      const svixTimestamp = req.headers["svix-timestamp"] as string;
      const svixSignature = req.headers["svix-signature"] as string;

      if (!svixId || !svixTimestamp || !svixSignature) {
        logSecurityEvent("warn", "resend-webhook-missing-headers", {});
        res.status(400).json({ error: "Missing svix headers" });
        return;
      }

      // req.body is a raw Buffer (express.raw() registered before express.json() in server.ts).
      // Use the exact bytes for svix signature verification — JSON.stringify re-serialization
      // can alter whitespace/escaping and cause verification failures.
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : (typeof req.body === "string" ? req.body : JSON.stringify(req.body));

      let payload: Record<string, unknown>;
      try {
        const wh = new Webhook(webhookSecret);
        payload = wh.verify(rawBody, {
          "svix-id": svixId,
          "svix-timestamp": svixTimestamp,
          "svix-signature": svixSignature,
        }) as Record<string, unknown>;
      } catch {
        logSecurityEvent("warn", "resend-webhook-invalid-signature", {});
        res.status(403).json({ error: "Invalid webhook signature" });
        return;
      }

      const eventType = payload.type as string;

      switch (eventType) {
        case "email.received": {
          const data = payload.data as ResendInboundPayload;
          emailService.processInboundEmail(data).catch((err) => {
            logSecurityEvent("error", "resend-webhook-inbound-failed", {
              error: (err as Error).message,
              emailId: data.email_id,
            });
          });
          break;
        }

        case "email.bounced": {
          const data = payload.data as Record<string, unknown>;
          emailService.processBounceNotification(data).catch((err) => {
            logSecurityEvent("error", "resend-webhook-bounce-failed", {
              error: (err as Error).message,
            });
          });
          break;
        }

        case "email.complained": {
          const data = payload.data as Record<string, unknown>;
          emailService.processComplaintNotification(data).catch((err) => {
            logSecurityEvent("error", "resend-webhook-complaint-failed", {
              error: (err as Error).message,
            });
          });
          break;
        }

        case "email.delivered":
          // Delivery confirmation — no action needed, already stored as 'delivered'
          break;

        default:
          logSecurityEvent("info", "resend-webhook-unknown-event", { type: eventType });
          break;
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logSecurityEvent("error", "resend-webhook-error", { error: (err as Error).message });
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}
