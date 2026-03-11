/**
 * @module routes/teaching
 * REST endpoints for the Teaching Exchange System.
 */
import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import {
  createAuthMiddleware,
  registeredMiddleware,
  ownerOnlyMiddleware,
} from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type {
  TeachingExchangeService,
  OfferingType,
} from "../services/teachingExchangeService.js";
import type { EmbeddingService } from "../services/embeddingService.js";

const VALID_OFFERING_TYPES: ReadonlySet<string> = new Set([
  "bundle", "community", "channel", "guild", "project", "insight",
]);

export function createTeachingRouter(
  pool: pg.Pool,
  hmacSecret: string,
  teachingService: TeachingExchangeService,
  embeddingService?: EmbeddingService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // ─── Lifecycle Endpoints ────────────────────────────────────────────────

  /** Propose a teaching exchange. */
  router.post(
    "/teaching/propose",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const agent = req.agent!;
        const { learnerAddress, goal, offerings } = req.body;

        if (!learnerAddress || typeof learnerAddress !== "string") {
          res.status(400).json({ error: "learnerAddress is required" });
          return;
        }
        if (!goal || typeof goal !== "string" || goal.trim().length === 0) {
          res.status(400).json({ error: "goal is required" });
          return;
        }
        if (!Array.isArray(offerings) || offerings.length === 0) {
          res.status(400).json({ error: "At least one offering is required" });
          return;
        }

        // Validate offering types
        for (const off of offerings) {
          if (!off.type || !VALID_OFFERING_TYPES.has(off.type)) {
            res.status(400).json({ error: `Invalid offering type: ${off.type}` });
            return;
          }
        }

        // Resolve learner agent ID from address
        const { rows: learnerRows } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [learnerAddress],
        );
        if (learnerRows.length === 0) {
          res.status(404).json({ error: "Learner agent not found" });
          return;
        }
        const learnerId = learnerRows[0].id;

        const result = await teachingService.propose({
          teacherId: agent.id,
          learnerId,
          goal: goal.trim(),
          offerings: offerings.map((o: { type: OfferingType; referenceId?: string; insightCid?: string; description?: string }) => ({
            type: o.type,
            referenceId: o.referenceId,
            insightCid: o.insightCid,
            description: o.description,
          })),
        });

        // Fire-and-forget: embed teaching exchange goal for knowledge search
        if (embeddingService && result.exchange?.id) {
          embeddingService.embedAndStore("teaching", String(result.exchange.id), goal.trim()).catch(() => {});
        }

        res.status(201).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Cannot teach yourself" || message === "Learner not found") {
          res.status(400).json({ error: message });
          return;
        }
        if (message === "INSUFFICIENT_CREDITS") {
          res.status(402).json({ error: "Insufficient credits to propose teaching" });
          return;
        }
        logSecurityEvent("error", "teaching-propose-failed", { error: message });
        res.status(500).json({ error: "Failed to propose teaching exchange" });
      }
    },
  );

  /** Accept a proposed teaching exchange. */
  router.post(
    "/teaching/:id/accept",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const exchange = await teachingService.accept(req.params.id as string, req.agent!.id);
        res.json({ exchange });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not in") || message === "Not authorized for this exchange" || message === "Exchange not found") {
          res.status(400).json({ error: message });
          return;
        }
        if (message === "INSUFFICIENT_CREDITS") {
          res.status(402).json({ error: "Insufficient credits to accept teaching" });
          return;
        }
        logSecurityEvent("error", "teaching-accept-failed", { error: message });
        res.status(500).json({ error: "Failed to accept teaching exchange" });
      }
    },
  );

  /** Mark teaching as delivered. */
  router.post(
    "/teaching/:id/deliver",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { notes } = req.body;
        const exchange = await teachingService.deliver(req.params.id as string, req.agent!.id, notes);
        res.json({ exchange });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not in") || message === "Not authorized for this exchange" || message === "Exchange not found") {
          res.status(400).json({ error: message });
          return;
        }
        logSecurityEvent("error", "teaching-deliver-failed", { error: message });
        res.status(500).json({ error: "Failed to mark delivery" });
      }
    },
  );

  /** Approve a delivered teaching (learner). */
  router.post(
    "/teaching/:id/approve",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { feedback, rating } = req.body;
        const parsedRating = rating !== undefined ? parseInt(String(rating), 10) : undefined;
        const exchange = await teachingService.approve(req.params.id as string, req.agent!.id, feedback, parsedRating);
        res.json({ exchange });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("not in") ||
          message === "Not authorized for this exchange" ||
          message === "Exchange not found" ||
          message.startsWith("Rating must be")
        ) {
          res.status(400).json({ error: message });
          return;
        }
        logSecurityEvent("error", "teaching-approve-failed", { error: message });
        res.status(500).json({ error: "Failed to approve teaching" });
      }
    },
  );

  /** Reject a delivered teaching (learner). */
  router.post(
    "/teaching/:id/reject",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { feedback } = req.body;
        const exchange = await teachingService.reject(req.params.id as string, req.agent!.id, feedback);
        res.json({ exchange });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not in") || message === "Not authorized for this exchange" || message === "Exchange not found") {
          res.status(400).json({ error: message });
          return;
        }
        logSecurityEvent("error", "teaching-reject-failed", { error: message });
        res.status(500).json({ error: "Failed to reject teaching" });
      }
    },
  );

  // ─── Query Endpoints ──────────────────────────────────────────────────────

  /** List my teaching exchanges. */
  router.get(
    "/teaching/exchanges",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const role = (req.query.role as string) || "both";
        const status = req.query.status as string | undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const result = await teachingService.listExchanges({
          agentId: req.agent!.id,
          role: role as "teacher" | "learner" | "both",
          status: status as any,
          limit,
          offset,
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-list-failed", { error: message });
        res.status(500).json({ error: "Failed to list exchanges" });
      }
    },
  );

  /** Get exchange detail with offerings. */
  router.get(
    "/teaching/exchanges/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const result = await teachingService.getExchange(req.params.id as string);
        if (!result) {
          res.status(404).json({ error: "Exchange not found" });
          return;
        }
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-get-failed", { error: message });
        res.status(500).json({ error: "Failed to get exchange" });
      }
    },
  );

  /** Search for teachers matching a goal. */
  router.get(
    "/teaching/search-teachers",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const goal = req.query.goal as string;
        if (!goal || goal.trim().length === 0) {
          res.status(400).json({ error: "goal query parameter is required" });
          return;
        }
        const limit = parseInt(String(req.query.limit ?? "10"), 10) || 10;

        const teachers = await teachingService.searchTeachers(goal.trim(), limit);

        // Indicate if a gap signal should be shown (few/no results)
        const gapSignal = teachers.length < 3;

        res.json({ teachers, gapSignal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-search-failed", { error: message });
        res.status(500).json({ error: "Failed to search teachers" });
      }
    },
  );

  /** Get my teaching stats. */
  router.get(
    "/teaching/stats",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const stats = await teachingService.getStats(req.agent!.id);
        res.json({ stats: stats ?? defaultStats(req.agent!.id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-stats-failed", { error: message });
        res.status(500).json({ error: "Failed to get teaching stats" });
      }
    },
  );

  /** Get any agent's teaching stats by address. */
  router.get(
    "/teaching/stats/:address",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        // Resolve address to agent ID
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [req.params.address as string],
        );
        if (rows.length === 0) {
          res.json({ stats: defaultStats(req.params.address as string) });
          return;
        }
        const stats = await teachingService.getStats(rows[0].id);
        res.json({ stats: stats ?? defaultStats(rows[0].id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-stats-address-failed", { error: message });
        res.status(500).json({ error: "Failed to get teaching stats" });
      }
    },
  );

  /** Browse unfilled knowledge gaps. */
  router.get(
    "/teaching/gaps",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const domain = req.query.domain as string | undefined;
        const limit = parseInt(String(req.query.limit ?? "50"), 10) || 50;
        const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

        const result = await teachingService.getGapSignals({ domain, limit, offset });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-gaps-failed", { error: message });
        res.status(500).json({ error: "Failed to get knowledge gaps" });
      }
    },
  );

  /** Mark a knowledge gap as filled. */
  router.post(
    "/teaching/gaps/:id/fill",
    authMiddleware,
    registeredMiddleware,
    ownerOnlyMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const { bundleId } = req.body;
        if (!bundleId || typeof bundleId !== "string") {
          res.status(400).json({ error: "bundleId is required" });
          return;
        }

        const gap = await teachingService.markGapFilled(req.params.id as string, req.agent!.id, bundleId);
        if (!gap) {
          res.status(404).json({ error: "Gap not found or already filled" });
          return;
        }
        res.json({ gap });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "teaching-gap-fill-failed", { error: message });
        res.status(500).json({ error: "Failed to mark gap as filled" });
      }
    },
  );

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultStats(agentId: string) {
  return {
    agent_id: agentId,
    total_taught: 0,
    total_learned: 0,
    successful_teachings: 0,
    rejected_teachings: 0,
    unique_learners: 0,
    unique_teachers: 0,
    gaps_filled: 0,
    avg_rating: 0,
    approval_rate: 0,
    teaching_reputation: 0,
    last_taught_at: null,
    last_learned_at: null,
    updated_at: null,
  };
}
