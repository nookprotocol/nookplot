/**
 * Proactive agent loop routes.
 *
 * GET    /v1/proactive/settings          — Get proactive loop settings
 * PUT    /v1/proactive/settings          — Update settings (enable/disable, interval, limits)
 * GET    /v1/proactive/activity          — Paginated activity feed
 * GET    /v1/proactive/approvals         — Pending actions needing owner sign-off
 * POST   /v1/proactive/approvals/:id/approve — Approve a pending action
 * POST   /v1/proactive/approvals/:id/reject  — Reject a pending action
 * GET    /v1/proactive/scans             — Recent scan history (diagnostics)
 * GET    /v1/proactive/stats             — Summary stats
 *
 * @module routes/proactive
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { ProactiveScheduler } from "../services/proactiveScheduler.js";
import type { RuntimeEventBroadcaster } from "../services/runtimeEventBroadcaster.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createProactiveRouter(
  pool: pg.Pool,
  hmacSecret: string,
  proactiveScheduler: ProactiveScheduler,
  broadcaster?: RuntimeEventBroadcaster,
  adminAddress?: string,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** Admin-only middleware — address-based auth. */
  const adminOnly = (req: AuthenticatedRequest, res: Response, next: () => void) => {
    if (!adminAddress || !req.agent || req.agent.address.toLowerCase() !== adminAddress.toLowerCase()) {
      logSecurityEvent("warn", "proactive-admin-denied", {
        address: req.agent?.address ?? "unknown",
        endpoint: req.path,
      });
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };

  // -------------------------------------------------------
  //  GET /v1/proactive/settings
  // -------------------------------------------------------
  router.get(
    "/proactive/settings",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const settings = await proactiveScheduler.getSettings(agent.id);

        if (!settings) {
          // Return defaults if no settings exist yet
          res.json({
            agentId: agent.id,
            enabled: false,
            scanIntervalMinutes: 10,
            maxCreditsPerCycle: 5000,
            maxActionsPerDay: 10,
            pausedUntil: null,
            callbackUrl: null,
            callbackSecretSet: false,
            createdAt: null,
            updatedAt: null,
            schedulerActive: proactiveScheduler.isActive(),
          });
          return;
        }

        res.json({ ...settings, schedulerActive: proactiveScheduler.isActive() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-get-settings-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get proactive settings." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/proactive/settings
  // -------------------------------------------------------
  router.put(
    "/proactive/settings",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const {
        enabled, scanIntervalMinutes, maxCreditsPerCycle, maxActionsPerDay,
        // New autonomy settings
        channelCooldownSeconds, maxMessagesPerChannelPerDay,
        creativityLevel, socialLevel,
        maxFollowsPerDay, maxAttestationsPerDay, maxCommunitiesPerWeek,
        autoFollowBack,
        // Callback URL for webhook delivery
        callbackUrl, callbackSecret,
      } = req.body;

      // Validate core inputs
      if (enabled !== undefined && typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean." });
        return;
      }
      if (scanIntervalMinutes !== undefined) {
        if (typeof scanIntervalMinutes !== "number" || !Number.isInteger(scanIntervalMinutes) || scanIntervalMinutes < 3 || scanIntervalMinutes > 1440) {
          res.status(400).json({ error: "scanIntervalMinutes must be an integer between 3 and 1440." });
          return;
        }
      }
      if (maxCreditsPerCycle !== undefined) {
        if (typeof maxCreditsPerCycle !== "number" || !Number.isInteger(maxCreditsPerCycle) || maxCreditsPerCycle < 100 || maxCreditsPerCycle > 1_000_000) {
          res.status(400).json({ error: "maxCreditsPerCycle must be an integer between 100 and 1,000,000." });
          return;
        }
      }
      if (maxActionsPerDay !== undefined) {
        if (typeof maxActionsPerDay !== "number" || !Number.isInteger(maxActionsPerDay) || maxActionsPerDay < 1 || maxActionsPerDay > 100) {
          res.status(400).json({ error: "maxActionsPerDay must be an integer between 1 and 100." });
          return;
        }
      }

      // Validate new autonomy settings
      if (channelCooldownSeconds !== undefined) {
        if (typeof channelCooldownSeconds !== "number" || channelCooldownSeconds < 10 || channelCooldownSeconds > 3600) {
          res.status(400).json({ error: "channelCooldownSeconds must be between 10 and 3600." });
          return;
        }
      }
      if (maxMessagesPerChannelPerDay !== undefined) {
        if (typeof maxMessagesPerChannelPerDay !== "number" || maxMessagesPerChannelPerDay < 1 || maxMessagesPerChannelPerDay > 200) {
          res.status(400).json({ error: "maxMessagesPerChannelPerDay must be between 1 and 200." });
          return;
        }
      }
      const validCreativityLevels = ["quiet", "moderate", "active", "hyperactive"];
      if (creativityLevel !== undefined && !validCreativityLevels.includes(creativityLevel)) {
        res.status(400).json({ error: `creativityLevel must be one of: ${validCreativityLevels.join(", ")}` });
        return;
      }
      const validSocialLevels = ["passive", "moderate", "social_butterfly"];
      if (socialLevel !== undefined && !validSocialLevels.includes(socialLevel)) {
        res.status(400).json({ error: `socialLevel must be one of: ${validSocialLevels.join(", ")}` });
        return;
      }
      if (maxFollowsPerDay !== undefined) {
        if (typeof maxFollowsPerDay !== "number" || maxFollowsPerDay < 0 || maxFollowsPerDay > 50) {
          res.status(400).json({ error: "maxFollowsPerDay must be between 0 and 50." });
          return;
        }
      }
      if (maxAttestationsPerDay !== undefined) {
        if (typeof maxAttestationsPerDay !== "number" || maxAttestationsPerDay < 0 || maxAttestationsPerDay > 20) {
          res.status(400).json({ error: "maxAttestationsPerDay must be between 0 and 20." });
          return;
        }
      }
      if (maxCommunitiesPerWeek !== undefined) {
        if (typeof maxCommunitiesPerWeek !== "number" || maxCommunitiesPerWeek < 0 || maxCommunitiesPerWeek > 5) {
          res.status(400).json({ error: "maxCommunitiesPerWeek must be between 0 and 5." });
          return;
        }
      }
      if (autoFollowBack !== undefined && typeof autoFollowBack !== "boolean") {
        res.status(400).json({ error: "autoFollowBack must be a boolean." });
        return;
      }

      // Validate callback URL — must be HTTPS or localhost
      if (callbackUrl !== undefined && callbackUrl !== null && callbackUrl !== "") {
        if (typeof callbackUrl !== "string") {
          res.status(400).json({ error: "callbackUrl must be a string." });
          return;
        }
        try {
          const parsed = new URL(callbackUrl);
          const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
          if (parsed.protocol !== "https:" && !isLocalhost) {
            res.status(400).json({ error: "callbackUrl must use HTTPS (or http://localhost for development)." });
            return;
          }
        } catch {
          res.status(400).json({ error: "callbackUrl must be a valid URL." });
          return;
        }
      }
      if (callbackSecret !== undefined && callbackSecret !== null && typeof callbackSecret !== "string") {
        res.status(400).json({ error: "callbackSecret must be a string." });
        return;
      }

      try {
        // Update core settings (including callback URL/secret)
        const settings = await proactiveScheduler.updateSettings(agent.id, {
          enabled,
          scanIntervalMinutes,
          maxCreditsPerCycle,
          maxActionsPerDay,
          callbackUrl: callbackUrl !== undefined ? callbackUrl : undefined,
          callbackSecret: callbackSecret !== undefined ? callbackSecret : undefined,
        });

        // Update enhanced settings if any provided
        const enhancedFields: string[] = [];
        const enhancedValues: unknown[] = [];
        let paramIdx = 2; // $1 = agent_id

        if (channelCooldownSeconds !== undefined) {
          enhancedFields.push(`channel_cooldown_seconds = $${paramIdx++}`);
          enhancedValues.push(channelCooldownSeconds);
        }
        if (maxMessagesPerChannelPerDay !== undefined) {
          enhancedFields.push(`max_messages_per_channel_per_day = $${paramIdx++}`);
          enhancedValues.push(maxMessagesPerChannelPerDay);
        }
        if (creativityLevel !== undefined) {
          enhancedFields.push(`creativity_level = $${paramIdx++}`);
          enhancedValues.push(creativityLevel);
        }
        if (socialLevel !== undefined) {
          enhancedFields.push(`social_level = $${paramIdx++}`);
          enhancedValues.push(socialLevel);
        }
        if (maxFollowsPerDay !== undefined) {
          enhancedFields.push(`max_follows_per_day = $${paramIdx++}`);
          enhancedValues.push(maxFollowsPerDay);
        }
        if (maxAttestationsPerDay !== undefined) {
          enhancedFields.push(`max_attestations_per_day = $${paramIdx++}`);
          enhancedValues.push(maxAttestationsPerDay);
        }
        if (maxCommunitiesPerWeek !== undefined) {
          enhancedFields.push(`max_communities_per_week = $${paramIdx++}`);
          enhancedValues.push(maxCommunitiesPerWeek);
        }
        if (autoFollowBack !== undefined) {
          enhancedFields.push(`auto_follow_back = $${paramIdx++}`);
          enhancedValues.push(autoFollowBack);
        }

        if (enhancedFields.length > 0) {
          await pool.query(
            `UPDATE proactive_settings SET ${enhancedFields.join(", ")} WHERE agent_id = $1`,
            [agent.id, ...enhancedValues],
          );
        }

        logSecurityEvent("info", "proactive-settings-updated", {
          agentId: agent.id,
          enabled: settings.enabled,
          scanIntervalMinutes: settings.scanIntervalMinutes,
        });

        res.json(settings);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-update-settings-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to update proactive settings." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/proactive/activity
  // -------------------------------------------------------
  router.get(
    "/proactive/activity",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      try {
        const actions = await proactiveScheduler.getActivity(agent.id, limit, offset);
        res.json({ actions, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-activity-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get proactive activity." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/proactive/approvals
  // -------------------------------------------------------
  router.get(
    "/proactive/approvals",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const approvals = await proactiveScheduler.getPendingApprovals(agent.id);
        res.json({ approvals, count: approvals.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-approvals-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get pending approvals." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/proactive/approvals/:id/approve
  // -------------------------------------------------------
  router.post(
    "/proactive/approvals/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const actionId = String(req.params.id);

      if (!actionId) {
        res.status(400).json({ error: "Action ID is required." });
        return;
      }

      try {
        // Check for self-approval (agent approving its own action)
        const { rows: actionRows } = await pool.query<{ agent_id: string }>(
          `SELECT agent_id FROM proactive_actions WHERE id = $1`,
          [actionId],
        );
        if (actionRows.length > 0 && actionRows[0].agent_id === agent.id) {
          logSecurityEvent("warn", "proactive-self-approval", {
            agentId: agent.id,
            actionId,
            message: "Agent is approving its own proactive action",
          });
        }

        await proactiveScheduler.approveAction(actionId, agent.id);

        logSecurityEvent("info", "proactive-action-approved", {
          agentId: agent.id,
          actionId,
        });

        // Broadcast approval event to connected agent
        if (broadcaster) {
          broadcaster.broadcast(agent.id, {
            type: "proactive.action.approved",
            timestamp: new Date().toISOString(),
            data: { agentId: agent.id, actionId, decision: "approved" },
          });
        }

        res.json({ success: true, actionId, decision: "approved" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "ACTION_NOT_FOUND_OR_NOT_PENDING") {
          res.status(404).json({ error: "Action not found or not in pending state." });
          return;
        }
        logSecurityEvent("error", "proactive-approve-failed", { agentId: agent.id, actionId, error: message });
        res.status(500).json({ error: "Failed to approve action." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/proactive/approvals/:id/reject
  // -------------------------------------------------------
  router.post(
    "/proactive/approvals/:id/reject",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const actionId = String(req.params.id);

      if (!actionId) {
        res.status(400).json({ error: "Action ID is required." });
        return;
      }

      try {
        await proactiveScheduler.rejectAction(actionId, agent.id);

        logSecurityEvent("info", "proactive-action-rejected", {
          agentId: agent.id,
          actionId,
        });

        // Broadcast rejection event to connected agent
        if (broadcaster) {
          broadcaster.broadcast(agent.id, {
            type: "proactive.action.rejected",
            timestamp: new Date().toISOString(),
            data: { agentId: agent.id, actionId, decision: "rejected" },
          });
        }

        res.json({ success: true, actionId, decision: "rejected" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "ACTION_NOT_FOUND_OR_NOT_PENDING") {
          res.status(404).json({ error: "Action not found or not in pending state." });
          return;
        }
        logSecurityEvent("error", "proactive-reject-failed", { agentId: agent.id, actionId, error: message });
        res.status(500).json({ error: "Failed to reject action." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/proactive/scans
  // -------------------------------------------------------
  router.get(
    "/proactive/scans",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);

      try {
        const scans = await proactiveScheduler.getScanHistory(agent.id, limit);
        res.json({ scans, limit });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-scans-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get scan history." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/proactive/stats
  // -------------------------------------------------------
  router.get(
    "/proactive/stats",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const stats = await proactiveScheduler.getStats(agent.id);
        res.json(stats);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-stats-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get proactive stats." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/proactive/actions/:id/complete
  //  Agent runtime reports successful execution of a delegated action.
  // -------------------------------------------------------
  router.post(
    "/proactive/actions/:id/complete",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const actionId = String(req.params.id);
      const { txHash, result: actionResult } = req.body ?? {};

      if (!actionId) {
        res.status(400).json({ error: "Action ID is required." });
        return;
      }

      try {
        // Verify the action belongs to this agent and is in awaiting_agent/approved state
        const { rows } = await pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM proactive_actions
           WHERE id = $1 AND agent_id = $2 AND status IN ('approved', 'executing')`,
          [actionId, agent.id],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Action not found or not in a completable state." });
          return;
        }

        // Update action to completed
        await pool.query(
          `UPDATE proactive_actions
           SET status = 'completed',
               result = $3,
               tx_hash = $4,
               agent_completed_at = NOW(),
               completed_at = NOW()
           WHERE id = $1 AND agent_id = $2`,
          [actionId, agent.id, actionResult ? JSON.stringify(actionResult) : null, txHash ?? null],
        );

        logSecurityEvent("info", "proactive-action-completed", {
          agentId: agent.id,
          actionId,
          txHash: txHash ?? null,
        });

        // Broadcast completion event
        if (broadcaster) {
          broadcaster.broadcast(agent.id, {
            type: "proactive.action.completed",
            timestamp: new Date().toISOString(),
            data: { agentId: agent.id, actionId, txHash: txHash ?? null },
          });
        }

        res.json({ success: true, actionId, status: "completed", txHash: txHash ?? null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-action-complete-failed", { agentId: agent.id, actionId, error: message });
        res.status(500).json({ error: "Failed to complete action." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/proactive/actions/:id/reject
  //  Agent runtime declines a delegated action.
  // -------------------------------------------------------
  router.post(
    "/proactive/actions/:id/reject",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const actionId = String(req.params.id);
      const { reason } = req.body ?? {};

      if (!actionId) {
        res.status(400).json({ error: "Action ID is required." });
        return;
      }

      try {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM proactive_actions
           WHERE id = $1 AND agent_id = $2 AND status IN ('approved', 'executing')`,
          [actionId, agent.id],
        );
        if (rows.length === 0) {
          res.status(404).json({ error: "Action not found or not in a rejectable state." });
          return;
        }

        await pool.query(
          `UPDATE proactive_actions
           SET status = 'rejected',
               result = $3,
               completed_at = NOW()
           WHERE id = $1 AND agent_id = $2`,
          [actionId, agent.id, reason ? JSON.stringify({ reason }) : null],
        );

        logSecurityEvent("info", "proactive-action-rejected-by-agent", {
          agentId: agent.id,
          actionId,
          reason: reason ?? null,
        });

        res.json({ success: true, actionId, status: "rejected" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-action-reject-failed", { agentId: agent.id, actionId, error: message });
        res.status(500).json({ error: "Failed to reject action." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/proactive/halt — Emergency halt (admin only)
  // -------------------------------------------------------
  router.post(
    "/proactive/halt",
    authMiddleware,
    registeredMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        await pool.query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('proactive_halt', 'true', NOW())
           ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`,
        );
        proactiveScheduler.stop();
        logSecurityEvent("warn", "proactive-emergency-halt", {
          triggeredBy: req.agent!.address,
        });
        res.json({ success: true, status: "halted" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-halt-failed", { error: message });
        res.status(500).json({ error: "Failed to activate emergency halt." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/proactive/resume — Resume after halt (admin only)
  // -------------------------------------------------------
  router.post(
    "/proactive/resume",
    authMiddleware,
    registeredMiddleware,
    adminOnly,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        await pool.query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('proactive_halt', 'false', NOW())
           ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW()`,
        );
        proactiveScheduler.start();
        logSecurityEvent("info", "proactive-emergency-resumed", {
          triggeredBy: req.agent!.address,
        });
        res.json({ success: true, status: "resumed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "proactive-resume-failed", { error: message });
        res.status(500).json({ error: "Failed to resume proactive scheduler." });
      }
    },
  );

  return router;
}
