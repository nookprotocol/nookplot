/**
 * Action executor for the agent autonomy system.
 *
 * Processes approved actions from the proactive_actions table by:
 * 1. Polling for approved but unexecuted actions
 * 2. Looking up the handler from the ActionRegistry
 * 3. Checking credit balance and rate limits
 * 4. Running the handler
 * 5. Logging results to action_execution_log
 *
 * This closes the "approved actions have no pickup mechanism" gap
 * that existed in the original proactive loop.
 *
 * @module services/actionExecutor
 */

import type pg from "pg";
import type { ActionRegistry, ActionResult, ExecutionContext, AutonomyLevel } from "./actionRegistry.js";
import type { CreditManager } from "./creditManager.js";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { createHash } from "node:crypto";

// ============================================================
//  Types
// ============================================================

export interface ExecutionLogEntry {
  id: string;
  agentId: string;
  toolName: string;
  status: string;
  creditsCharged: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ============================================================
//  ActionExecutor
// ============================================================

export class ActionExecutor {
  private readonly pool: pg.Pool;
  private readonly registry: ActionRegistry;
  private readonly creditManager: CreditManager;

  constructor(
    pool: pg.Pool,
    registry: ActionRegistry,
    creditManager: CreditManager,
  ) {
    this.pool = pool;
    this.registry = registry;
    this.creditManager = creditManager;
  }

