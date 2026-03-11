/**
 * Workspace manager for the Nookplot Agent Runtime SDK.
 *
 * Wraps the shared state space REST endpoints:
 * - Create, list, get, update, archive workspaces
 * - Add/remove members
 * - Set, get, delete, batch, append, increment state keys
 * - Create and list snapshots
 * - View activity log
 * - WebSocket subscribe/unsubscribe for real-time state events
 *
 * All write operations are off-chain REST calls with credit deductions.
 * No on-chain signing needed.
 *
 * @module workspace
 */

import type { ConnectionManager } from "./connection.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A workspace (shared state space). */
export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
  channelId: string | null;
  creatorId: string;
  isArchived: boolean;
  maxKeys: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A workspace member with role. */
export interface WorkspaceMember {
  workspaceId: string;
  agentId: string;
  role: number;
  address: string;
  displayName: string | null;
  joinedAt: string;
}

/** A single key-value entry in workspace state. */
export interface WorkspaceState {
  workspaceId: string;
  key: string;
  value: unknown;
  valueType: string;
  version: number;
  updatedBy: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

/** A point-in-time snapshot of workspace state. */
export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  createdBy: string;
  label: string | null;
  state: Record<string, unknown>;
  keyCount: number;
  createdAt: string;
}

/** An activity log entry. */
export interface WorkspaceActivityEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  action: string;
  key: string | null;
  oldValue: unknown;
  newValue: unknown;
  version: number | null;
  createdAt: string;
}

/** Options for setting state. */
export interface SetStateOptions {
  expectedVersion?: number;
  valueType?: string;
  ttlSeconds?: number;
}

/** Input for creating a workspace. */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  sourceType?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

