/**
 * ERC-8004 Validation Registry routes.
 *
 * POST   /v1/validation/request              — Request validation (authenticated)
 * GET    /v1/validation/status/:id           — Check request status (authenticated)
 * GET    /v1/validation/agent/:address       — Public validation summary + badge
 * GET    /v1/validation/agent/:address/history — Paginated validation history (public)
 * GET    /v1/validation/on-chain/:erc8004Id  — Cross-platform on-chain summary
 *
 * @module routes/validation
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import { ethers } from "ethers";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { validateAddressParam } from "../middleware/validation.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { ValidationService } from "../services/validationService.js";

export interface ValidationRouterDeps {
  pool: pg.Pool;
  hmacSecret: string;
  validationService: ValidationService;
}

export function createValidationRouter(deps: ValidationRouterDeps): Router {
  const { pool, hmacSecret, validationService } = deps;
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  // -------------------------------------------------------
  //  POST /v1/validation/request — Request validation (AUTHENTICATED)
  // -------------------------------------------------------
  router.post(
    "/validation/request",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const testType = (req.body.testType as string) || "capability";
      const customConfig = req.body.config as Record<string, unknown> | undefined;

      try {
        const result = await validationService.requestValidation(agent.id, testType, customConfig);
        res.status(201).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("cooldown")) {
          res.status(429).json({ error: "Too Many Requests", message });
          return;
        }
        if (message.includes("Invalid test type") || message.includes("does not have inference")) {
          res.status(400).json({ error: "Bad Request", message });
          return;
        }
        logSecurityEvent("error", "validation-request-failed", { agentId: agent.id, error: message });
        res.status(500).json({ error: "Validation request failed." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/validation/status/:id — Check request status (AUTHENTICATED)
  // -------------------------------------------------------
  router.get(
    "/validation/status/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const requestId = req.params.id as string;
      // Basic UUID format check
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        res.status(400).json({ error: "Bad Request", message: "Invalid request ID format." });
        return;
      }

      try {
        const { request, result } = await validationService.getValidationStatus(requestId);

        // Only allow the agent to see their own validation
        if (request.agent_id !== agent.id) {
          res.status(403).json({ error: "Forbidden", message: "Not your validation request." });
          return;
        }

        res.json({
          id: request.id,
          status: request.status,
          testType: request.test_type,
          createdAt: request.created_at,
          updatedAt: request.updated_at,
          result: result ? {
            score: result.response_score,
            metrics: result.test_metrics,
            proofMethod: result.proof_method,
            tag: result.tag,
            txHash: result.tx_hash,
            createdAt: result.created_at,
          } : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found")) {
          res.status(404).json({ error: "Not Found", message: "Validation request not found." });
          return;
        }
        res.status(500).json({ error: "Failed to get validation status." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/validation/agent/:address — Public validation summary + badge
  // -------------------------------------------------------
  router.get(
    "/validation/agent/:address",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;

      try {
        const summary = await validationService.getAgentSummaryByAddress(address);
        if (!summary) {
          res.json({
            address,
            badge: "none",
            totalValidations: 0,
            avgScore: 0,
            lastValidated: null,
          });
          return;
        }

        res.json({
          address,
          badge: summary.badge_level,
          totalValidations: summary.total_validations,
          avgScore: Math.round(summary.avg_score * 10) / 10,
          lastScore: summary.last_score,
          lastValidated: summary.last_validated,
          computedAt: summary.computed_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "validation-summary-failed", { address, error: message });
        res.status(500).json({ error: "Failed to get validation summary." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/validation/agent/:address/history — Validation history (PUBLIC)
  // -------------------------------------------------------
  router.get(
    "/validation/agent/:address/history",
    validateAddressParam,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const address = req.params.address as string;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      try {
        // Look up agent ID by address
        const { rows: agentRows } = await pool.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [address],
        );
        if (agentRows.length === 0) {
          res.json({ address, validations: [], total: 0 });
          return;
        }

        const results = await validationService.listValidations(agentRows[0].id, limit, offset);

        // Return scores and metadata only (not raw test prompts/responses)
        res.json({
          address,
          validations: results.map((r) => ({
            id: r.id,
            score: r.response_score,
            metrics: r.test_metrics,
            proofMethod: r.proof_method,
            tag: r.tag,
            txHash: r.tx_hash,
            createdAt: r.created_at,
          })),
          total: results.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "validation-history-failed", { address, error: message });
        res.status(500).json({ error: "Failed to get validation history." });
      }
    },
  );

  // -------------------------------------------------------
  //  GET /v1/validation/on-chain/:erc8004Id — Cross-platform on-chain summary
  // -------------------------------------------------------
  router.get(
    "/validation/on-chain/:erc8004Id",
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const erc8004IdStr = req.params.erc8004Id as string;
      const erc8004Id = parseInt(erc8004IdStr, 10);
      if (isNaN(erc8004Id) || erc8004Id < 0) {
        res.status(400).json({ error: "Bad Request", message: "Invalid ERC-8004 agent ID." });
        return;
      }

      try {
        const summary = await validationService.getOnChainSummary(BigInt(erc8004Id));
        if (!summary) {
          res.json({
            erc8004AgentId: erc8004Id,
            onChainAvailable: false,
            message: "Validation Registry not configured on this gateway.",
          });
          return;
        }

        res.json({
          erc8004AgentId: erc8004Id,
          onChainAvailable: true,
          count: Number(summary.count),
          averageResponse: summary.averageResponse,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logSecurityEvent("error", "validation-on-chain-query-failed", { erc8004Id: erc8004IdStr, error: message });
        res.status(500).json({ error: "Failed to query on-chain validation." });
      }
    },
  );

  return router;
}
