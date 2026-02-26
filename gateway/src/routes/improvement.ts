/**
 * Self-improvement routes.
 *
 * GET    /v1/improvement/settings                — Get improvement settings
 * PUT    /v1/improvement/settings                — Update settings
 * GET    /v1/improvement/proposals               — List proposals (filter by status)
 * POST   /v1/improvement/proposals/:id/approve   — Approve a pending proposal
 * POST   /v1/improvement/proposals/:id/reject    — Reject a pending proposal
 * POST   /v1/improvement/trigger                 — Manually trigger improvement cycle
 * GET    /v1/improvement/cycles                  — Improvement cycle history
 * GET    /v1/improvement/performance             — Agent performance metrics
 * GET    /v1/improvement/performance/knowledge   — Per-CID knowledge performance
 * GET    /v1/improvement/soul-history            — Soul version history
 *
 * @module routes/improvement
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import type { AuthenticatedRequest } from "../types.js";
import type { SelfImprovementEngine } from "../services/selfImprovementEngine.js";
import type { PerformanceTracker } from "../services/performanceTracker.js";
import type { SdkFactoryConfig } from "../sdkFactory.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

export function createImprovementRouter(
  pool: pg.Pool,
  hmacSecret: string,
  improvementEngine: SelfImprovementEngine,
  performanceTracker: PerformanceTracker,
  _sdkConfig: SdkFactoryConfig,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  GET /v1/improvement/settings
  // -------------------------------------------------------
  router.get(
    "/improvement/settings",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        const settings = await improvementEngine.getSettings(agent.id);

        if (!settings) {
          // Return defaults if no settings exist yet
          res.json({
            agentId: agent.id,
            enabled: false,
            scanIntervalHours: 24,
            maxCreditsPerCycle: 10000,
            maxProposalsPerWeek: 5,
            autoApplyThreshold: 0.9,
            soulEvolutionEnabled: false,
            bundleCurationEnabled: true,
            pausedUntil: null,
            createdAt: null,
            updatedAt: null,
          });
          return;
        }

        res.json(settings);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-get-settings-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get improvement settings." });
      }
    },
  );

  // -------------------------------------------------------
  //  PUT /v1/improvement/settings
  // -------------------------------------------------------
  router.put(
    "/improvement/settings",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const {
        enabled, scanIntervalHours, maxCreditsPerCycle,
        maxProposalsPerWeek, autoApplyThreshold,
        soulEvolutionEnabled, bundleCurationEnabled,
      } = req.body;

      // Validate inputs
      if (enabled !== undefined && typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean." });
        return;
      }
      if (scanIntervalHours !== undefined) {
        if (typeof scanIntervalHours !== "number" || !Number.isInteger(scanIntervalHours) || scanIntervalHours < 1 || scanIntervalHours > 168) {
          res.status(400).json({ error: "scanIntervalHours must be an integer between 1 and 168." });
          return;
        }
      }
      if (maxCreditsPerCycle !== undefined) {
        if (typeof maxCreditsPerCycle !== "number" || !Number.isInteger(maxCreditsPerCycle) || maxCreditsPerCycle < 1000 || maxCreditsPerCycle > 10_000_000) {
          res.status(400).json({ error: "maxCreditsPerCycle must be an integer between 1,000 and 10,000,000." });
          return;
        }
      }
      if (maxProposalsPerWeek !== undefined) {
        if (typeof maxProposalsPerWeek !== "number" || !Number.isInteger(maxProposalsPerWeek) || maxProposalsPerWeek < 1 || maxProposalsPerWeek > 50) {
          res.status(400).json({ error: "maxProposalsPerWeek must be an integer between 1 and 50." });
          return;
        }
      }
      if (autoApplyThreshold !== undefined) {
        if (typeof autoApplyThreshold !== "number" || autoApplyThreshold < 0 || autoApplyThreshold > 1) {
          res.status(400).json({ error: "autoApplyThreshold must be a number between 0.0 and 1.0." });
          return;
        }
      }
      if (soulEvolutionEnabled !== undefined && typeof soulEvolutionEnabled !== "boolean") {
        res.status(400).json({ error: "soulEvolutionEnabled must be a boolean." });
        return;
      }
      if (bundleCurationEnabled !== undefined && typeof bundleCurationEnabled !== "boolean") {
        res.status(400).json({ error: "bundleCurationEnabled must be a boolean." });
        return;
      }

      try {
        const settings = await improvementEngine.updateSettings(agent.id, {
          enabled,
          scanIntervalHours,
          maxCreditsPerCycle,
          maxProposalsPerWeek,
          autoApplyThreshold,
          soulEvolutionEnabled,
          bundleCurationEnabled,
        });

        logSecurityEvent("info", "improvement-settings-updated", {
          agentId: agent.id,
          enabled: settings.enabled,
          soulEvolutionEnabled: settings.soulEvolutionEnabled,
          bundleCurationEnabled: settings.bundleCurationEnabled,
        });

        res.json(settings);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-update-settings-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to update improvement settings." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/improvement/proposals
  // -------------------------------------------------------
  router.get(
    "/improvement/proposals",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const status = req.query.status as string | undefined;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      try {
        const proposals = await improvementEngine.getProposals(agent.id, status, limit, offset);
        res.json({ proposals, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-proposals-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get improvement proposals." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/improvement/proposals/:id/approve
  // -------------------------------------------------------
  router.post(
    "/improvement/proposals/:id/approve",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const proposalId = String(req.params.id);

      if (!proposalId) {
        res.status(400).json({ error: "Proposal ID is required." });
        return;
      }

      try {
        await improvementEngine.approveProposal(proposalId, agent.id);

        logSecurityEvent("info", "improvement-proposal-approved", {
          agentId: agent.id,
          proposalId,
        });

        res.json({ success: true, proposalId, decision: "approved" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "PROPOSAL_NOT_FOUND_OR_NOT_PENDING") {
          res.status(404).json({ error: "Proposal not found or not in pending state." });
          return;
        }
        logSecurityEvent("error", "improvement-approve-failed", { agentId: agent.id, proposalId, error: message });
        res.status(500).json({ error: "Failed to approve proposal." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/improvement/proposals/:id/reject
  // -------------------------------------------------------
  router.post(
    "/improvement/proposals/:id/reject",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const proposalId = String(req.params.id);

      if (!proposalId) {
        res.status(400).json({ error: "Proposal ID is required." });
        return;
      }

      try {
        await improvementEngine.rejectProposal(proposalId, agent.id);

        logSecurityEvent("info", "improvement-proposal-rejected", {
          agentId: agent.id,
          proposalId,
        });

        res.json({ success: true, proposalId, decision: "rejected" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "PROPOSAL_NOT_FOUND_OR_NOT_PENDING") {
          res.status(404).json({ error: "Proposal not found or not in pending state." });
          return;
        }
        logSecurityEvent("error", "improvement-reject-failed", { agentId: agent.id, proposalId, error: message });
        res.status(500).json({ error: "Failed to reject proposal." });
      }
    },
  );

  // -------------------------------------------------------
  //  POST /v1/improvement/trigger
  // -------------------------------------------------------
  router.post(
    "/improvement/trigger",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;

      try {
        // Rate limit: max 1 manual trigger per hour
        const recentCycle = await pool.query(
          `SELECT created_at FROM improvement_cycle_log
           WHERE agent_id = $1 AND trigger = 'manual'
           ORDER BY created_at DESC LIMIT 1`,
          [agent.id],
        );
        if (recentCycle.rows.length > 0) {
          const lastRun = new Date(recentCycle.rows[0].created_at as string);
          const hoursSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
          if (hoursSince < 1) {
            const retryAfterSecs = Math.ceil((1 - hoursSince) * 3600);
            res.set("Retry-After", String(retryAfterSecs));
            res.status(429).json({ error: "Manual improvement cycles are limited to once per hour." });
            return;
          }
        }

        const result = await improvementEngine.runImprovementCycle(agent.id, agent.address, "manual");

        logSecurityEvent("info", "improvement-manual-trigger", {
          agentId: agent.id,
          proposalsGenerated: result.proposalsGenerated,
        });

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-trigger-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to trigger improvement cycle." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/improvement/cycles
  // -------------------------------------------------------
  router.get(
    "/improvement/cycles",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);

      try {
        const cycles = await improvementEngine.getCycleHistory(agent.id, limit);
        res.json({ cycles, limit });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-cycles-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get improvement cycles." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/improvement/performance
  // -------------------------------------------------------
  router.get(
    "/improvement/performance",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const periodDays = Math.min(Math.max(parseInt(String(req.query.periodDays ?? "30"), 10) || 30, 1), 365);

      try {
        const metrics = await performanceTracker.getAgentMetrics(agent.id, periodDays);
        const trend = await performanceTracker.getPerformanceTrend(agent.id, Math.min(periodDays, 30));
        res.json({ metrics, trend });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-performance-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get performance metrics." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/improvement/performance/knowledge
  // -------------------------------------------------------
  router.get(
    "/improvement/performance/knowledge",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const bundleId = req.query.bundleId ? parseInt(String(req.query.bundleId), 10) : undefined;

      try {
        if (bundleId !== undefined && !isNaN(bundleId)) {
          const items = await performanceTracker.getBundlePerformance(agent.id, bundleId);
          res.json({ items, bundleId });
        } else {
          // Return all knowledge items across bundles (limited)
          const result = await pool.query(
            `SELECT content_cid, bundle_id, usage_count, success_count, failure_count,
                    avg_quality, last_used_at
             FROM knowledge_performance
             WHERE agent_id = $1
             ORDER BY avg_quality DESC, usage_count DESC
             LIMIT 100`,
            [agent.id],
          );
          const items = result.rows.map((r) => ({
            contentCid: r.content_cid as string,
            bundleId: r.bundle_id as number,
            usageCount: r.usage_count as number,
            successCount: r.success_count as number,
            failureCount: r.failure_count as number,
            avgQuality: parseFloat(String(r.avg_quality)),
            lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null,
          }));
          res.json({ items });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-knowledge-perf-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get knowledge performance." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/improvement/soul-history
  // -------------------------------------------------------
  router.get(
    "/improvement/soul-history",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent!;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      try {
        const versions = await improvementEngine.getSoulHistory(agent.id, limit, offset);
        res.json({ versions, limit, offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "improvement-soul-history-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Failed to get soul version history." });
      }
    },
  );

  return router;
}
