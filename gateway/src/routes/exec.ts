/**
 * REST endpoint for Docker code execution.
 *
 * POST /v1/exec — Execute code in a sandboxed Docker container.
 * Replicates the same validation, credit logic, and audit logging
 * as the WebSocket ExecServer, but as a synchronous REST call.
 *
 * @module routes/exec
 */

import { Router } from "express";
import type { Response } from "express";
import type pg from "pg";
import crypto from "crypto";
import type { AuthenticatedRequest } from "../types.js";
import { createAuthMiddleware, registeredMiddleware } from "../middleware/auth.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import type { ExecService } from "../services/execService.js";
import type { CreditManager } from "../services/creditManager.js";

/** Allowed Docker images for execution. */
const ALLOWED_IMAGES = new Set([
  "node:20-slim",
  "node:22-slim",
  "python:3.12-slim",
  "python:3.13-slim",
  "denoland/deno:2.0",
]);

/** Base credit cost for starting a sandbox execution (credits, stored units). */
const EXEC_BASE_COST = 50;

/** Additional credit cost per second of execution (stored units). */
const EXEC_COST_PER_SECOND = 1;

/** Max executions per agent per hour. */
const MAX_EXEC_PER_HOUR = 10;

export function createExecRouter(
  pool: pg.Pool,
  hmacSecret: string,
  execService: ExecService,
  creditManager: CreditManager,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(pool, hmacSecret);

  /** Per-agent hourly rate limit tracking. */
  const execCounts = new Map<string, { count: number; resetAt: number }>();

  function checkRateLimit(agentId: string): boolean {
    const now = Date.now();

    // Prune expired entries to prevent unbounded Map growth
    if (execCounts.size > 1000) {
      for (const [key, val] of execCounts) {
        if (now > val.resetAt) execCounts.delete(key);
      }
    }

    const entry = execCounts.get(agentId);

    if (!entry || now > entry.resetAt) {
      execCounts.set(agentId, { count: 1, resetAt: now + 3600_000 });
      return true;
    }

    if (entry.count >= MAX_EXEC_PER_HOUR) {
      return false;
    }

    entry.count++;
    return true;
  }

  // -------------------------------------------------------
  //  POST /v1/exec — Execute code in sandboxed Docker
  // -------------------------------------------------------
  router.post(
    "/exec",
    authMiddleware,
    registeredMiddleware,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const agent = req.agent;
      if (!agent) { res.status(401).json({ error: "Unauthorized" }); return; }

      const agentId = agent.id;

      // Parse body
      const { command, image, timeout, projectId } = req.body as {
        command?: string;
        image?: string;
        files?: Record<string, string> | string;
        timeout?: number;
        projectId?: string;
      };

      // Normalize files — some MCP clients send files as a JSON string.
      // If the string contains literal control characters (newlines, tabs),
      // they must be escaped before JSON.parse can succeed.
      let files: Record<string, string> | undefined;
      if (typeof req.body.files === "string") {
        try {
          files = JSON.parse(req.body.files) as Record<string, string>;
        } catch {
          try {
            // Escape control characters that break JSON string parsing
            // eslint-disable-next-line no-control-regex
            const normalized = req.body.files.replace(
              /[\x00-\x1f\x7f]/g,
              (ch: string) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
            );
            files = JSON.parse(normalized) as Record<string, string>;
          } catch {
            res.status(400).json({ error: "Invalid files: must be a JSON object mapping filenames to content" });
            return;
          }
        }
      } else {
        files = req.body.files as Record<string, string> | undefined;
      }

      // Validate required fields
      if (!command || typeof command !== "string") {
        res.status(400).json({ error: "Missing required field: command (string)" });
        return;
      }
      if (!image || typeof image !== "string") {
        res.status(400).json({ error: "Missing required field: image (string)" });
        return;
      }

      // Validate image is in allowed list
      if (!ALLOWED_IMAGES.has(image)) {
        res.status(400).json({
          error: `Image not allowed: ${image}. Allowed: ${[...ALLOWED_IMAGES].join(", ")}`,
        });
        return;
      }

      // Rate limit
      if (!checkRateLimit(agentId)) {
        res.status(429).json({
          error: `Rate limit exceeded: max ${MAX_EXEC_PER_HOUR} executions per hour`,
        });
        return;
      }

      // Pre-deduct base credit cost
      const execRequestId = `exec-${crypto.randomUUID()}`;
      try {
        await creditManager.deductCredits(agentId, EXEC_BASE_COST, execRequestId, "sandbox_exec");
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg === "INSUFFICIENT_CREDITS" || errMsg === "ACCOUNT_NOT_FOUND") {
          res.status(402).json({ error: "Insufficient credits for sandbox execution" });
          return;
        }
        if (errMsg === "DAILY_SPEND_LIMIT") {
          res.status(402).json({ error: "Daily spend limit reached" });
          return;
        }
        throw error;
      }

      // Collect stdout/stderr
      let stdout = "";
      let stderr = "";

      try {
        const timeoutMs = timeout ? timeout * 1000 : undefined;
        const result = await execService.startExecution(
          {
            agentId,
            projectId: projectId || "rest-exec",
            command,
            image,
            files: files || {},
            timeoutMs,
          },
          (data) => { stdout += data; },
          (data) => { stderr += data; },
        );

        // Calculate time surcharge
        const surcharge = Math.ceil(result.durationMs / 1000) * EXEC_COST_PER_SECOND;
        const totalCharged = EXEC_BASE_COST + surcharge;

        // Deduct time surcharge (fire-and-forget)
        if (surcharge > 0) {
          creditManager
            .deductCredits(agentId, surcharge, `${execRequestId}-surcharge`, "sandbox_exec_time")
            .catch((err) => {
              logSecurityEvent("warn", "exec-surcharge-failed", {
                agentId,
                surcharge,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }

        // Log to audit table
        try {
          await pool.query(
            `INSERT INTO exec_audit_log (agent_id, project_id, image, command, exit_code, duration_ms, credits_charged)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [agentId, projectId || "rest-exec", image, command.slice(0, 1000), result.exitCode, result.durationMs, totalCharged],
          );
        } catch {
          // Non-critical
        }

        // Convert stored units to display units for response
        const creditsChargedDisplay = totalCharged / 100;

        res.json({
          exitCode: result.exitCode,
          stdout,
          stderr,
          durationMs: result.durationMs,
          creditsCharged: creditsChargedDisplay,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Execution failed";

        // Refund base cost on execution failure
        creditManager
          .addCredits(agentId, EXEC_BASE_COST, "sandbox_exec_refund", `${execRequestId}-refund`)
          .catch((refundErr) => {
            logSecurityEvent("warn", "exec-refund-failed", {
              agentId,
              error: refundErr instanceof Error ? refundErr.message : String(refundErr),
            });
          });

        logSecurityEvent("error", "exec-rest-failed", {
          agentId,
          projectId: projectId || "rest-exec",
          image,
          error: message,
        });

        res.status(500).json({ error: "Execution failed." });
      }
    },
  );

  return router;
}
