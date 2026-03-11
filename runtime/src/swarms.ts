/**
 * Swarm manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps REST operations for N-agent parallel coordination:
 * create swarms, claim subtasks, submit results, aggregate outputs.
 *
 * @module swarms
 */

import type { ConnectionManager } from "./connection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateSwarmInput {
  title: string;
  description?: string;
  workspaceId?: string;
  subtasks: Array<{
    title: string;
    description?: string;
    skillTags?: string[];
    priority?: number;
    dependsOn?: number[];
  }>;
}

export interface Swarm {
  id: string;
  workspace_id: string | null;
  creator_id: string;
  title: string;
  description: string | null;
  status: string;
  subtask_count: number;
  completed_count: number;
  result_summary: unknown;
  subtasks?: SwarmSubtask[];
  created_at: string;
  completed_at: string | null;
}

export interface SwarmSubtask {
  id: string;
  swarm_id: string;
  title: string;
  description: string | null;
  skill_tags: string[];
  status: string;
  assignee_id: string | null;
  priority: number;
  depends_on: string[] | null;
  result: unknown;
  feedback: string | null;
  created_at: string;
  claimed_at: string | null;
  submitted_at: string | null;
}

export interface SwarmResult {
  id: string;
  swarm_id: string;
  subtask_id: string | null;
  agent_id: string;
  result_type: string;
  content: unknown;
  quality_score: number | null;
  created_at: string;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class SwarmManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ── Write Operations ──

  /** Create a new swarm with decomposed subtasks (0.50 credits). */
  async create(input: CreateSwarmInput): Promise<Swarm> {
    return this.connection.request<Swarm>("POST", "/v1/swarms", input);
  }

  /** Claim an open subtask (0.05 credits). */
  async claimSubtask(subtaskId: string): Promise<SwarmSubtask> {
    return this.connection.request<SwarmSubtask>("POST", `/v1/swarms/subtasks/${subtaskId}/claim`);
  }

  /** Submit result for a claimed subtask (0.10 credits). */
  async submitResult(subtaskId: string, content: unknown, resultType?: string): Promise<unknown> {
    return this.connection.request("POST", `/v1/swarms/subtasks/${subtaskId}/submit`, { content, resultType });
  }

  /** Accept a submitted subtask result (creator only). */
  async acceptResult(subtaskId: string): Promise<unknown> {
    return this.connection.request("POST", `/v1/swarms/subtasks/${subtaskId}/accept`);
  }

  /** Reject a submitted subtask result with feedback (creator only). */
  async rejectResult(subtaskId: string, feedback: string): Promise<unknown> {
    return this.connection.request("POST", `/v1/swarms/subtasks/${subtaskId}/reject`, { feedback });
  }

  /** Complete swarm by aggregating all results into a summary (creator only). */
  async aggregate(swarmId: string, summary: unknown): Promise<Swarm> {
    return this.connection.request<Swarm>("POST", `/v1/swarms/${swarmId}/aggregate`, { summary });
  }

  /** Cancel an open or in-progress swarm (creator only). */
  async cancel(swarmId: string): Promise<void> {
    await this.connection.request("POST", `/v1/swarms/${swarmId}/cancel`);
  }

  // ── Read Operations ──

  /** Get swarm detail with subtasks. */
  async get(swarmId: string): Promise<Swarm> {
    return this.connection.request<Swarm>("GET", `/v1/swarms/${swarmId}`);
  }

  /** List swarms with optional filters. */
  async list(opts?: {
    workspaceId?: string;
    mine?: boolean;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<Swarm[]> {
    const params = new URLSearchParams();
    if (opts?.workspaceId) params.set("workspaceId", opts.workspaceId);
    if (opts?.mine) params.set("mine", "true");
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request<Swarm[]>("GET", `/v1/swarms${qs ? `?${qs}` : ""}`);
  }

  /** Get available (open) subtasks, optionally filtered by skill tags. */
  async getAvailableSubtasks(opts?: {
    swarmId?: string;
    skillTags?: string[];
    limit?: number;
  }): Promise<SwarmSubtask[]> {
    const params = new URLSearchParams();
    if (opts?.swarmId) params.set("swarmId", opts.swarmId);
    if (opts?.skillTags?.length) params.set("skills", opts.skillTags.join(","));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.connection.request<SwarmSubtask[]>("GET", `/v1/swarms/subtasks${qs ? `?${qs}` : ""}`);
  }

  /** Get all results for a swarm. */
  async getResults(swarmId: string): Promise<SwarmResult[]> {
    return this.connection.request<SwarmResult[]>("GET", `/v1/swarms/${swarmId}/results`);
  }

  // ── WS Events ──

  /** Subscribe to swarm creation events. */
  onSwarmCreated(handler: (event: any) => void | Promise<void>): void {
    this.connection.on("swarm.created", handler);
  }

  /** Subscribe to subtask claimed events. */
  onSubtaskClaimed(handler: (event: any) => void | Promise<void>): void {
    this.connection.on("swarm.subtask_claimed", handler);
  }

  /** Subscribe to result submitted events. */
  onResultSubmitted(handler: (event: any) => void | Promise<void>): void {
    this.connection.on("swarm.result_submitted", handler);
  }

  /** Subscribe to swarm completed events. */
  onSwarmCompleted(handler: (event: any) => void | Promise<void>): void {
    this.connection.on("swarm.completed", handler);
  }
}
