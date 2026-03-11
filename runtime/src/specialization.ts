/**
 * SpecializationManager — niche detection, skill gaps, demand/supply signals, recommendations.
 *
 * @module specialization
 */

import type { ConnectionManager } from "./connection.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillGap {
  id: string;
  query_text: string;
  query_tags: string[];
  community_id?: string;
  gap_count: number;
  first_seen: string;
  last_seen: string;
  resolved: boolean;
  resolved_by?: string;
  resolved_at?: string;
}

export interface SpecSignal {
  skill_domain: string;
  signal_type: string;
  signal_count: number;
  avg_intensity: number;
  last_seen: string;
}

export interface AgentSpecialization {
  agent_id: string;
  skill_domain: string;
  proficiency: number;
  demand_score: number;
  supply_score: number;
  gap_opportunity: number;
  recommended: boolean;
  updated_at: string;
}

export interface SpecRecommendation {
  id: string;
  agent_id: string;
  skill_domain: string;
  recommendation: string;
  current_proficiency: number;
  target_proficiency: number;
  gap_opportunity: number;
  status: string;
  created_at: string;
}

export interface SkillLandscape {
  demand: any[];
  supply: any[];
  gaps: any[];
  windowDays: number;
}

export interface RecordGapInput {
  queryText: string;
  queryTags?: string[];
  communityId?: string;
}

export interface RecordSignalInput {
  skillDomain: string;
  signalType: string;
  intensity?: number;
  sourceType?: string;
  sourceId?: string;
  metadata?: any;
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class SpecializationManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ── Skill Gaps ──────────────────────────────────────────

  /** Record a skill gap (zero-result query). */
  async recordGap(input: RecordGapInput): Promise<void> {
    await this.connection.request("POST", "/v1/specialization/gaps", input);
  }

  /** List open skill gaps. */
  async listGaps(opts?: {
    tag?: string;
    communityId?: string;
    minCount?: number;
    limit?: number;
  }): Promise<SkillGap[]> {
    const params = new URLSearchParams();
    if (opts?.tag) params.set("tag", opts.tag);
    if (opts?.communityId) params.set("communityId", opts.communityId);
    if (opts?.minCount) params.set("minCount", String(opts.minCount));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const res = await this.connection.request<{ data: SkillGap[] }>("GET", `/v1/specialization/gaps${qs ? `?${qs}` : ""}`);
    return res.data;
  }

  /** Resolve a skill gap. */
  async resolveGap(gapId: string): Promise<SkillGap> {
    const res = await this.connection.request<{ data: SkillGap }>("POST", `/v1/specialization/gaps/${gapId}/resolve`);
    return res.data;
  }

  // ── Signals ─────────────────────────────────────────────

  /** Record a demand/supply signal. */
  async recordSignal(input: RecordSignalInput): Promise<void> {
    await this.connection.request("POST", "/v1/specialization/signals", input);
  }

  /** Get aggregated signals. */
  async getSignals(opts?: {
    skillDomain?: string;
    signalType?: string;
    days?: number;
    limit?: number;
  }): Promise<SpecSignal[]> {
    const params = new URLSearchParams();
    if (opts?.skillDomain) params.set("skillDomain", opts.skillDomain);
    if (opts?.signalType) params.set("signalType", opts.signalType);
    if (opts?.days) params.set("days", String(opts.days));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const res = await this.connection.request<{ data: SpecSignal[] }>("GET", `/v1/specialization/signals${qs ? `?${qs}` : ""}`);
    return res.data;
  }

  // ── Proficiency ─────────────────────────────────────────

  /** Update proficiency in a skill domain. */
  async updateProficiency(skillDomain: string, proficiency: number): Promise<AgentSpecialization> {
    const res = await this.connection.request<{ data: AgentSpecialization }>(
      "PUT", "/v1/specialization/proficiency", { skillDomain, proficiency },
    );
    return res.data;
  }

  /** Get own specialization profile. */
  async getProfile(): Promise<AgentSpecialization[]> {
    const res = await this.connection.request<{ data: AgentSpecialization[] }>("GET", "/v1/specialization/profile");
    return res.data;
  }

  /** Get another agent's specialization profile. */
  async getAgentProfile(agentId: string): Promise<AgentSpecialization[]> {
    const res = await this.connection.request<{ data: AgentSpecialization[] }>("GET", `/v1/specialization/profile/${agentId}`);
    return res.data;
  }

  // ── Recommendations ─────────────────────────────────────

  /** Generate specialization recommendations. */
  async generateRecommendations(): Promise<SpecRecommendation[]> {
    const res = await this.connection.request<{ data: SpecRecommendation[] }>("POST", "/v1/specialization/recommendations/generate");
    return res.data;
  }

  /** Get existing recommendations. */
  async getRecommendations(status?: string): Promise<SpecRecommendation[]> {
    const qs = status ? `?status=${status}` : "";
    const res = await this.connection.request<{ data: SpecRecommendation[] }>("GET", `/v1/specialization/recommendations${qs}`);
    return res.data;
  }

  /** Dismiss a recommendation. */
  async dismissRecommendation(recommendationId: string): Promise<void> {
    await this.connection.request("DELETE", `/v1/specialization/recommendations/${recommendationId}`);
  }

  // ── Landscape ───────────────────────────────────────────

  /** Get network-wide skill landscape. */
  async getSkillLandscape(days?: number): Promise<SkillLandscape> {
    const qs = days ? `?days=${days}` : "";
    const res = await this.connection.request<{ data: SkillLandscape }>("GET", `/v1/specialization/landscape${qs}`);
    return res.data;
  }

  // ── WebSocket Events ────────────────────────────────────

  /** Subscribe to recommendation events. */
  onRecommendations(handler: (event: any) => void): void {
    this.connection.on("specialization.recommendations", handler);
  }
}
