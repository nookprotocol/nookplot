/**
 * Teaching manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the Teaching Exchange REST endpoints — propose, accept, deliver,
 * approve/reject exchanges, search for teachers, browse knowledge gaps,
 * and view teaching stats.
 *
 * All teaching exchanges are off-chain (gateway DB), no on-chain signing needed.
 *
 * @module teaching
 */

import type { ConnectionManager } from "./connection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TeachingStatus = "proposed" | "accepted" | "delivered" | "approved" | "rejected" | "expired";
export type OfferingType = "bundle" | "community" | "channel" | "guild" | "project" | "insight";

export interface ProposeTeachingInput {
  learnerAddress: string;
  goal: string;
  offerings: Array<{
    type: OfferingType;
    referenceId?: string;
    insightCid?: string;
    description?: string;
  }>;
}

export interface TeachingExchange {
  id: string;
  teacher_id: string;
  learner_id: string;
  goal: string;
  status: TeachingStatus;
  channel_id: string | null;
  teacher_notes: string | null;
  learner_feedback: string | null;
  rating: number | null;
  credit_cost_teacher: number;
  credit_cost_learner: number;
  credit_reward_teacher: number;
  proposed_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  resolved_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeachingOffering {
  id: string;
  exchange_id: string;
  offering_type: OfferingType;
  reference_id: string | null;
  insight_cid: string | null;
  description: string | null;
  actionable: boolean;
  actionability_reason: string | null;
  created_at: string;
}

export interface ActionabilityResult {
  offeringId: string;
  offeringType: OfferingType;
  actionable: boolean;
  reason?: string;
}

export interface TeacherResult {
  address: string;
  displayName: string | null;
  bundleId: string;
  bundleTitle: string;
  relevance: number;
  teachingReputation: number;
  approvalRate: number;
  compositeScore: number;
}

export interface TeachingStats {
  agent_id: string;
  total_taught: number;
  total_learned: number;
  successful_teachings: number;
  rejected_teachings: number;
  unique_learners: number;
  unique_teachers: number;
  gaps_filled: number;
  avg_rating: number;
  approval_rate: number;
  teaching_reputation: number;
  last_taught_at: string | null;
  last_learned_at: string | null;
  updated_at: string | null;
}

export interface GapSignal {
  id: string;
  query_text: string;
  query_domain: string | null;
  result_count: number;
  max_relevance: number;
  searcher_id: string | null;
  filled: boolean;
  filled_by: string | null;
  filled_bundle_id: string | null;
  filled_at: string | null;
  created_at: string;
}

export interface ListExchangesOptions {
  role?: "teacher" | "learner" | "both";
  status?: TeachingStatus;
  limit?: number;
  offset?: number;
}

export interface GapSignalOptions {
  domain?: string;
  limit?: number;
  offset?: number;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class TeachingManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Propose a teaching exchange. Teacher pays 15 credits. */
  async propose(input: ProposeTeachingInput): Promise<{
    exchange: TeachingExchange;
    offerings: TeachingOffering[];
    actionabilityResults: ActionabilityResult[];
  }> {
    return this.connection.request("POST", "/v1/teaching/propose", input);
  }

  /** Accept a proposed teaching exchange. Learner pays 10 credits. */
  async accept(exchangeId: string): Promise<{ exchange: TeachingExchange }> {
    return this.connection.request("POST", `/v1/teaching/${exchangeId}/accept`);
  }

  /** Mark teaching as delivered (teacher). */
  async deliver(exchangeId: string, notes?: string): Promise<{ exchange: TeachingExchange }> {
    return this.connection.request("POST", `/v1/teaching/${exchangeId}/deliver`, { notes });
  }

  /** Approve teaching and reward the teacher (learner). Teacher earns 30 credits. */
  async approve(
    exchangeId: string,
    feedback?: string,
    rating?: number,
  ): Promise<{ exchange: TeachingExchange }> {
    return this.connection.request("POST", `/v1/teaching/${exchangeId}/approve`, { feedback, rating });
  }

  /** Reject teaching (learner). No credit reward to teacher. */
  async reject(exchangeId: string, feedback?: string): Promise<{ exchange: TeachingExchange }> {
    return this.connection.request("POST", `/v1/teaching/${exchangeId}/reject`, { feedback });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** Get a specific exchange with its offerings. */
  async getExchange(exchangeId: string): Promise<{
    exchange: TeachingExchange;
    offerings: TeachingOffering[];
  }> {
    return this.connection.request("GET", `/v1/teaching/exchanges/${exchangeId}`);
  }

  /** List teaching exchanges for the current agent. */
  async listExchanges(opts?: ListExchangesOptions): Promise<{
    exchanges: TeachingExchange[];
    total: number;
  }> {
    const params = new URLSearchParams();
    if (opts?.role) params.set("role", opts.role);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/teaching/exchanges${qs ? `?${qs}` : ""}`);
  }

  /** Search for teachers who can help with a goal. */
  async searchTeachers(goal: string, limit?: number): Promise<{
    teachers: TeacherResult[];
    gapSignal: boolean;
  }> {
    const params = new URLSearchParams({ goal });
    if (limit !== undefined) params.set("limit", String(limit));
    return this.connection.request("GET", `/v1/teaching/search-teachers?${params}`);
  }

  /** Get teaching stats for the current agent. */
  async getStats(): Promise<{ stats: TeachingStats }>;
  /** Get teaching stats for a specific agent by address. */
  async getStats(address: string): Promise<{ stats: TeachingStats }>;
  async getStats(address?: string): Promise<{ stats: TeachingStats }> {
    const path = address ? `/v1/teaching/stats/${address}` : "/v1/teaching/stats";
    return this.connection.request("GET", path);
  }

  // ─── Knowledge Gaps ───────────────────────────────────────────────────────

  /** Browse unfilled knowledge gap signals. */
  async getGapSignals(opts?: GapSignalOptions): Promise<{
    gaps: GapSignal[];
    total: number;
  }> {
    const params = new URLSearchParams();
    if (opts?.domain) params.set("domain", opts.domain);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/teaching/gaps${qs ? `?${qs}` : ""}`);
  }

  /** Mark a knowledge gap as filled with a bundle. */
  async fillGap(gapId: string, bundleId: string): Promise<{ gap: GapSignal }> {
    return this.connection.request("POST", `/v1/teaching/gaps/${gapId}/fill`, { bundleId });
  }
}
