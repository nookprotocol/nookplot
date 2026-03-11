/**
 * Policy engine routes — CRUD for agent relay policies.
 *
 * POST   /v1/policies                         — Create policy
 * GET    /v1/policies                         — List own policies
 * GET    /v1/policies/:id                     — Get policy details
 * PATCH  /v1/policies/:id                     — Update policy
 * DELETE /v1/policies/:id                     — Delete policy
 * POST   /v1/policies/evaluate                — Dry-run evaluation
 * GET    /v1/policies/violations              — Violation history
 * POST   /v1/policies/approvals/:id/approve   — Approve threshold request
 * POST   /v1/guilds/:guildId/policies         — Guild admin sets member policies
 * GET    /v1/guilds/:guildId/policies         — List guild policies
 *
 * @module routes/policies
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { PolicyEngine, PolicyType, PolicyRules } from "../services/policyEngine.js";

const VALID_POLICY_TYPES: PolicyType[] = [
  "spending_limit",
  "contract_scope",
  "action_scope",
  "time_window",
  "cooldown",
  "threshold_approval",
];

export function createPoliciesRouter(
  pool: pg.Pool,
  hmacSecret: string,
  policyEngine: PolicyEngine,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /* ---- Create policy ---- */
  router.post("/policies", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { policyType, rules, priority, expiresAt } = req.body;

      if (!policyType || !VALID_POLICY_TYPES.includes(policyType)) {
        res.status(400).json({ error: `Invalid policyType. Must be one of: ${VALID_POLICY_TYPES.join(", ")}` });
        return;
      }

      if (!rules || typeof rules !== "object") {
        res.status(400).json({ error: "rules is required and must be an object" });
        return;
      }

      const policy = await policyEngine.createPolicy({
        agentId: agent.id,
        policyType,
        rules: rules as PolicyRules,
        priority,
        creatorRole: "self",
        creatorId: agent.id,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      res.status(201).json(policy);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create policy" });
    }
  });

  /* ---- List own policies ---- */
  router.get("/policies", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const policies = await policyEngine.listPolicies(agent.id, {
        enabledOnly: req.query.enabledOnly !== "false",
      });
      res.json({ policies });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-list-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to list policies" });
    }
  });

  /* ---- Get policy details ---- */
  router.get("/policies/:id", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const policy = await policyEngine.getPolicy(String(req.params.id));
      if (!policy) { res.status(404).json({ error: "Policy not found" }); return; }

      // Only owner, creator, or guild admin can view
      if (policy.agentId !== agent.id && policy.creatorId !== agent.id) {
        res.status(403).json({ error: "Not authorized to view this policy" });
        return;
      }

      res.json(policy);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-get-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to get policy" });
    }
  });

  /* ---- Update policy ---- */
  router.patch("/policies/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const existing = await policyEngine.getPolicy(String(req.params.id));
      if (!existing) { res.status(404).json({ error: "Policy not found" }); return; }

      // Only the policy creator can update it
      if (existing.creatorId !== agent.id) {
        res.status(403).json({ error: "Not authorized to update this policy" });
        return;
      }

      const { rules, priority, enabled, expiresAt } = req.body;
      const updated = await policyEngine.updatePolicy(String(req.params.id), {
        rules,
        priority,
        enabled,
        expiresAt: expiresAt === null ? null : expiresAt ? new Date(expiresAt) : undefined,
      });

      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-update-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to update policy" });
    }
  });

  /* ---- Delete policy ---- */
  router.delete("/policies/:id", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const existing = await policyEngine.getPolicy(String(req.params.id));
      if (!existing) { res.status(404).json({ error: "Policy not found" }); return; }

      // Only the policy creator can delete it
      if (existing.creatorId !== agent.id) {
        res.status(403).json({ error: "Not authorized to delete this policy" });
        return;
      }

      await policyEngine.deletePolicy(String(req.params.id));
      res.json({ deleted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-delete-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to delete policy" });
    }
  });

  /* ---- Dry-run evaluation ---- */
  router.post("/policies/evaluate", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const { targetContract, methodSelector, creditCost, calldata } = req.body;

      if (!targetContract || !methodSelector) {
        res.status(400).json({ error: "targetContract and methodSelector are required" });
        return;
      }

      const result = await policyEngine.evaluate(agent.id, {
        targetContract,
        methodSelector,
        creditCost: creditCost ?? 0,
        calldata,
      });

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-evaluate-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to evaluate policies" });
    }
  });

  /* ---- Violation history ---- */
  router.get("/policies/violations", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      const result = await policyEngine.getViolations(agent.id, { limit, offset });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "policy-violations-list-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to list violations" });
    }
  });

  /* ---- Approve threshold request ---- */
  router.post("/policies/approvals/:id/approve", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const result = await policyEngine.approveRequest(String(req.params.id), agent.id);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("already")) {
        res.status(400).json({ error: msg });
        return;
      }
      if (msg.includes("Not an authorized")) {
        res.status(403).json({ error: msg });
        return;
      }
      logSecurityEvent("error", "policy-approval-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to process approval" });
    }
  });

  /* ---- Guild admin: set member policies ---- */
  router.post("/guilds/:guildId/policies", authMiddleware, registeredMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const guildId = String(req.params.guildId);

      // Verify guild admin role via indexer
      const { rows: memberRows } = await pool.query<{ status: number }>(
        `SELECT igm.status FROM idx_guild_members igm
         JOIN idx_guilds ig ON ig.id = igm.guild_id
         WHERE ig.guild_id = $1 AND LOWER(igm.member_id) = LOWER($2)`,
        [guildId, agent.address],
      );

      // Status 2 = admin/founder in the guild membership
      if (!memberRows[0] || memberRows[0].status < 2) {
        res.status(403).json({ error: "Only guild admins can set member policies" });
        return;
      }

      const { agentId: targetAgentId, policyType, rules, priority, expiresAt } = req.body;

      if (!targetAgentId) {
        res.status(400).json({ error: "agentId (target agent) is required" });
        return;
      }

      if (!policyType || !VALID_POLICY_TYPES.includes(policyType)) {
        res.status(400).json({ error: `Invalid policyType. Must be one of: ${VALID_POLICY_TYPES.join(", ")}` });
        return;
      }

      // Verify target is a guild member
      const { rows: targetRows } = await pool.query(
        `SELECT 1 FROM idx_guild_members igm
         JOIN idx_guilds ig ON ig.id = igm.guild_id
         JOIN agents a ON LOWER(a.address) = LOWER(igm.member_id)
         WHERE ig.guild_id = $1 AND a.id = $2`,
        [guildId, targetAgentId],
      );

      if (targetRows.length === 0) {
        res.status(404).json({ error: "Target agent is not a member of this guild" });
        return;
      }

      const policy = await policyEngine.createPolicy({
        agentId: targetAgentId,
        policyType,
        rules: rules as PolicyRules,
        priority,
        creatorRole: "guild_admin",
        creatorId: agent.id,
        guildId,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      res.status(201).json(policy);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "guild-policy-create-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to create guild policy" });
    }
  });

  /* ---- Guild admin: list guild policies ---- */
  router.get("/guilds/:guildId/policies", authMiddleware, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const agent = req.agent;
    if (!agent) { res.status(401).json({ error: "Not authenticated" }); return; }

    try {
      const guildId = String(req.params.guildId);

      // Verify guild membership
      const { rows: memberRows } = await pool.query<{ status: number }>(
        `SELECT igm.status FROM idx_guild_members igm
         JOIN idx_guilds ig ON ig.id = igm.guild_id
         WHERE ig.guild_id = $1 AND LOWER(igm.member_id) = LOWER($2)`,
        [guildId, agent.address],
      );

      if (!memberRows[0]) {
        res.status(403).json({ error: "Not a guild member" });
        return;
      }

      // Get all policies for this guild
      const { rows } = await pool.query(
        `SELECT * FROM agent_policies WHERE guild_id = $1 AND enabled = TRUE ORDER BY created_at DESC`,
        [guildId],
      );

      res.json({ policies: rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSecurityEvent("error", "guild-policy-list-failed", { agentId: agent.id, error: msg });
      res.status(500).json({ error: "Failed to list guild policies" });
    }
  });

  return router;
}
