/**
 * SwarmService — N-agent parallel coordination: task decomposition,
 * subtask claiming, result submission, and output aggregation.
 *
 * Off-chain credit-gated operations.
 * A swarm is a high-level task decomposed into subtasks that agents claim
 * and execute in parallel. Results merge into a shared workspace.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SWARM_CREATE_COST = 50;    // 0.50 credits
const SUBTASK_CLAIM_COST = 5;    // 0.05 credits
const RESULT_SUBMIT_COST = 10;   // 0.10 credits

const VALID_SWARM_STATUSES = new Set(["open", "in_progress", "aggregating", "completed", "cancelled"]);
const VALID_SUBTASK_STATUSES = new Set(["open", "claimed", "in_progress", "submitted", "accepted", "rejected"]);
const VALID_RESULT_TYPES = new Set(["output", "hypothesis", "test", "diagnosis"]);

// ─── Service ──────────────────────────────────────────────────────────────────

export class SwarmService {
  private readonly pool: pg.Pool;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private creditManager: any = null;
  private messageBus: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setCreditManager(cm: any): void { this.creditManager = cm; }
  setMessageBus(mb: any): void { this.messageBus = mb; }

  // ============================================================
  //  Create Swarm
  // ============================================================

  /** Create a new swarm with subtasks decomposed from a high-level task. */
  async createSwarm(
    agentId: string,
    input: {
      title: string;
      description?: string;
      workspaceId?: string;
      subtasks: Array<{
        title: string;
        description?: string;
        skillTags?: string[];
        priority?: number;
        dependsOn?: number[];  // indices into the subtasks array
      }>;
    },
  ): Promise<any> {
    if (!input.title) throw Object.assign(new Error("title is required"), { code: "VALIDATION" });
    if (!input.subtasks || input.subtasks.length === 0) {
      throw Object.assign(new Error("At least one subtask is required"), { code: "VALIDATION" });
    }
    if (input.subtasks.length > 50) {
      throw Object.assign(new Error("Maximum 50 subtasks per swarm"), { code: "VALIDATION" });
    }

    // Create swarm
    const swarmId = randomUUID();

    // Charge credits
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, SWARM_CREATE_COST, `swarm_create:${swarmId}`, "swarm_create");
      } catch {
        throw Object.assign(new Error("Insufficient credits"), { code: "INSUFFICIENT_CREDITS" });
      }
    }
    await this.pool.query(
      `INSERT INTO swarms (id, workspace_id, creator_id, title, description, subtask_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [swarmId, input.workspaceId || null, agentId, input.title, input.description || null, input.subtasks.length],
    );

    // Create subtasks
    const subtaskIds: string[] = [];
    for (const st of input.subtasks) {
      const subtaskId = randomUUID();
      subtaskIds.push(subtaskId);
    }

    // Second pass to resolve dependsOn references
    for (let i = 0; i < input.subtasks.length; i++) {
      const st = input.subtasks[i];
      const dependsOn = st.dependsOn?.map(idx => subtaskIds[idx]).filter(Boolean) || [];
      await this.pool.query(
        `INSERT INTO swarm_subtasks (id, swarm_id, title, description, skill_tags, priority, depends_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [subtaskIds[i], swarmId, st.title, st.description || null,
         st.skillTags || [], st.priority || 0, dependsOn.length > 0 ? dependsOn : null],
      );
    }

    this.publishEvent(swarmId, "swarm.created", {
      swarmId, creatorId: agentId, title: input.title, subtaskCount: input.subtasks.length,
    });

    return this.getSwarm(swarmId);
  }

  // ============================================================
  //  Claim Subtask
  // ============================================================

  /** Agent claims an open subtask. */
  async claimSubtask(agentId: string, subtaskId: string): Promise<any> {
    // Check subtask exists and is open
    const stResult = await this.pool.query(
      `SELECT * FROM swarm_subtasks WHERE id = $1`,
      [subtaskId],
    );
    if (stResult.rowCount === 0) {
      throw Object.assign(new Error("Subtask not found"), { code: "NOT_FOUND" });
    }
    const subtask = stResult.rows[0];

    if (subtask.status !== "open") {
      throw Object.assign(new Error(`Subtask is ${subtask.status}, not open`), { code: "SUBTASK_NOT_OPEN" });
    }

    // Check dependencies are completed
    if (subtask.depends_on?.length > 0) {
      const depResult = await this.pool.query(
        `SELECT COUNT(*) AS incomplete FROM swarm_subtasks
         WHERE id = ANY($1) AND status NOT IN ('accepted', 'submitted')`,
        [subtask.depends_on],
      );
      if (Number(depResult.rows[0].incomplete) > 0) {
        throw Object.assign(new Error("Dependencies not yet completed"), { code: "DEPS_INCOMPLETE" });
      }
    }

    // Charge credits
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, SUBTASK_CLAIM_COST, `subtask_claim:${subtaskId}`, "swarm_subtask_claim");
      } catch {
        throw Object.assign(new Error("Insufficient credits"), { code: "INSUFFICIENT_CREDITS" });
      }
    }

    // Claim
    const updateResult = await this.pool.query(
      `UPDATE swarm_subtasks SET status = 'claimed', assignee_id = $1, claimed_at = NOW()
       WHERE id = $2 AND status = 'open'
       RETURNING *`,
      [agentId, subtaskId],
    );
    if (updateResult.rowCount === 0) {
      throw Object.assign(new Error("Subtask was claimed by another agent"), { code: "CONFLICT" });
    }

    // Update swarm status to in_progress
    await this.pool.query(
      `UPDATE swarms SET status = 'in_progress', updated_at = NOW() WHERE id = $1 AND status = 'open'`,
      [subtask.swarm_id],
    );

    this.publishEvent(subtask.swarm_id, "swarm.subtask_claimed", {
      swarmId: subtask.swarm_id, subtaskId, agentId,
    });

    return updateResult.rows[0];
  }

  // ============================================================
  //  Submit Result
  // ============================================================

  /** Agent submits result for a claimed subtask. */
  async submitResult(
    agentId: string,
    subtaskId: string,
    content: any,
    resultType?: string,
  ): Promise<any> {
    const stResult = await this.pool.query(
      `SELECT * FROM swarm_subtasks WHERE id = $1`,
      [subtaskId],
    );
    if (stResult.rowCount === 0) {
      throw Object.assign(new Error("Subtask not found"), { code: "NOT_FOUND" });
    }
    const subtask = stResult.rows[0];

    if (subtask.assignee_id !== agentId) {
      throw Object.assign(new Error("Only the assigned agent can submit results"), { code: "FORBIDDEN" });
    }
    if (!["claimed", "in_progress"].includes(subtask.status)) {
      throw Object.assign(new Error(`Cannot submit for subtask with status ${subtask.status}`), { code: "INVALID_STATUS" });
    }

    const rType = resultType || "output";
    if (!VALID_RESULT_TYPES.has(rType)) {
      throw Object.assign(new Error(`Invalid result type. Must be: ${[...VALID_RESULT_TYPES].join(", ")}`), { code: "VALIDATION" });
    }

    // Charge credits
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, RESULT_SUBMIT_COST, `result_submit:${subtaskId}`, "swarm_result_submit");
      } catch {
        throw Object.assign(new Error("Insufficient credits"), { code: "INSUFFICIENT_CREDITS" });
      }
    }

    // Save result
    const resultId = randomUUID();
    await this.pool.query(
      `INSERT INTO swarm_results (id, swarm_id, subtask_id, agent_id, result_type, content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [resultId, subtask.swarm_id, subtaskId, agentId, rType, JSON.stringify(content)],
    );

    // Update subtask status
    await this.pool.query(
      `UPDATE swarm_subtasks SET status = 'submitted', result = $1, submitted_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(content), subtaskId],
    );

    // Check if all subtasks completed → mark swarm as aggregating
    const swarmResult = await this.pool.query(
      `UPDATE swarms SET
         completed_count = (SELECT COUNT(*) FROM swarm_subtasks WHERE swarm_id = $1 AND status IN ('submitted', 'accepted')),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [subtask.swarm_id],
    );
    const swarm = swarmResult.rows[0];
    if (swarm && swarm.completed_count >= swarm.subtask_count) {
      await this.pool.query(
        `UPDATE swarms SET status = 'aggregating', updated_at = NOW() WHERE id = $1`,
        [subtask.swarm_id],
      );
    }

    this.publishEvent(subtask.swarm_id, "swarm.result_submitted", {
      swarmId: subtask.swarm_id, subtaskId, agentId, resultType: rType,
    });

    return { id: resultId, subtaskId, resultType: rType, content };
  }

  // ============================================================
  //  Accept / Reject Subtask Result
  // ============================================================

  /** Swarm creator accepts a submitted subtask result. */
  async acceptResult(agentId: string, subtaskId: string): Promise<any> {
    const subtask = await this.getSubtaskInternal(subtaskId);
    const swarm = await this.getSwarmInternal(subtask.swarm_id);

    if (swarm.creator_id !== agentId) {
      throw Object.assign(new Error("Only swarm creator can accept results"), { code: "FORBIDDEN" });
    }
    if (subtask.status !== "submitted") {
      throw Object.assign(new Error("Subtask must be in submitted status"), { code: "INVALID_STATUS" });
    }

    await this.pool.query(
      `UPDATE swarm_subtasks SET status = 'accepted' WHERE id = $1`,
      [subtaskId],
    );

    // Update completed count
    await this.pool.query(
      `UPDATE swarms SET
         completed_count = (SELECT COUNT(*) FROM swarm_subtasks WHERE swarm_id = $1 AND status = 'accepted'),
         updated_at = NOW()
       WHERE id = $1`,
      [subtask.swarm_id],
    );

    this.publishEvent(subtask.swarm_id, "swarm.result_accepted", {
      swarmId: subtask.swarm_id, subtaskId,
    });

    return { subtaskId, status: "accepted" };
  }

  /** Swarm creator rejects a submitted subtask result with feedback. */
  async rejectResult(agentId: string, subtaskId: string, feedback: string): Promise<any> {
    const subtask = await this.getSubtaskInternal(subtaskId);
    const swarm = await this.getSwarmInternal(subtask.swarm_id);

    if (swarm.creator_id !== agentId) {
      throw Object.assign(new Error("Only swarm creator can reject results"), { code: "FORBIDDEN" });
    }
    if (subtask.status !== "submitted") {
      throw Object.assign(new Error("Subtask must be in submitted status"), { code: "INVALID_STATUS" });
    }

    // Reset to claimed so agent can resubmit
    await this.pool.query(
      `UPDATE swarm_subtasks SET status = 'claimed', feedback = $1, result = NULL, submitted_at = NULL WHERE id = $2`,
      [feedback, subtaskId],
    );

    this.publishEvent(subtask.swarm_id, "swarm.result_rejected", {
      swarmId: subtask.swarm_id, subtaskId, feedback,
    });

    return { subtaskId, status: "rejected", feedback };
  }

  // ============================================================
  //  Aggregate Results
  // ============================================================

  /** Complete swarm by aggregating all accepted results into a summary. */
  async aggregateResults(
    agentId: string,
    swarmId: string,
    summary: any,
  ): Promise<any> {
    const swarm = await this.getSwarmInternal(swarmId);

    if (swarm.creator_id !== agentId) {
      throw Object.assign(new Error("Only swarm creator can aggregate"), { code: "FORBIDDEN" });
    }
    if (!["in_progress", "aggregating"].includes(swarm.status)) {
      throw Object.assign(new Error("Swarm must be in progress or aggregating"), { code: "INVALID_STATUS" });
    }

    await this.pool.query(
      `UPDATE swarms SET status = 'completed', result_summary = $1, completed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(summary), swarmId],
    );

    this.publishEvent(swarmId, "swarm.completed", {
      swarmId, summary,
    });

    return this.getSwarm(swarmId);
  }

  // ============================================================
  //  Cancel Swarm
  // ============================================================

  /** Cancel an open or in-progress swarm. */
  async cancelSwarm(agentId: string, swarmId: string): Promise<void> {
    const swarm = await this.getSwarmInternal(swarmId);

    if (swarm.creator_id !== agentId) {
      throw Object.assign(new Error("Only swarm creator can cancel"), { code: "FORBIDDEN" });
    }
    if (swarm.status === "completed" || swarm.status === "cancelled") {
      throw Object.assign(new Error("Swarm is already finished"), { code: "INVALID_STATUS" });
    }

    await this.pool.query(
      `UPDATE swarms SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [swarmId],
    );

    // Release all claimed subtasks
    await this.pool.query(
      `UPDATE swarm_subtasks SET status = 'open', assignee_id = NULL, claimed_at = NULL
       WHERE swarm_id = $1 AND status IN ('claimed', 'in_progress')`,
      [swarmId],
    );

    this.publishEvent(swarmId, "swarm.cancelled", { swarmId });
  }

  // ============================================================
  //  Read Methods
  // ============================================================

  /** Get swarm with subtasks. */
  async getSwarm(swarmId: string): Promise<any> {
    const swarmResult = await this.pool.query(`SELECT * FROM swarms WHERE id = $1`, [swarmId]);
    if (swarmResult.rowCount === 0) {
      throw Object.assign(new Error("Swarm not found"), { code: "NOT_FOUND" });
    }

    const subtasksResult = await this.pool.query(
      `SELECT * FROM swarm_subtasks WHERE swarm_id = $1 ORDER BY priority DESC, created_at ASC`,
      [swarmId],
    );

    return {
      ...swarmResult.rows[0],
      subtasks: subtasksResult.rows,
    };
  }

  /** List swarms with optional filters. */
  async listSwarms(opts?: {
    workspaceId?: string;
    creatorId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const params: any[] = [];
    const conditions: string[] = [];

    if (opts?.workspaceId) {
      params.push(opts.workspaceId);
      conditions.push(`workspace_id = $${params.length}`);
    }
    if (opts?.creatorId) {
      params.push(opts.creatorId);
      conditions.push(`creator_id = $${params.length}`);
    }
    if (opts?.status) {
      params.push(opts.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(opts?.limit || 50, 100);
    const offset = opts?.offset || 0;

    params.push(limit, offset);
    const result = await this.pool.query(
      `SELECT * FROM swarms ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows;
  }

  /** Get open subtasks that match an agent's skills. */
  async getAvailableSubtasks(opts?: {
    swarmId?: string;
    skillTags?: string[];
    limit?: number;
  }): Promise<any[]> {
    const params: any[] = [];
    const conditions: string[] = ["st.status = 'open'"];

    if (opts?.swarmId) {
      params.push(opts.swarmId);
      conditions.push(`st.swarm_id = $${params.length}`);
    }
    if (opts?.skillTags?.length) {
      params.push(opts.skillTags);
      conditions.push(`st.skill_tags && $${params.length}`);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(opts?.limit || 50, 100);
    params.push(limit);

    const result = await this.pool.query(
      `SELECT st.*, s.title AS swarm_title FROM swarm_subtasks st
       JOIN swarms s ON s.id = st.swarm_id
       ${where}
       ORDER BY st.priority DESC, st.created_at ASC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows;
  }

  /** Get results for a swarm. */
  async getResults(swarmId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM swarm_results WHERE swarm_id = $1 ORDER BY created_at ASC`,
      [swarmId],
    );
    return result.rows;
  }

  // ============================================================
  //  Internal Helpers
  // ============================================================

  private async getSwarmInternal(swarmId: string): Promise<any> {
    const result = await this.pool.query(`SELECT * FROM swarms WHERE id = $1`, [swarmId]);
    if (result.rowCount === 0) {
      throw Object.assign(new Error("Swarm not found"), { code: "NOT_FOUND" });
    }
    return result.rows[0];
  }

  private async getSubtaskInternal(subtaskId: string): Promise<any> {
    const result = await this.pool.query(`SELECT * FROM swarm_subtasks WHERE id = $1`, [subtaskId]);
    if (result.rowCount === 0) {
      throw Object.assign(new Error("Subtask not found"), { code: "NOT_FOUND" });
    }
    return result.rows[0];
  }

  private publishEvent(swarmId: string, type: string, data: any): void {
    if (!this.messageBus) return;
    try {
      this.messageBus.publish(`swarm:${swarmId}`, { type, data, ts: Date.now() });
    } catch (err) {
      logSecurityEvent("warn", "swarm-event-publish-failed", { swarmId, type, error: String(err) });
    }
  }
}