  /**
   * Process all approved but unexecuted actions.
   * Called from ProactiveScheduler's tick loop.
   * Processes up to 10 actions per tick to avoid blocking.
   */
  async processApprovedActions(): Promise<{ executed: number; failed: number }> {
    let executed = 0;
    let failed = 0;

    try {
      // Find approved actions that haven't been completed or started.
      // FOR UPDATE SKIP LOCKED prevents duplicate execution across concurrent gateway instances.
      const { rows } = await this.pool.query<{
        id: string;
        agent_id: string;
        action_type: string;
        payload: string;
        inference_cost: number;
      }>(
        `SELECT id, agent_id, action_type, payload, inference_cost
         FROM proactive_actions
         WHERE status = 'approved'
           AND completed_at IS NULL
         ORDER BY created_at ASC
         LIMIT 10
         FOR UPDATE SKIP LOCKED`,
      );

      for (const row of rows) {
        try {
          const result = await this.executeAction(
            row.id,
            row.agent_id,
            row.action_type,
            typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
          );

          if (result.success) {
            executed++;
          } else {
            failed++;
          }
        } catch (error) {
          failed++;
          logSecurityEvent("warn", "action-executor-error", {
            actionId: row.id,
            agentId: row.agent_id,
            actionType: row.action_type,
            error: error instanceof Error ? error.message : String(error),
          });

          // Mark as failed
          await this.pool.query(
            `UPDATE proactive_actions
             SET status = 'failed', completed_at = NOW(),
                 result = $2
             WHERE id = $1`,
            [row.id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })],
          );
        }
      }
    } catch (error) {
      logSecurityEvent("error", "action-executor-process-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { executed, failed };
  }

  /**
   * Execute a single action by ID.
   */
  async executeAction(
    actionId: string,
    agentId: string,
    actionType: string,
    payload: Record<string, unknown>,
  ): Promise<ActionResult> {
    const startTime = Date.now();

    // Look up tool handler
    const handler = this.registry.getHandler(actionType);
    if (!handler) {
      const error = `No handler registered for action type: ${actionType}`;
      await this.markActionFailed(actionId, error);
      await this.logExecution(agentId, actionType, payload, "failed", 0, Date.now() - startTime, error);
      return { success: false, output: {}, creditsUsed: 0, error };
    }

    // Rate limit enforcement: check action_execution_log against registry limits
    const rateLimit = this.registry.getRateLimit(actionType);
    try {
      const { rows: rateCounts } = await this.pool.query<{ hourly: string; daily: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS hourly,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') AS daily
         FROM action_execution_log
         WHERE agent_id = $1 AND tool_name = $2 AND status != 'failed'`,
        [agentId, actionType],
      );
      const hourly = parseInt(rateCounts[0]?.hourly ?? "0", 10);
      const daily = parseInt(rateCounts[0]?.daily ?? "0", 10);

      if (hourly >= rateLimit.maxPerHour) {
        const error = `Rate limit exceeded: ${actionType} (${hourly}/${rateLimit.maxPerHour} per hour)`;
        await this.markActionFailed(actionId, error);
        await this.logExecution(agentId, actionType, payload, "rate_limited", 0, Date.now() - startTime, error);
        return { success: false, output: {}, creditsUsed: 0, error };
      }
      if (daily >= rateLimit.maxPerDay) {
        const error = `Rate limit exceeded: ${actionType} (${daily}/${rateLimit.maxPerDay} per day)`;
        await this.markActionFailed(actionId, error);
        await this.logExecution(agentId, actionType, payload, "rate_limited", 0, Date.now() - startTime, error);
        return { success: false, output: {}, creditsUsed: 0, error };
      }
    } catch (rateLimitError) {
      logSecurityEvent("error", "rate-limit-check-failed-blocking", {
        agentId,
        actionType,
        error: rateLimitError instanceof Error ? rateLimitError.message : String(rateLimitError),
      });
      // Fail closed — block execution if rate limits can't be verified
      const error = "Rate limit check unavailable — action blocked for safety.";
      await this.markActionFailed(actionId, error);
      await this.logExecution(agentId, actionType, payload, "failed", 0, Date.now() - startTime, error);
      return { success: false, output: {}, creditsUsed: 0, error };
    }

    // Check credit balance
    const balance = await this.creditManager.getBalance(agentId);
    const estimatedCost = this.registry.getCost(actionType);
    if (!balance || balance.balance < estimatedCost || balance.status === "paused") {
      const error = "Insufficient credits or account paused";
      await this.markActionFailed(actionId, error);
      await this.logExecution(agentId, actionType, payload, "failed", 0, Date.now() - startTime, error);
      return { success: false, output: {}, creditsUsed: 0, error };
    }

    // Pre-deduct estimated credits (atomic — throws on insufficient balance)
    try {
      await this.creditManager.deductCredits(agentId, estimatedCost, actionId);
    } catch (deductError) {
      const error = `Credit deduction failed: ${deductError instanceof Error ? deductError.message : String(deductError)}`;
      await this.markActionFailed(actionId, error);
      await this.logExecution(agentId, actionType, payload, "failed", 0, Date.now() - startTime, error);
      return { success: false, output: {}, creditsUsed: 0, error };
    }

    // Mark as in-progress
    await this.pool.query(
      `UPDATE proactive_actions SET status = 'executing' WHERE id = $1`,
      [actionId],
    );

    // Build execution context
    const context: ExecutionContext = {
      agentId,
      agentAddress: "", // Could be enriched from agents table if needed
      creditBalance: balance.balance - estimatedCost,
      autonomyLevel: "semi-autonomous" as AutonomyLevel,
    };

    // Execute
    let result: ActionResult;
    try {
      result = await handler(agentId, payload, context);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.markActionFailed(actionId, errorMsg);
      await this.logExecution(agentId, actionType, payload, "failed", estimatedCost, Date.now() - startTime, errorMsg);
      // Credits already deducted — no refund on handler crash (prevents abuse)
      return { success: false, output: {}, creditsUsed: estimatedCost, error: errorMsg };
    }

    const durationMs = Date.now() - startTime;

    if (result.success) {
      // Mark action as completed
      await this.pool.query(
        `UPDATE proactive_actions
         SET status = 'completed', completed_at = NOW(), result = $2
         WHERE id = $1`,
        [actionId, JSON.stringify(result.output)],
      );

      await this.logExecution(agentId, actionType, payload, "completed", estimatedCost, durationMs, null);
    } else {
      await this.markActionFailed(actionId, result.error ?? "Handler returned failure");
      await this.logExecution(agentId, actionType, payload, "failed", estimatedCost, durationMs, result.error ?? null);
    }

    return result;
  }

  /**
   * Execute a tool directly (not from the proactive loop).
   * Used by POST /v1/actions/execute endpoint.
   * Returns immediately if approval is required.
   */
  async executeDirectly(
    agentId: string,
    toolName: string,
    payload: Record<string, unknown>,
    autonomyLevel: AutonomyLevel,
  ): Promise<{ result?: ActionResult; requiresApproval: boolean; actionId?: string }> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        result: { success: false, output: {}, creditsUsed: 0, error: `Unknown tool: ${toolName}` },
        requiresApproval: false,
      };
    }

    // Check if tool is enabled for this agent
    const configResult = await this.pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM agent_tool_config WHERE agent_id = $1 AND tool_name = $2`,
      [agentId, toolName],
    );
    if (configResult.rows.length > 0 && !configResult.rows[0].enabled) {
      return {
        result: { success: false, output: {}, creditsUsed: 0, error: `Tool "${toolName}" is disabled for this agent` },
        requiresApproval: false,
      };
    }

    // Determine if approval is needed
    const needsApproval = this.checkRequiresApproval(
      autonomyLevel,
      toolName,
      tool.cost,
    );

    if (needsApproval) {
      // Create a pending action for approval
      const insertResult = await this.pool.query<{ id: string }>(
        `INSERT INTO proactive_actions
          (agent_id, action_type, payload, status, inference_cost)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING id`,
        [agentId, toolName, JSON.stringify(payload), tool.cost],
      );
      return { requiresApproval: true, actionId: insertResult.rows[0].id };
    }

    // Execute immediately
    const result = await this.executeAction(
      "", // No action ID for direct execution
      agentId,
      toolName,
      payload,
    );

    return { result, requiresApproval: false };
  }

  /**
   * Get execution log for an agent.
   */
  async getExecutionLog(
    agentId: string,
    limit = 50,
    offset = 0,
  ): Promise<ExecutionLogEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      agent_id: string;
      tool_name: string;
      status: string;
      credits_charged: number;
      duration_ms: number | null;
      error_message: string | null;
      created_at: string;
      completed_at: string | null;
    }>(
      `SELECT id, agent_id, tool_name, status, credits_charged, duration_ms,
              error_message, created_at, completed_at
       FROM action_execution_log
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset],
    );

    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      toolName: r.tool_name,
      status: r.status,
      creditsCharged: r.credits_charged,
      durationMs: r.duration_ms,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));
  }

  // ---- Private helpers ----

  /**
   * Check if action requires approval based on autonomy level.
   * Uses registry for tool defaults, respects per-agent overrides.
   */
  private checkRequiresApproval(
    autonomyLevel: AutonomyLevel,
    toolName: string,
    estimatedCost: number,
  ): boolean {
    // Claim_bounty always requires approval (v1 safety)
    const toolAutonomy = this.registry.getAutonomyLevel(toolName);
    if (toolAutonomy === "supervised") return true;

    switch (autonomyLevel) {
      case "supervised":
        return true;
      case "semi-autonomous":
        return estimatedCost > 2500; // High-cost threshold
      case "autonomous":
        return false;
      case "fully-autonomous":
        return false;
      default:
        return true;
    }
  }

  private async markActionFailed(actionId: string, error: string): Promise<void> {
    if (!actionId) return; // Direct executions may not have an action ID
    await this.pool.query(
      `UPDATE proactive_actions
       SET status = 'failed', completed_at = NOW(), result = $2
       WHERE id = $1`,
      [actionId, JSON.stringify({ error })],
    );
  }

  private async logExecution(
    agentId: string,
    toolName: string,
    payload: Record<string, unknown>,
    status: string,
    creditsCharged: number,
    durationMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      const inputHash = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex")
        .slice(0, 64);

      await this.pool.query(
        `INSERT INTO action_execution_log
          (agent_id, tool_name, input_hash, status, credits_charged, duration_ms, error_message, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 != 'pending' THEN NOW() ELSE NULL END)`,
        [agentId, toolName, inputHash, status, creditsCharged, durationMs, errorMessage],
      );
    } catch (error) {
      logSecurityEvent("warn", "action-execution-log-failed", {
        agentId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clean up actions stuck in 'executing' or 'approved' state for longer than the timeout.
   * Called periodically from the scheduler tick loop to prevent queue clogging.
   *
   * Actions in 'executing' state for >30 minutes are assumed to have been dropped
   * by a crashed agent. Actions in 'approved' state for >2 hours are assumed stale.
   */
  async cleanupStaleActions(): Promise<number> {
    try {
      const { rowCount } = await this.pool.query(
        `UPDATE proactive_actions
         SET status = 'failed',
             completed_at = NOW(),
             result = '{"error":"Timed out — agent did not complete action"}'
         WHERE (
           (status = 'executing' AND created_at < NOW() - INTERVAL '30 minutes')
           OR
           (status = 'approved' AND created_at < NOW() - INTERVAL '2 hours')
         )
         AND completed_at IS NULL`,
      );

      if (rowCount && rowCount > 0) {
        logSecurityEvent("info", "stale-actions-cleaned", { count: rowCount });
      }

      return rowCount ?? 0;
    } catch (error) {
      logSecurityEvent("warn", "stale-action-cleanup-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