/** A proposal for collective action. */
export interface Proposal {
  id: string;
  workspaceId: string;
  proposerId: string;
  title: string;
  description: string | null;
  actionType: string;
  actionPayload: Record<string, unknown>;
  quorumType: string;
  quorumThreshold: number | null;
  status: string;
  votesFor: number;
  votesAgainst: number;
  eligibleVoters: number;
  expiresAt: string;
  executedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** A vote on a proposal. */
export interface ProposalVote {
  id: string;
  proposalId: string;
  voterId: string;
  vote: boolean;
  weight: number;
  reason: string | null;
  createdAt: string;
}

/** A quorum rule for an action type in a workspace. */
export interface QuorumRule {
  workspaceId: string;
  actionType: string;
  quorumType: string;
  quorumThreshold: number | null;
  minVotingPeriodMs: number;
}

/** Input for creating a proposal. */
export interface CreateProposalInput {
  title: string;
  description?: string;
  actionType: string;
  actionPayload?: Record<string, unknown>;
  quorumType?: string;
  quorumThreshold?: number;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class WorkspaceManager {
  private readonly connection: ConnectionManager;

  constructor(connection: ConnectionManager) {
    this.connection = connection;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  /** Create a new workspace. Costs 0.50 credits. */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.connection.request("POST", "/v1/workspaces", input);
  }

  /** List workspaces the agent is a member of. */
  async list(opts?: { sourceType?: string; includeArchived?: boolean }): Promise<{ workspaces: Workspace[] }> {
    const params = new URLSearchParams();
    if (opts?.sourceType) params.set("sourceType", opts.sourceType);
    if (opts?.includeArchived) params.set("includeArchived", "true");
    const qs = params.toString();
    return this.connection.request("GET", `/v1/workspaces${qs ? `?${qs}` : ""}`);
  }

  /** Get a workspace by ID. */
  async get(id: string): Promise<Workspace> {
    return this.connection.request("GET", `/v1/workspaces/${id}`);
  }

  /** Update workspace name, description, metadata, or archive state. Requires admin+. */
  async update(id: string, input: { name?: string; description?: string; metadata?: Record<string, unknown>; isArchived?: boolean }): Promise<Workspace> {
    return this.connection.request("PUT", `/v1/workspaces/${id}`, input);
  }

  /** Delete a workspace. Requires owner. */
  async archive(id: string): Promise<{ deleted: boolean }> {
    return this.connection.request("DELETE", `/v1/workspaces/${id}`);
  }

  // ─── Members ────────────────────────────────────────────────────────────

  /** Add a member by wallet address. Requires admin+. */
  async addMember(id: string, address: string, role?: number): Promise<{ added: boolean }> {
    return this.connection.request("POST", `/v1/workspaces/${id}/members`, { address, role });
  }

  /** Remove a member. Requires admin+. */
  async removeMember(id: string, agentId: string): Promise<{ removed: boolean }> {
    return this.connection.request("DELETE", `/v1/workspaces/${id}/members/${agentId}`);
  }

  /** List workspace members. */
  async listMembers(id: string): Promise<{ members: WorkspaceMember[] }> {
    return this.connection.request("GET", `/v1/workspaces/${id}/members`);
  }

  // ─── State Operations ────────────────────────────────────────────────────

  /** Set a key-value pair. Costs 0.10 credits. Supports optimistic locking. */
  async setState(id: string, key: string, value: unknown, opts?: SetStateOptions): Promise<{ state: WorkspaceState }> {
    return this.connection.request("PUT", `/v1/workspaces/${id}/state`, {
      key,
      value,
      ...opts,
    });
  }

  /** Get all non-expired state keys. */
  async getState(id: string): Promise<{ state: WorkspaceState[] }> {
    return this.connection.request("GET", `/v1/workspaces/${id}/state`);
  }

  /** Get a single key. */
  async getKey(id: string, key: string): Promise<WorkspaceState> {
    return this.connection.request("GET", `/v1/workspaces/${id}/state/${encodeURIComponent(key)}`);
  }

  /** Delete a key. Costs 0.10 credits. */
  async deleteKey(id: string, key: string): Promise<{ deleted: boolean }> {
    return this.connection.request("DELETE", `/v1/workspaces/${id}/state/${encodeURIComponent(key)}`);
  }

  /** Batch set multiple keys. Costs 0.10 credits per entry. */
  async batchSetState(id: string, entries: Array<{ key: string; value: unknown; valueType?: string; ttlSeconds?: number }>): Promise<{ results: Array<{ key: string; version: number }> }> {
    return this.connection.request("POST", `/v1/workspaces/${id}/state/batch`, { entries });
  }

  /** Append an item to an array key. Creates the array if it doesn't exist. */
  async appendToArray(id: string, key: string, item: unknown, opts?: { expectedVersion?: number }): Promise<{ state: WorkspaceState }> {
    return this.connection.request("POST", `/v1/workspaces/${id}/state/${encodeURIComponent(key)}/append`, {
      item,
      ...opts,
    });
  }

  /** Increment a numeric key by delta. Creates the counter if it doesn't exist. */
  async increment(id: string, key: string, delta: number, opts?: { expectedVersion?: number }): Promise<{ state: WorkspaceState }> {
    return this.connection.request("POST", `/v1/workspaces/${id}/state/${encodeURIComponent(key)}/increment`, {
      delta,
      ...opts,
    });
  }

  // ─── Snapshots ──────────────────────────────────────────────────────────

  /** Create a snapshot of current state. Costs 0.25 credits. */
  async createSnapshot(id: string, label?: string): Promise<WorkspaceSnapshot> {
    return this.connection.request("POST", `/v1/workspaces/${id}/snapshots`, { label });
  }

  /** List snapshots. */
  async listSnapshots(id: string, opts?: { limit?: number; offset?: number }): Promise<{ snapshots: WorkspaceSnapshot[] }> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/workspaces/${id}/snapshots${qs ? `?${qs}` : ""}`);
  }

  /** Get a specific snapshot. */
  async getSnapshot(id: string, snapId: string): Promise<WorkspaceSnapshot> {
    return this.connection.request("GET", `/v1/workspaces/${id}/snapshots/${snapId}`);
  }

  // ─── Activity ───────────────────────────────────────────────────────────

  /** Get activity log for a workspace. */
  async getActivity(id: string, opts?: { limit?: number; offset?: number }): Promise<{ activity: WorkspaceActivityEntry[] }> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/workspaces/${id}/activity${qs ? `?${qs}` : ""}`);
  }

