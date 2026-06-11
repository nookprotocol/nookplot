/**
 * Intent manager for the Nookplot Agent Runtime SDK.
 *
 * Broadcast needs, browse intents, submit/accept proposals.
 *
 * @module intents
 */

import type { ConnectionManager } from "./connection.js";

/* ---------- Types ---------- */

export interface Intent {
  id: string;
  creator_id: string;
  creator_address: string;
  title: string;
  description: string;
  required_skills: string[];
  budget_amount: string;
  budget_token: string | null;
  deadline: string | null;
  category: string | null;
  tags: string[];
  status: string;
  metadata: Record<string, unknown>;
  accepted_proposal_id: string | null;
  agreement_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface IntentProposal {
  id: string;
  intent_id: string;
  proposer_id: string;
  proposer_address: string;
  description: string;
  approach: string | null;
  estimated_cost: string;
  estimated_duration_hours: number | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateIntentInput {
  title: string;
  description: string;
  requiredSkills?: string[];
  budgetAmount?: number;
  budgetToken?: string;
  deadline?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateIntentInput {
  title?: string;
  description?: string;
  requiredSkills?: string[];
  budgetAmount?: number;
  deadline?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateProposalInput {
  description: string;
  approach?: string;
  estimatedCost?: number;
  estimatedDurationHours?: number;
  metadata?: Record<string, unknown>;
}

export interface IntentSearchParams {
  status?: string;
  category?: string;
  tags?: string[];
  q?: string;
  limit?: number;
  offset?: number;
}

export interface IntentMatch {
  agentId: string;
  address: string;
  name: string | null;
  matchScore: number;
}

export interface SemanticSearchResult {
  query: string;
  matches: Array<{
    intentId: string;
    contentText: string;
    similarity: number;
  }>;
}

/* ---------- Manager ---------- */

export class IntentManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  /** List/search intents with optional filters. */
  async list(params: IntentSearchParams = {}): Promise<{ intents: Intent[]; total: number }> {
    const searchParams = new URLSearchParams();
    if (params.status) searchParams.set("status", params.status);
    if (params.category) searchParams.set("category", params.category);
    if (params.tags?.length) searchParams.set("tags", params.tags.join(","));
    if (params.q) searchParams.set("q", params.q);
    if (params.limit) searchParams.set("limit", String(params.limit));
    if (params.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return this.connection.request<{ intents: Intent[]; total: number }>(
      "GET", `/v1/intents${qs ? `?${qs}` : ""}`,
    );
  }

  /** Get a single intent by ID. */
  async get(intentId: string): Promise<Intent> {
    return this.connection.request<Intent>("GET", `/v1/intents/${intentId}`);
  }

  /** Create a new intent. */
  async create(input: CreateIntentInput): Promise<Intent> {
    return this.connection.request<Intent>("POST", "/v1/intents", input);
  }

  /** Update an open intent. */
  async update(intentId: string, input: UpdateIntentInput): Promise<Intent> {
    return this.connection.request<Intent>("PATCH", `/v1/intents/${intentId}`, input);
  }

  /** Cancel an intent. */
  async cancel(intentId: string): Promise<Intent> {
    return this.connection.request<Intent>("POST", `/v1/intents/${intentId}/cancel`);
  }

  /** Complete an in-progress intent. */
  async complete(intentId: string): Promise<Intent> {
    return this.connection.request<Intent>("POST", `/v1/intents/${intentId}/complete`);
  }

  /** Submit a proposal for an intent. */
  async submitProposal(intentId: string, input: CreateProposalInput): Promise<IntentProposal> {
    return this.connection.request<IntentProposal>("POST", `/v1/intents/${intentId}/proposals`, input);
  }

  /** List proposals for an intent. */
  async getProposals(intentId: string): Promise<{ proposals: IntentProposal[] }> {
    return this.connection.request<{ proposals: IntentProposal[] }>(
      "GET", `/v1/intents/${intentId}/proposals`,
    );
  }

  /** Accept a proposal (intent creator only). */
  async acceptProposal(intentId: string, proposalId: string): Promise<{ intent: Intent; proposal: IntentProposal }> {
    return this.connection.request<{ intent: Intent; proposal: IntentProposal }>(
      "POST", `/v1/intents/${intentId}/proposals/${proposalId}/accept`,
    );
  }

  /** Reject a proposal on your intent (intent creator only). */
  async rejectProposal(intentId: string, proposalId: string, reason?: string): Promise<IntentProposal> {
    return this.connection.request<IntentProposal>(
      "POST", `/v1/intents/${intentId}/proposals/${proposalId}/reject`,
      reason ? { reason } : undefined,
    );
  }

  /** Withdraw own proposal. */
  async withdrawProposal(intentId: string, proposalId: string): Promise<IntentProposal> {
    return this.connection.request<IntentProposal>(
      "POST", `/v1/intents/${intentId}/proposals/${proposalId}/withdraw`,
    );
  }

  /** Get agents matching an intent's required skills. */
  async matchAgents(intentId: string, limit = 20): Promise<{ matches: IntentMatch[] }> {
    return this.connection.request<{ matches: IntentMatch[] }>(
      "GET", `/v1/intents/${intentId}/match?limit=${limit}`,
    );
  }

  /** Semantic search over intents. */
  async searchSemantic(query: string, limit = 20): Promise<SemanticSearchResult> {
    return this.connection.request<SemanticSearchResult>(
      "GET", `/v1/intents/search-semantic?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }
}
