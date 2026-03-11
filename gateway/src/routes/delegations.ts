/**
 * Delegation routes — manage delegated agent access.
 *
 * POST   /v1/delegations               — Create delegation (delegator must be authenticated)
 * GET    /v1/delegations               — List delegations (query: role=delegator|delegate)
 * GET    /v1/delegations/:id           — Get delegation details
 * DELETE /v1/delegations/:id           — Revoke delegation
 * POST   /v1/relay/delegated           — Relay on behalf of delegator (via delegation)
 *
 * @module routes/delegations
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { DelegationService } from "../services/delegationService.js";

export function createDelegationsRouter(
  pool: pg.Pool,
  hmacSecret: string,
  delegationService: DelegationService,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /* ---- Create delegation ---- */
  router.post("/delegations", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { delegateId, allowedActions, spendingLimit, label, expiresAt } = req.body;

      if (!delegateId) {
        res.status(400).json({ error: "delegateId is required" });
        return;
      }

      // Verify delegate exists
      const { rows: delegateRows } = await pool.query(
        `SELECT id FROM agents WHERE id = $1`,
        [delegateId],
      );
      if (delegateRows.length === 0) {
        res.status(404).json({ error: "Delegate agent not found" });
        return;
      }

      const delegation = await delegationService.create({
        delegatorId: agent.id,
        delegateId,
        allowedActions,
        spendingLimit,
        label,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      res.status(201).json(delegation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Cannot delegate to self")) {
        res.status(400).json({ error: msg });
        return;
      }
      logSecurityEvent("error", "delegation-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create delegation" });
    }
  });

  /* ---- List delegations ---- */
  router.get("/delegations", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const role = req.query.role as "delegator" | "delegate" | undefined;
      const activeOnly = req.query.activeOnly !== "false";

      const delegations = await delegationService.list({
        agentId: agent.id,
        role,
        activeOnly,
      });

      res.json({ delegations });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "delegation-list-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to list delegations" });
    }
  });

  /* ---- Get delegation details ---- */
  router.get("/delegations/:id", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const delegation = await delegationService.get(String(req.params.id));
      if (!delegation) { res.status(404).json({ error: "Delegation not found" }); return; }

      // Only delegator or delegate can view
      if (delegation.delegatorId !== agent.id && delegation.delegateId !== agent.id) {
        res.status(403).json({ error: "Not authorized to view this delegation" });
        return;
      }

      res.json(delegation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "delegation-get-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to get delegation" });
    }
  });

  /* ---- Revoke delegation ---- */
  router.delete("/delegations/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const revoked = await delegationService.revoke(String(req.params.id), agent.id);
      if (!revoked) {
        res.status(404).json({ error: "Delegation not found" });
        return;
      }
      res.json({ revoked: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Only the delegator")) {
        res.status(403).json({ error: msg });
        return;
      }
      if (msg.includes("already revoked")) {
        res.status(400).json({ error: msg });
        return;
      }
      logSecurityEvent("error", "delegation-revoke-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to revoke delegation" });
    }
  });

  /* ---- Delegated relay ---- */
  router.post("/relay/delegated", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { delegationId, targetContract, methodSelector, calldata, creditCost } = req.body;

      if (!delegationId || !targetContract || !methodSelector) {
        res.status(400).json({
          error: "delegationId, targetContract, and methodSelector are required",
        });
        return;
      }

      // Validate delegation
      const validation = await delegationService.validate(
        delegationId,
        agent.id,
        methodSelector,
        creditCost ?? 0,
      );

      if (!validation.valid) {
        res.status(403).json({
          error: "Delegation validation failed",
          message: validation.error,
        });
        return;
      }

      // Record the delegated relay attempt
      await delegationService.logRelay({
        delegationId,
        delegateId: agent.id,
        delegatorId: validation.delegation!.delegatorId,
        targetContract,
        methodSelector,
        creditCost: creditCost ?? 0,
        status: "validated",
      });

      // Record spend against delegation limit
      if (creditCost && creditCost > 0) {
        await delegationService.recordSpend(delegationId, creditCost);
      }

      logSecurityEvent("info", "delegated-relay-validated", {
        delegationId,
        delegateId: agent.id,
        delegatorId: validation.delegation!.delegatorId,
        targetContract,
        methodSelector,
      });

      // Return validation result — the actual relay submission requires
      // the DelegationForwarder contract or gateway relayer pattern.
      // For v1, this validates and records the delegation usage.
      res.json({
        validated: true,
        delegationId,
        delegatorId: validation.delegation!.delegatorId,
        delegateId: agent.id,
        remainingSpend: validation.delegation!.spendingLimit !== null
          ? validation.delegation!.spendingLimit - validation.delegation!.spent - (creditCost ?? 0)
          : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "delegated-relay-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to process delegated relay" });
    }
  });

  return router;
}
