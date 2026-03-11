/**
 * Credit-based hiring routes for the marketplace.
 *
 * These endpoints let users create and manage off-chain, credit-based
 * agreements with service providers — no on-chain escrow needed.
 *
 * @module routes/creditHire
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { createAuthMiddleware } from "../middleware/auth.js";
import type { AuthenticatedRequest } from "../types.js";
import type { CreditHireService } from "../services/creditHireService.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { handleRouteError } from "../utils/safeError.js";

export function createCreditHireRouter(
  pool: pg.Pool,
  hmacSecret: string,
  creditHireService: CreditHireService,
) {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** POST /v1/marketplace/credit-hire — Create a credit-based agreement. */
  router.post("/marketplace/credit-hire", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const agent = req.agent!;
    const { listingId, terms, creditAmount } = req.body ?? {};

    if (!listingId || typeof listingId !== "number") {
      res.status(400).json({ error: "Missing or invalid listingId (must be a number)" });
      return;
    }
    if (!terms || typeof terms !== "string") {
      res.status(400).json({ error: "Missing or invalid terms" });
      return;
    }
    if (!creditAmount || typeof creditAmount !== "number" || creditAmount <= 0) {
      res.status(400).json({ error: "Missing or invalid creditAmount (must be a positive number)" });
      return;
    }

    try {
      const agreement = await creditHireService.createAgreement(
        listingId,
        agent.id,
        terms,
        creditAmount,
      );
      res.status(201).json(agreement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "INSUFFICIENT_CREDITS") {
        res.status(402).json({ error: "Insufficient credits" });
      } else if (msg === "SELF_HIRE_BLOCKED") {
        res.status(400).json({ error: "Cannot hire yourself" });
      } else if (msg === "ACCOUNT_NOT_FOUND") {
        res.status(404).json({ error: "Credit account not found" });
      } else {
        logSecurityEvent("error", "credit-hire-create-error", { agentId: agent.id, error: msg });
        res.status(500).json({ error: "Failed to create agreement" });
      }
    }
  });

  /** POST /v1/marketplace/credit-agreements/:id/accept — Provider accepts. */
  router.post("/marketplace/credit-agreements/:id/accept", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const agreement = await creditHireService.acceptAgreement(req.params.id as string, req.agent!.id);
      res.json(agreement);
    } catch (err) {
      handleRouteError(res, err, "credit-agreement-accept-failed", "Failed to accept agreement.", 400);
    }
  });

  /** POST /v1/marketplace/credit-agreements/:id/deliver — Provider delivers. */
  router.post("/marketplace/credit-agreements/:id/deliver", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { notes } = req.body ?? {};
    if (!notes || typeof notes !== "string") {
      res.status(400).json({ error: "Missing delivery notes" });
      return;
    }

    try {
      const agreement = await creditHireService.deliverWork(req.params.id as string, req.agent!.id, notes);
      res.json(agreement);
    } catch (err) {
      handleRouteError(res, err, "credit-agreement-deliver-failed", "Failed to deliver work.", 400);
    }
  });

  /** POST /v1/marketplace/credit-agreements/:id/complete — Buyer approves. */
  router.post("/marketplace/credit-agreements/:id/complete", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const agreement = await creditHireService.completeAgreement(req.params.id as string, req.agent!.id);
      res.json(agreement);
    } catch (err) {
      handleRouteError(res, err, "credit-agreement-complete-failed", "Failed to complete agreement.", 400);
    }
  });

  /** POST /v1/marketplace/credit-agreements/:id/cancel — Cancel (pre-delivery). */
  router.post("/marketplace/credit-agreements/:id/cancel", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const agreement = await creditHireService.cancelAgreement(req.params.id as string, req.agent!.id);
      res.json(agreement);
    } catch (err) {
      handleRouteError(res, err, "credit-agreement-cancel-failed", "Failed to cancel agreement.", 400);
    }
  });

  /** POST /v1/marketplace/credit-agreements/:id/dispute — Dispute. */
  router.post("/marketplace/credit-agreements/:id/dispute", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== "string") {
      res.status(400).json({ error: "Missing dispute reason" });
      return;
    }

    try {
      const agreement = await creditHireService.disputeAgreement(req.params.id as string, req.agent!.id, reason);
      res.json(agreement);
    } catch (err) {
      handleRouteError(res, err, "credit-agreement-dispute-failed", "Failed to dispute agreement.", 400);
    }
  });

  /** GET /v1/marketplace/credit-agreements — My agreements. */
  router.get("/marketplace/credit-agreements", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    const role = req.query.role as "buyer" | "provider" | undefined;
    try {
      const agreements = await creditHireService.getAgreements(req.agent!.id, role);
      res.json(agreements);
    } catch (err) {
      handleRouteError(res, err, "credit-agreements-list-failed", "Failed to list agreements.");
    }
  });

  /** GET /v1/marketplace/credit-agreements/:id — Agreement detail. */
  router.get("/marketplace/credit-agreements/:id", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const agreement = await creditHireService.getAgreementDetail(req.params.id as string);
      if (!agreement) {
        res.status(404).json({ error: "Agreement not found" });
        return;
      }
      res.json(agreement);
    } catch (err) {
      handleRouteError(res, err, "credit-agreement-detail-failed", "Failed to fetch agreement details.");
    }
  });

  return router;
}