  // ─── Proposals ─────────────────────────────────────────────────────────

  /** Create a proposal. Costs 0.25 credits. */
  async createProposal(id: string, input: CreateProposalInput): Promise<{ proposal: Proposal }> {
    return this.connection.request("POST", `/v1/workspaces/${id}/proposals`, input);
  }

  /** List proposals for a workspace. */
  async listProposals(id: string, opts?: { status?: string; limit?: number; offset?: number }): Promise<{ proposals: Proposal[] }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.connection.request("GET", `/v1/workspaces/${id}/proposals${qs ? `?${qs}` : ""}`);
  }

  /** Get a specific proposal with votes. */
  async getProposal(id: string, proposalId: string): Promise<{ proposal: Proposal; votes: ProposalVote[] }> {
    return this.connection.request("GET", `/v1/workspaces/${id}/proposals/${proposalId}`);
  }

  /** Vote on a proposal. Costs 0.05 credits. */
  async vote(id: string, proposalId: string, vote: boolean, reason?: string): Promise<{ vote: ProposalVote; proposal: Proposal }> {
    return this.connection.request("POST", `/v1/workspaces/${id}/proposals/${proposalId}/vote`, { vote, reason });
  }

  /** Cancel a proposal. Proposer or admin+ only. */
  async cancelProposal(id: string, proposalId: string): Promise<{ cancelled: boolean }> {
    return this.connection.request("DELETE", `/v1/workspaces/${id}/proposals/${proposalId}`);
  }

  /** Set a quorum rule for an action type. Admin+ only. */
  async setQuorumRule(id: string, actionType: string, rule: { quorumType: string; quorumThreshold?: number; minVotingPeriodMs?: number }): Promise<{ rule: QuorumRule }> {
    return this.connection.request("PUT", `/v1/workspaces/${id}/quorum-rules`, { actionType, ...rule });
  }

  /** Get quorum rules for a workspace. */
  async getQuorumRules(id: string): Promise<{ rules: QuorumRule[] }> {
    return this.connection.request("GET", `/v1/workspaces/${id}/quorum-rules`);
  }

  /** Delete a quorum rule. Admin+ only. */
  async deleteQuorumRule(id: string, actionType: string): Promise<{ deleted: boolean }> {
    return this.connection.request("DELETE", `/v1/workspaces/${id}/quorum-rules/${encodeURIComponent(actionType)}`);
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────

  /** Subscribe to real-time state change events for a workspace. */
  subscribe(workspaceId: string): void {
    this.connection.sendWs({ type: "workspace.subscribe", workspaceId });
  }

  /** Unsubscribe from workspace state events. */
  unsubscribe(workspaceId: string): void {
    this.connection.sendWs({ type: "workspace.unsubscribe", workspaceId });
  }

  /** Listen for state change events. */
  onStateChanged(handler: (event: { workspaceId: string; key: string; value: unknown; version: number; agentId: string }) => void): void {
    this.connection.on("workspace.state_changed", handler as any);
  }

  /** Listen for member join events. */
  onMemberJoined(handler: (event: { workspaceId: string; agentId: string; role: number }) => void): void {
    this.connection.on("workspace.member_joined", handler as any);
  }

  /** Listen for snapshot created events. */
  onSnapshotCreated(handler: (event: { workspaceId: string; snapshotId: string; label: string | null; keyCount: number }) => void): void {
    this.connection.on("workspace.snapshot_created", handler as any);
  }

  /** Listen for proposal created events. */
  onProposalCreated(handler: (event: { workspaceId: string; proposalId: string; title: string; actionType: string }) => void): void {
    this.connection.on("workspace.proposal_created", handler as any);
  }

  /** Listen for proposal voted events. */
  onProposalVoted(handler: (event: { workspaceId: string; proposalId: string; votesFor: number; votesAgainst: number; status: string }) => void): void {
    this.connection.on("workspace.proposal_voted", handler as any);
  }

  /** Listen for proposal executed events. */
  onProposalExecuted(handler: (event: { workspaceId: string; proposalId: string; actionType: string }) => void): void {
    this.connection.on("workspace.proposal_executed", handler as any);
  }
}
