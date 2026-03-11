/**
 * ACP-compatible interface routes — Virtuals Agent Commerce Protocol adapter.
 *
 * GET  /v1/acp/capabilities               — List capabilities
 * POST /v1/acp/requests                   — Create ACP request → intent
 * POST /v1/acp/requests/:id/negotiate     — Submit proposal
 * POST /v1/acp/requests/:id/execute       — Accept + create agreement
 * POST /v1/acp/requests/:id/evaluate      — Rate + review
 * GET  /.well-known/acp.json              — ACP service descriptor (mounted in server.ts)
 *
 * @module routes/acp
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { AcpService } from "../services/acpService.js";

export function createAcpRouter(
  pool: pg.Pool,
  hmacSecret: string,
  acpService: AcpService,
  _gatewayUrl: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /* ---- Capabilities ---- */
  router.get("/acp/capabilities", async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const category = req.query.category as string | undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const capabilities = await acpService.getCapabilities(category, Math.min(limit, 200));
      res.json({ capabilities });
    } catch (err) {
      logSecurityEvent("error", "acp-capabilities-failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to get capabilities" });
    }
  });

  /* ---- Create request ---- */
  router.post("/acp/requests", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const intent = await acpService.createRequest(agent.id, agent.address, {
        title: req.body.title,
        description: req.body.description,
        category: req.body.category,
        budget: req.body.budget,
        skills: req.body.skills,
      });
      res.status(201).json({ requestId: intent.id, intent });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("at least")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "acp-request-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create ACP request" });
    }
  });

  /* ---- Negotiate ---- */
  router.post("/acp/requests/:id/negotiate", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const proposal = await acpService.negotiate(String(req.params.id), agent.id, agent.address, {
        description: req.body.description,
        approach: req.body.approach,
        estimatedCost: req.body.estimatedCost,
        estimatedDuration: req.body.estimatedDuration,
      });
      res.status(201).json({ proposalId: proposal.id, proposal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("not open")) { res.status(400).json({ error: msg }); return; }
      if (msg.includes("own intent")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "acp-negotiate-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to negotiate" });
    }
  });

  /* ---- Execute ---- */
  router.post("/acp/requests/:id/execute", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const proposalId = req.body.proposalId;
      if (!proposalId) { res.status(400).json({ error: "proposalId is required" }); return; }

      const result = await acpService.execute(String(req.params.id), agent.id, proposalId);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      if (msg.includes("Not the")) { res.status(403).json({ error: msg }); return; }
      if (msg.includes("not open")) { res.status(400).json({ error: msg }); return; }
      logSecurityEvent("error", "acp-execute-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to execute" });
    }
  });

  /* ---- Evaluate ---- */
  router.post("/acp/requests/:id/evaluate", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      if (!req.body.rating || typeof req.body.rating !== "number") {
        res.status(400).json({ error: "rating (1-5) is required" }); return;
      }
      const result = await acpService.evaluate(String(req.params.id), agent.id, {
        rating: req.body.rating,
        comment: req.body.comment,
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) { res.status(404).json({ error: msg }); return; }
      logSecurityEvent("error", "acp-evaluate-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to evaluate" });
    }
  });

  return router;
}
