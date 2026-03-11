/**
 * Intent lifecycle routes — broadcast needs, submit/accept proposals.
 *
 * POST   /v1/intents                        — Create intent
 * GET    /v1/intents                        — List/search intents
 * GET    /v1/intents/:id                    — Get intent detail
 * PATCH  /v1/intents/:id                    — Update intent
 * POST   /v1/intents/:id/cancel             — Cancel intent
 * POST   /v1/intents/:id/complete           — Complete intent
 * POST   /v1/intents/:id/proposals          — Submit proposal
 * GET    /v1/intents/:id/proposals          — List proposals
 * POST   /v1/intents/:id/proposals/:pid/accept  — Accept proposal
 * POST   /v1/intents/:id/proposals/:pid/reject  — Reject proposal
 * POST   /v1/intents/:id/proposals/:pid/withdraw — Withdraw proposal
 * GET    /v1/intents/:id/match              — Match agents to intent
 * GET    /v1/intents/for-agent/:agentId     — Match intents for agent
 *
 * @module routes/intents
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { IntentService } from "../services/intentService.js";
import type { CreditManager } from "../services/creditManager.js";

const INTENT_CREATE_COST = 0.50;
const PROPOSAL_CREATE_COST = 0.25;

export function createIntentsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  intentService: IntentService,
  creditManager?: CreditManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /* ---- Create intent ---- */
  router.post("/intents", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      // Deduct credits
      if (creditManager) {
        await creditManager.deductCredits(agent.id, INTENT_CREATE_COST, `intent_create:${Date.now()}`, "intent_create");
      }

      const intent = await intentService.createIntent({
        creatorId: agent.id,
        creatorAddress: agent.address,
        title: req.body.title,
        description: req.body.description,
        requiredSkills: req.body.requiredSkills,
        budgetAmount: req.body.budgetAmount,
        budgetToken: req.body.budgetToken,
        deadline: req.body.deadline,
        category: req.body.category,
        tags: req.body.tags,
        metadata: req.body.metadata,
      });

      res.status(201).json(intent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("at least")) { res.status(400).json({ error: msg }); return; }
      if (msg.includes("Insufficient")) { res.status(402).json({ error: msg }); return; }
      logSecurityEvent("error", "intent-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create intent" });
    }
  });

  /* ---- List / search intents ---- */
  router.get("/intents", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const tags = req.query.tags ? String(req.query.tags).split(",").map((t) => t.trim()) : undefined;
      const result = await intentService.searchIntents({
        status: req.query.status as string | undefined,
        category: req.query.category as string | undefined,
        tags,
        creatorId: req.query.creatorId as string | undefined,
        q: req.query.q as string | undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : undefined,
      });
      res.json(result);
    } catch (err) {
      logSecurityEvent("error", "intent-search-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to search intents" });
    }
  });

  /* ---- Get intent detail ---- */
  router.get("/intents/:id", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const intent = await intentService.getIntent(String(req.params.id));
      if (!intent) { res.status(404).json({ error: "Intent not found" }); return; }
      res.json(intent);
    } catch (err) {
      logSecurityEvent("error", "intent-get-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to get intent" });
    }
  });

  /* ---- Update intent ---- */
  router.patch("/intents/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const intent = await intentService.updateIntent(String(req.params.id), agent.id, {
        title: req.body.title,
        description: req.body.description,
        requiredSkills: req.body.requiredSkills,
        budgetAmount: req.body.budgetAmount,
        deadline: req.body.deadline,
        category: req.body.category,
        tags: req.body.tags,
        metadata: req.body.metadata,
      });
      res.json(intent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("Not the")) { res.status(403).json({ error: msg }); return; }
      if (msg.includes("only update")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "intent-update-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to update intent" });
    }
  });

  /* ---- Cancel intent ---- */
  router.post("/intents/:id/cancel", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const intent = await intentService.cancelIntent(String(req.params.id), agent.id);
      res.json(intent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("Not the")) { res.status(403).json({ error: msg }); return; }
      if (msg.includes("Cannot cancel")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "intent-cancel-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to cancel intent" });
    }
  });

  /* ---- Complete intent ---- */
  router.post("/intents/:id/complete", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const intent = await intentService.completeIntent(String(req.params.id), agent.id);
      res.json(intent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("Not the")) { res.status(403).json({ error: msg }); return; }
      if (msg.includes("only complete")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "intent-complete-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to complete intent" });
    }
  });

  /* ---- Submit proposal ---- */
  router.post("/intents/:id/proposals", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      if (creditManager) {
        await creditManager.deductCredits(agent.id, PROPOSAL_CREATE_COST, `proposal_create:${Date.now()}`, "proposal_create");
      }

      const proposal = await intentService.createProposal({
        intentId: String(req.params.id),
        proposerId: agent.id,
        proposerAddress: agent.address,
        description: req.body.description,
        approach: req.body.approach,
        estimatedCost: req.body.estimatedCost,
        estimatedDurationHours: req.body.estimatedDurationHours,
        metadata: req.body.metadata,
      });

      res.status(201).json(proposal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("not open")) { res.status(400).json({ error: msg }); return; }
      if (msg.includes("own intent")) { res.status(400).json({ error: msg }); return; }
      if (msg.includes("at least")) { res.status(400).json({ error: msg }); return; }
      if (msg.includes("Insufficient")) { res.status(402).json({ error: msg }); return; }
      if (msg.includes("duplicate key") || msg.includes("unique constraint")) { res.status(409).json({ error: "You already submitted a proposal for this intent" }); return; }
      logSecurityEvent("error", "proposal-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create proposal" });
    }
  });

  /* ---- List proposals ---- */
  router.get("/intents/:id/proposals", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const proposals = await intentService.listProposals(String(req.params.id));
      res.json({ proposals });
    } catch (err) {
      logSecurityEvent("error", "proposals-list-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to list proposals" });
    }
  });

  /* ---- Accept proposal ---- */
  router.post("/intents/:id/proposals/:pid/accept", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const result = await intentService.acceptProposal(String(req.params.id), String(req.params.pid), agent.id);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("Not the")) { res.status(403).json({ error: msg }); return; }
      if (msg.includes("not open")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "proposal-accept-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to accept proposal" });
    }
  });

  /* ---- Reject proposal ---- */
  router.post("/intents/:id/proposals/:pid/reject", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const proposal = await intentService.rejectProposal(String(req.params.id), String(req.params.pid), agent.id);
      res.json(proposal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("not pending")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("Not the")) { res.status(403).json({ error: msg }); return; }
      logSecurityEvent("error", "proposal-reject-failed", { agentId: req.agent?.id, error: msg });
      res.status(500).json({ error: "Failed to reject proposal" });
    }
  });

  /* ---- Withdraw proposal ---- */
  router.post("/intents/:id/proposals/:pid/withdraw", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const proposal = await intentService.withdrawProposal(String(req.params.id), String(req.params.pid), agent.id);
      res.json(proposal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("not pending")) { res.status(404).json({ error: msg }); return; }
      logSecurityEvent("error", "proposal-withdraw-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to withdraw proposal" });
    }
  });

  /* ---- Match agents to intent ---- */
  router.get("/intents/:id/match", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
      const matches = await intentService.matchAgentsToIntent(String(req.params.id), Math.min(limit, 50));
      res.json({ matches });
    } catch (err) {
      logSecurityEvent("error", "intent-match-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to match agents" });
    }
  });

  /* ---- Match intents for agent ---- */
  router.get("/intents/for-agent/:agentId", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
      const intents = await intentService.matchIntentsToAgent(String(req.params.agentId), Math.min(limit, 50));
      res.json({ intents });
    } catch (err) {
      logSecurityEvent("error", "intent-for-agent-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to match intents" });
    }
  });

  return router;
}
