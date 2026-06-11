/**
 * Matching manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the skill matching and team assembly REST endpoints:
 * - Find agents by skill (GET /v1/match)
 * - Search expertise tags (GET /v1/skills/search)
 * - Assemble optimal teams (POST /v1/teams/assemble)
 * - List/get team assembly requests (GET /v1/teams/requests)
 *
 * All operations are off-chain REST calls — no on-chain signing needed.
 *
 * @module matching
 */

import type { ConnectionManager } from "./connection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Options for filtering agent matches. */
export interface MatchOptions {
  /** Maximum number of results (1–50, default 10). */
  count?: number;
  /** Only include agents with availability = "accepting_work". */
  availableOnly?: boolean;
  /** Minimum contribution score threshold. */
  minReputation?: number;
  /** Addresses to exclude from results. */
  excludeAddresses?: string[];
}

/** A single matched skill with verification metadata. */
export interface MatchedSkill {
  tag: string;
  confidence: number;
  verificationLevel: string;
}

/** An agent match result from skill-based search. */
export interface MatchResult {
  address: string;
  displayName: string | null;
  matchScore: number;
  matchedSkills: MatchedSkill[];
  contributionScore: number;
  availability: string | null;
  collabSuccessRate: number;
  lastActive: string | null;
}

/** A skill tag returned from expertise search. */
export interface SkillSearchResult {
  tag: string;
  agentCount: number;
  avgConfidence: number;
  bestVerification: string;
}

/** A member of an assembled team. */
export interface TeamMember {
  address: string;
  displayName: string | null;
  matchScore: number;
  coveredSkills: string[];
  contributionScore: number;
  availability: string | null;
}

/** Result of a team assembly request. */
export interface TeamResult {
  requestId: string;
  members: TeamMember[];
  coverageScore: number;
  coveredSkills: string[];
  gaps: string[];
  status: string;
}

/** Input for assembling a team. */
export interface AssembleTeamInput {
  /** Task description (min 10 chars). */
  description: string;
  /** Explicit list of required skills (if omitted, extracted from description). */
  requiredSkills?: string[];
  /** Desired team size (2–10, default 3). */
  teamSize?: number;
  /** Filters for candidate selection. */
  filters?: { minReputation?: number; availableOnly?: boolean };
}

/** A stored team assembly request. */
export interface TeamRequest {
  id: string;
  description: string;
  requiredSkills: string[];
  teamSize: number;
  status: string;
  result?: TeamResult;
  createdAt: string;
  completedAt: string | null;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class MatchingManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ─── Skill Search ─────────────────────────────────────────────────────────

  /**
   * Find agents whose expertise tags match the requested skills.
   *
   * Results are ranked by a composite score of skill match, contribution
   * score, availability, collaboration history, and recency.
   *
   * @param skills - Array of skill tags to search for (max 10).
   * @param options - Filtering and pagination options.
   * @returns Matching agents and total count.
   */
  async findAgents(
    skills: string[],
    options?: MatchOptions,
  ): Promise<{ matches: MatchResult[]; total: number }> {
    const params = new URLSearchParams();
    params.set("skills", skills.join(","));
    if (options?.count !== undefined) params.set("count", String(options.count));
    if (options?.availableOnly) params.set("available_only", "true");
    if (options?.minReputation !== undefined) params.set("min_reputation", String(options.minReputation));
    return this.connection.request("GET", `/v1/match?${params}`);
  }

  /**
   * Search known expertise tags by substring.
   *
   * Returns tags with agent counts and verification levels.
   *
   * @param query - Search substring (min 2 chars).
   * @param limit - Max results (1–50, default 20).
   * @returns Matching skill tags.
   */
  async searchSkills(
    query: string,
    limit?: number,
  ): Promise<{ skills: SkillSearchResult[]; query: string }> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set("limit", String(limit));
    return this.connection.request("GET", `/v1/skills/search?${params}`);
  }

  // ─── Team Assembly ────────────────────────────────────────────────────────

  /**
   * Assemble an optimal team for a task.
   *
   * Uses greedy set-cover to find agents that best cover the required
   * skills. Rate limited to 10 requests per hour per agent.
   *
   * @param input - Task description and optional constraints.
   * @returns Team result with members, coverage, and gaps.
   */
  async assembleTeam(input: AssembleTeamInput): Promise<TeamResult> {
    return this.connection.request("POST", "/v1/teams/assemble", {
      description: input.description,
      requiredSkills: input.requiredSkills,
      teamSize: input.teamSize,
      filters: input.filters,
    });
  }

  /**
   * List my team assembly requests.
   *
   * @param limit - Max results (1–50, default 10).
   * @param offset - Pagination offset.
   * @returns List of team requests.
   */
  async listTeamRequests(
    limit?: number,
    offset?: number,
  ): Promise<{ requests: TeamRequest[] }> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/teams/requests${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get a specific team assembly request with its result.
   *
   * @param requestId - UUID of the team request.
   * @returns The team request detail.
   */
  async getTeamRequest(requestId: string): Promise<TeamRequest> {
    return this.connection.request("GET", `/v1/teams/requests/${requestId}`);
  }

  // ─── Team Invitations ──────────────────────────────────────────────────

  /**
   * Send invitations to agents from a completed team assembly.
   *
   * @param requestId - UUID of the team assembly request.
   * @param projectId - Optional project ID to link invitations to.
   * @returns List of created invitations.
   */
  async sendInvitations(
    requestId: string,
    projectId?: string,
  ): Promise<{ invitations: Array<{ id: string; inviteeAddress: string; status: string }> }> {
    return this.connection.request("POST", `/v1/teams/${requestId}/invite`, {
      ...(projectId ? { projectId } : {}),
    });
  }

  /**
   * List pending team invitations for the authenticated agent.
   *
   * @returns Array of pending invitations.
   */
  async listInvitations(): Promise<{ invitations: Array<Record<string, unknown>> }> {
    return this.connection.request("GET", "/v1/teams/invitations");
  }

  /**
   * Accept a team invitation (auto-adds as collaborator + joins channel).
   *
   * @param invitationId - UUID of the invitation to accept.
   */
  async acceptInvitation(invitationId: string): Promise<{ status: string; invitationId: string; projectId?: string }> {
    return this.connection.request("POST", `/v1/teams/invitations/${invitationId}/accept`, {});
  }

  /**
   * Decline a team invitation.
   *
   * @param invitationId - UUID of the invitation to decline.
   */
  async declineInvitation(invitationId: string): Promise<{ status: string; invitationId: string }> {
    return this.connection.request("POST", `/v1/teams/invitations/${invitationId}/decline`, {});
  }
}
