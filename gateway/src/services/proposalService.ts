/**
 * Proposal service — collective action voting for workspaces.
 *
 * Agents propose actions (state changes, membership, etc.), vote, and the
 * system auto-executes when quorum is reached. Off-chain credit-gated, same
 * as workspace state operations.
 *
 * @module services/proposalService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProposalRow {
  id: string;
  workspace_id: string;
  proposer_id: string;
  title: string;
  description: string | null;
  action_type: string;
  action_payload: Record<string, unknown>;
  quorum_type: string;
  quorum_threshold: number | null;
  status: string;
  votes_for: number;
  votes_against: number;
  eligible_voters: number;
  expires_at: string;
  executed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface ProposalVoteRow {
  id: string;
  proposal_id: string;
  voter_id: string;
  vote: boolean;
  weight: number;
  reason: string | null;
  created_at: string;
}

export interface QuorumRuleRow {
  workspace_id: string;
  action_type: string;
  quorum_type: string;
  quorum_threshold: number | null;
  min_voting_period_ms: number;
}

export interface CreateProposalInput {
  title: string;
  description?: string;
  actionType: string;
  actionPayload?: Record<string, unknown>;
  quorumType?: string;
  quorumThreshold?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPOSAL_CREATE_COST = 25;  // 0.25 credits
const PROPOSAL_VOTE_COST = 5;     // 0.05 credits

const VALID_ACTION_TYPES = new Set([
  "state_change", "add_member", "remove_member", "role_change", "archive", "custom",
]);

const VALID_QUORUM_TYPES = new Set(["majority", "supermajority", "unanimous", "threshold"]);

const DEFAULT_VOTING_PERIOD_MS = 86_400_000; // 24 hours
const MIN_VOTING_PERIOD_MS = 3_600_000;      // 1 hour

// ─── Service ──────────────────────────────────────────────────────────────────

export class ProposalService {
  private readonly pool: pg.Pool;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private workspaceService: any = null;
  private creditManager: any = null;
  private messageBus: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  setWorkspaceService(ws: any): void { this.workspaceService = ws; }
  setCreditManager(cm: any): void { this.creditManager = cm; }
  setMessageBus(mb: any): void { this.messageBus = mb; }

  // ============================================================
  //  Create Proposal
  // ============================================================

  async createProposal(
    agentId: string,
    workspaceId: string,
    input: CreateProposalInput,
  ): Promise<{ proposal: ProposalRow } | { error: string; code: string }> {
    // Role check: editor+ required
    const role = await this.workspaceService.getMemberRole(workspaceId, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    // Validate action type
    if (!VALID_ACTION_TYPES.has(input.actionType)) {
      return { error: `Invalid action_type: ${input.actionType}`, code: "INVALID_INPUT" };
    }

    // Validate quorum type if provided
    const quorumType = input.quorumType ?? "majority";
    if (!VALID_QUORUM_TYPES.has(quorumType)) {
      return { error: `Invalid quorum_type: ${quorumType}`, code: "INVALID_INPUT" };
    }

    if (quorumType === "threshold" && (input.quorumThreshold == null || input.quorumThreshold < 1)) {
      return { error: "quorumThreshold is required and must be >= 1 for threshold type", code: "INVALID_INPUT" };
    }

    // Look up quorum rule for this action type
    const rule = await this.getQuorumRuleInternal(workspaceId, input.actionType);
    const effectiveQuorumType = rule?.quorum_type ?? quorumType;
    const effectiveThreshold = rule?.quorum_threshold ?? input.quorumThreshold ?? null;
    const votingPeriodMs = Math.max(rule?.min_voting_period_ms ?? DEFAULT_VOTING_PERIOD_MS, MIN_VOTING_PERIOD_MS);

    // Count eligible voters (members with role >= editor)
    const { rows: voterCount } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = $1 AND role >= 1`,
      [workspaceId],
    );
    const eligibleVoters = parseInt(voterCount[0].count, 10);

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, PROPOSAL_CREATE_COST, requestId, "proposal_create");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    const expiresAt = new Date(Date.now() + votingPeriodMs);

    const { rows } = await this.pool.query<ProposalRow>(
      `INSERT INTO proposals
         (workspace_id, proposer_id, title, description, action_type, action_payload,
          quorum_type, quorum_threshold, status, eligible_voters, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10)
       RETURNING *`,
      [
        workspaceId, agentId, input.title, input.description ?? null,
        input.actionType, JSON.stringify(input.actionPayload ?? {}),
        effectiveQuorumType, effectiveThreshold, eligibleVoters, expiresAt,
      ],
    );

    const proposal = rows[0];

    // Log activity
    await this.logActivity(workspaceId, agentId, "proposal_create", null, null, {
      proposalId: proposal.id, title: proposal.title, actionType: proposal.action_type,
    });

    // Publish event
    this.publishEvent(workspaceId, "workspace.proposal_created", {
      workspaceId,
      proposalId: proposal.id,
      proposerId: agentId,
      title: proposal.title,
      actionType: proposal.action_type,
      quorumType: effectiveQuorumType,
      eligibleVoters,
      expiresAt: expiresAt.toISOString(),
    });

    return { proposal };
  }

  // ============================================================
  //  Cast Vote
  // ============================================================

  async castVote(
    agentId: string,
    proposalId: string,
    vote: boolean,
    reason?: string,
  ): Promise<{ vote: ProposalVoteRow; proposal: ProposalRow } | { error: string; code: string }> {
    // Load proposal
    const proposal = await this.getProposalInternal(proposalId);
    if (!proposal) {
      return { error: "Proposal not found", code: "NOT_FOUND" };
    }

    // Check status
    if (proposal.status !== "open") {
      return { error: "Proposal is no longer open", code: "PROPOSAL_CLOSED" };
    }

    // Check expiry
    if (new Date(proposal.expires_at) <= new Date()) {
      return { error: "Proposal has expired", code: "PROPOSAL_EXPIRED" };
    }

    // Role check: editor+ on workspace
    const role = await this.workspaceService.getMemberRole(proposal.workspace_id, agentId);
    if (role === null || role < 1) {
      return { error: "Not a member or insufficient role", code: "FORBIDDEN" };
    }

    // Cannot vote on own proposal
    if (proposal.proposer_id === agentId) {
      return { error: "Cannot vote on your own proposal", code: "SELF_VOTE" };
    }

    // Deduct credits
    const requestId = crypto.randomUUID();
    if (this.creditManager) {
      try {
        await this.creditManager.deductCredits(agentId, PROPOSAL_VOTE_COST, requestId, "proposal_vote");
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_CREDITS") {
          return { error: "Insufficient credits", code: "INSUFFICIENT_CREDITS" };
        }
        throw err;
      }
    }

    // Insert vote
    try {
      await this.pool.query(
        `INSERT INTO proposal_votes (proposal_id, voter_id, vote, reason)
         VALUES ($1, $2, $3, $4)`,
        [proposalId, agentId, vote, reason ?? null],
      );
    } catch (err: any) {
      if (err?.code === "23505") { // unique violation
        return { error: "Already voted on this proposal", code: "ALREADY_VOTED" };
      }
      throw err;
    }

    // Recount tallies from actual rows
    const { rows: tallies } = await this.pool.query<{ votes_for: string; votes_against: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE vote = true) AS votes_for,
         COUNT(*) FILTER (WHERE vote = false) AS votes_against
       FROM proposal_votes WHERE proposal_id = $1`,
      [proposalId],
    );

    const votesFor = parseInt(tallies[0].votes_for, 10);
    const votesAgainst = parseInt(tallies[0].votes_against, 10);

    // Update tallies on proposal
    await this.pool.query(
      `UPDATE proposals SET votes_for = $1, votes_against = $2 WHERE id = $3`,
      [votesFor, votesAgainst, proposalId],
    );

    // Reload proposal with updated tallies
    let updatedProposal = { ...proposal, votes_for: votesFor, votes_against: votesAgainst };

    // Check quorum — use optimistic lock (WHERE status = 'open') to prevent
    // double-execution when concurrent votes both see quorum reached
    if (this.checkQuorum(updatedProposal)) {
      const { rowCount } = await this.pool.query(
        `UPDATE proposals SET status = 'passed' WHERE id = $1 AND status = 'open'`,
        [proposalId],
      );
      // Only execute if WE won the race (rowCount = 1)
      if (rowCount && rowCount > 0) {
        updatedProposal = { ...updatedProposal, status: "passed" };
        await this.executeProposal(updatedProposal);
      }
    } else if (this.checkRejection(updatedProposal)) {
      await this.pool.query(
        `UPDATE proposals SET status = 'rejected' WHERE id = $1 AND status = 'open'`,
        [proposalId],
      );
      updatedProposal = { ...updatedProposal, status: "rejected" };
    }

    // Get the inserted vote row
    const { rows: voteRows } = await this.pool.query<ProposalVoteRow>(
      `SELECT * FROM proposal_votes WHERE proposal_id = $1 AND voter_id = $2`,
      [proposalId, agentId],
    );

    // Publish event
    this.publishEvent(proposal.workspace_id, "workspace.proposal_voted", {
      workspaceId: proposal.workspace_id,
      proposalId,
      voterId: agentId,
      vote,
      votesFor,
      votesAgainst,
      status: updatedProposal.status,
    });

    return { vote: voteRows[0], proposal: updatedProposal };
  }

  // ============================================================
  //  Quorum Logic
  // ============================================================

  checkQuorum(proposal: ProposalRow): boolean {
    const { votes_for, eligible_voters, quorum_type, quorum_threshold } = proposal;
    switch (quorum_type) {
      case "majority":
        return votes_for > eligible_voters / 2;
      case "supermajority":
        return votes_for > (eligible_voters * 2) / 3;
      case "unanimous":
        return votes_for === eligible_voters;
      case "threshold":
        return quorum_threshold != null && votes_for >= quorum_threshold;
      default:
        return false;
    }
  }

  checkRejection(proposal: ProposalRow): boolean {
    const { votes_against, eligible_voters, quorum_type, quorum_threshold } = proposal;
    switch (quorum_type) {
      case "majority":
        return votes_against >= Math.ceil(eligible_voters / 2);
      case "supermajority":
        return votes_against > eligible_voters / 3;
      case "unanimous":
        return votes_against >= 1;
      case "threshold":
        return quorum_threshold != null && votes_against > eligible_voters - quorum_threshold;
      default:
        return false;
    }
  }

  // ============================================================
  //  Auto-Execute
  // ============================================================

  private async executeProposal(proposal: ProposalRow): Promise<void> {
    const { id, workspace_id, action_type, action_payload } = proposal;

    // Guard: verify not already executed (belt-and-suspenders with the optimistic lock in castVote)
    const { rows: check } = await this.pool.query<{ executed_at: string | null }>(
      `SELECT executed_at FROM proposals WHERE id = $1`,
      [id],
    );
    if (check[0]?.executed_at) return;

    const payload = typeof action_payload === "string" ? JSON.parse(action_payload) : action_payload;

    try {
      switch (action_type) {
        case "state_change":
          await this.workspaceService.setStateInternal(workspace_id, payload.key, payload.value);
          break;
        case "add_member":
          await this.workspaceService.addMemberInternal(workspace_id, payload.agentAddress, payload.role ?? 1);
          break;
        case "remove_member":
          await this.workspaceService.removeMemberInternal(workspace_id, payload.agentId);
          break;
        case "role_change":
          await this.workspaceService.updateMemberRole(workspace_id, payload.agentId, payload.role);
          break;
        case "archive":
          await this.workspaceService.archiveInternal(workspace_id);
          break;
        case "custom":
          // No auto-execution for custom — just records the decision
          break;
      }

      await this.pool.query(
        `UPDATE proposals SET status = 'executed', executed_at = NOW() WHERE id = $1`,
        [id],
      );

      await this.logActivity(workspace_id, "system:proposal", "proposal_executed", null, null, {
        proposalId: id, actionType: action_type,
      });

      this.publishEvent(workspace_id, "workspace.proposal_executed", {
        workspaceId: workspace_id,
        proposalId: id,
        actionType: action_type,
      });
    } catch (err) {
      logSecurityEvent("error", "proposal-execution-failed", {
        proposalId: id,
        actionType: action_type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================================
  //  Cancel Proposal
  // ============================================================

  async cancelProposal(
    agentId: string,
    proposalId: string,
  ): Promise<{ cancelled: boolean } | { error: string; code: string }> {
    const proposal = await this.getProposalInternal(proposalId);
    if (!proposal) {
      return { error: "Proposal not found", code: "NOT_FOUND" };
    }

    if (proposal.status !== "open") {
      return { error: "Proposal is no longer open", code: "PROPOSAL_CLOSED" };
    }

    // Only proposer or admin+ can cancel
    const role = await this.workspaceService.getMemberRole(proposal.workspace_id, agentId);
    if (proposal.proposer_id !== agentId && (role === null || role < 2)) {
      return { error: "Only proposer or admin can cancel", code: "FORBIDDEN" };
    }

    await this.pool.query(
      `UPDATE proposals SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
      [proposalId],
    );

    await this.logActivity(proposal.workspace_id, agentId, "proposal_cancel", null, null, {
      proposalId, title: proposal.title,
    });

    this.publishEvent(proposal.workspace_id, "workspace.proposal_cancelled", {
      workspaceId: proposal.workspace_id,
      proposalId,
      cancelledBy: agentId,
    });

    return { cancelled: true };
  }

  // ============================================================
  //  Sweep Expired Proposals
  // ============================================================

  async sweepExpiredProposals(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; workspace_id: string }>(
      `UPDATE proposals SET status = 'expired'
       WHERE status = 'open' AND expires_at <= NOW()
       RETURNING id, workspace_id`,
    );

    for (const row of rows) {
      this.publishEvent(row.workspace_id, "workspace.proposal_expired", {
        workspaceId: row.workspace_id,
        proposalId: row.id,
      });
    }

    if (rows.length > 0) {
      logSecurityEvent("info", "proposals-expired", { count: rows.length });
    }

    return rows.length;
  }

  // ============================================================
  //  Read Methods (free)
  // ============================================================

  async getProposal(proposalId: string): Promise<ProposalRow | null> {
    return this.getProposalInternal(proposalId);
  }

  async listProposals(
    workspaceId: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<ProposalRow[]> {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const offset = opts?.offset ?? 0;

    if (opts?.status) {
      const { rows } = await this.pool.query<ProposalRow>(
        `SELECT * FROM proposals WHERE workspace_id = $1 AND status = $2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [workspaceId, opts.status, limit, offset],
      );
      return rows;
    }

    const { rows } = await this.pool.query<ProposalRow>(
      `SELECT * FROM proposals WHERE workspace_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset],
    );
    return rows;
  }

  async getVotes(proposalId: string): Promise<ProposalVoteRow[]> {
    const { rows } = await this.pool.query<ProposalVoteRow>(
      `SELECT * FROM proposal_votes WHERE proposal_id = $1 ORDER BY created_at ASC`,
      [proposalId],
    );
    return rows;
  }

  // ============================================================
  //  Quorum Rule Management (admin+)
  // ============================================================

  async setQuorumRule(
    adminId: string,
    workspaceId: string,
    actionType: string,
    rule: { quorumType: string; quorumThreshold?: number; minVotingPeriodMs?: number },
  ): Promise<{ rule: QuorumRuleRow } | { error: string; code: string }> {
    const role = await this.workspaceService.getMemberRole(workspaceId, adminId);
    if (role === null || role < 2) {
      return { error: "Admin role required", code: "FORBIDDEN" };
    }

    if (!VALID_ACTION_TYPES.has(actionType)) {
      return { error: `Invalid action_type: ${actionType}`, code: "INVALID_INPUT" };
    }

    if (!VALID_QUORUM_TYPES.has(rule.quorumType)) {
      return { error: `Invalid quorum_type: ${rule.quorumType}`, code: "INVALID_INPUT" };
    }

    const minVotingMs = Math.max(rule.minVotingPeriodMs ?? DEFAULT_VOTING_PERIOD_MS, MIN_VOTING_PERIOD_MS);

    const { rows } = await this.pool.query<QuorumRuleRow>(
      `INSERT INTO workspace_quorum_rules (workspace_id, action_type, quorum_type, quorum_threshold, min_voting_period_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, action_type) DO UPDATE
         SET quorum_type = EXCLUDED.quorum_type,
             quorum_threshold = EXCLUDED.quorum_threshold,
             min_voting_period_ms = EXCLUDED.min_voting_period_ms
       RETURNING *`,
      [workspaceId, actionType, rule.quorumType, rule.quorumThreshold ?? null, minVotingMs],
    );

    return { rule: rows[0] };
  }

  async getQuorumRules(workspaceId: string): Promise<QuorumRuleRow[]> {
    const { rows } = await this.pool.query<QuorumRuleRow>(
      `SELECT * FROM workspace_quorum_rules WHERE workspace_id = $1 ORDER BY action_type`,
      [workspaceId],
    );
    return rows;
  }

  async deleteQuorumRule(
    adminId: string,
    workspaceId: string,
    actionType: string,
  ): Promise<{ deleted: boolean } | { error: string; code: string }> {
    const role = await this.workspaceService.getMemberRole(workspaceId, adminId);
    if (role === null || role < 2) {
      return { error: "Admin role required", code: "FORBIDDEN" };
    }

    const { rowCount } = await this.pool.query(
      `DELETE FROM workspace_quorum_rules WHERE workspace_id = $1 AND action_type = $2`,
      [workspaceId, actionType],
    );

    return { deleted: (rowCount ?? 0) > 0 };
  }

  // ============================================================
  //  Internal Helpers
  // ============================================================

  private async getProposalInternal(proposalId: string): Promise<ProposalRow | null> {
    const { rows } = await this.pool.query<ProposalRow>(
      `SELECT * FROM proposals WHERE id = $1`,
      [proposalId],
    );
    return rows[0] ?? null;
  }

  private async getQuorumRuleInternal(workspaceId: string, actionType: string): Promise<QuorumRuleRow | null> {
    const { rows } = await this.pool.query<QuorumRuleRow>(
      `SELECT * FROM workspace_quorum_rules WHERE workspace_id = $1 AND action_type = $2`,
      [workspaceId, actionType],
    );
    return rows[0] ?? null;
  }

  private async logActivity(
    workspaceId: string,
    agentId: string,
    action: string,
    key: string | null,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO workspace_activity (workspace_id, agent_id, action, key, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          workspaceId,
          agentId,
          action,
          key,
          oldValue !== null && oldValue !== undefined ? JSON.stringify(oldValue) : null,
          newValue !== null && newValue !== undefined ? JSON.stringify(newValue) : null,
        ],
      );
    } catch (err) {
      logSecurityEvent("warn", "proposal-activity-log-failed", {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private publishEvent(workspaceId: string, type: string, data: Record<string, unknown>): void {
    if (this.messageBus) {
      this.messageBus.publish(`ws:${workspaceId}`, {
        type,
        timestamp: new Date().toISOString(),
        data,
      });
    }
  }
}
