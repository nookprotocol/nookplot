import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProposalService } from "../proposalService.js";

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockCreditManager() {
  return { deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 1000 }) };
}

function createMockMessageBus() {
  return { publish: vi.fn() };
}

function createMockWorkspaceService() {
  return {
    getMemberRole: vi.fn().mockResolvedValue(1), // editor by default
    setStateInternal: vi.fn().mockResolvedValue(undefined),
    addMemberInternal: vi.fn().mockResolvedValue(true),
    removeMemberInternal: vi.fn().mockResolvedValue(true),
    updateMemberRole: vi.fn().mockResolvedValue(true),
    archiveInternal: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_ID = "a-0001";
const AGENT_B = "a-0002";
const WORKSPACE_ID = "ws-0001";

const PROPOSAL_ROW = {
  id: "p-0001",
  workspace_id: WORKSPACE_ID,
  proposer_id: AGENT_ID,
  title: "Test Proposal",
  description: null,
  action_type: "state_change",
  action_payload: { key: "status", value: "active" },
  quorum_type: "majority",
  quorum_threshold: null,
  status: "open",
  votes_for: 0,
  votes_against: 0,
  eligible_voters: 3,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  executed_at: null,
  cancelled_at: null,
  created_at: new Date().toISOString(),
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService() {
  const pool = createMockPool();
  const creditManager = createMockCreditManager();
  const messageBus = createMockMessageBus();
  const workspaceService = createMockWorkspaceService();

  const service = new ProposalService(pool);
  service.setWorkspaceService(workspaceService);
  service.setCreditManager(creditManager);
  service.setMessageBus(messageBus);

  return { service, pool, creditManager, messageBus, workspaceService };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ProposalService", () => {
  describe("createProposal", () => {
    it("creates proposal, deducts credits, and publishes event", async () => {
      const { service, pool, creditManager, messageBus } = createService();

      pool.query
        // quorum rule lookup
        .mockResolvedValueOnce({ rows: [] })
        // count eligible voters
        .mockResolvedValueOnce({ rows: [{ count: "3" }] })
        // INSERT proposal
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW }] })
        // log activity
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.createProposal(AGENT_ID, WORKSPACE_ID, {
        title: "Test Proposal",
        actionType: "state_change",
        actionPayload: { key: "status", value: "active" },
      });

      expect("proposal" in result).toBe(true);
      if ("proposal" in result) {
        expect(result.proposal.title).toBe("Test Proposal");
        expect(result.proposal.eligible_voters).toBe(3);
      }

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 25, expect.any(String), "proposal_create",
      );

      expect(messageBus.publish).toHaveBeenCalledWith(
        `ws:${WORKSPACE_ID}`,
        expect.objectContaining({
          type: "workspace.proposal_created",
        }),
      );
    });

    it("rejects if insufficient credits", async () => {
      const { service, pool, creditManager } = createService();
      creditManager.deductCredits.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));

      pool.query
        .mockResolvedValueOnce({ rows: [] }) // quorum rule
        .mockResolvedValueOnce({ rows: [{ count: "3" }] }); // voter count

      const result = await service.createProposal(AGENT_ID, WORKSPACE_ID, {
        title: "Test", actionType: "state_change",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("INSUFFICIENT_CREDITS");
      }
    });

    it("rejects invalid action type", async () => {
      const { service } = createService();

      const result = await service.createProposal(AGENT_ID, WORKSPACE_ID, {
        title: "Test", actionType: "invalid_type",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("INVALID_INPUT");
      }
    });

    it("rejects if not a member", async () => {
      const { service, workspaceService } = createService();
      workspaceService.getMemberRole.mockResolvedValueOnce(null);

      const result = await service.createProposal(AGENT_ID, WORKSPACE_ID, {
        title: "Test", actionType: "state_change",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("castVote", () => {
    it("casts vote and publishes event", async () => {
      const { service, pool, creditManager, messageBus } = createService();

      pool.query
        // getProposalInternal
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW, proposer_id: AGENT_B }] })
        // INSERT vote
        .mockResolvedValueOnce({ rows: [] })
        // recount tallies
        .mockResolvedValueOnce({ rows: [{ votes_for: "1", votes_against: "0" }] })
        // UPDATE tallies
        .mockResolvedValueOnce({ rows: [] })
        // get vote row
        .mockResolvedValueOnce({ rows: [{ id: "v-001", proposal_id: "p-0001", voter_id: AGENT_ID, vote: true, weight: 1, reason: null, created_at: new Date().toISOString() }] });

      const result = await service.castVote(AGENT_ID, "p-0001", true, "Looks good");

      expect("vote" in result).toBe(true);
      if ("vote" in result) {
        expect(result.vote.vote).toBe(true);
        expect(result.proposal.votes_for).toBe(1);
      }

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_ID, 5, expect.any(String), "proposal_vote",
      );

      expect(messageBus.publish).toHaveBeenCalledWith(
        `ws:${WORKSPACE_ID}`,
        expect.objectContaining({ type: "workspace.proposal_voted" }),
      );
    });

    it("rejects duplicate vote (409)", async () => {
      const { service, pool } = createService();

      pool.query
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW, proposer_id: AGENT_B }] })
        .mockRejectedValueOnce({ code: "23505" }); // unique violation on INSERT

      const result = await service.castVote(AGENT_ID, "p-0001", true);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("ALREADY_VOTED");
      }
    });

    it("rejects vote on expired proposal", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [{ ...PROPOSAL_ROW, proposer_id: AGENT_B, expires_at: new Date(Date.now() - 1000).toISOString() }],
      });

      const result = await service.castVote(AGENT_ID, "p-0001", true);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("PROPOSAL_EXPIRED");
      }
    });

    it("blocks proposer self-vote", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [{ ...PROPOSAL_ROW, proposer_id: AGENT_ID }],
      });

      const result = await service.castVote(AGENT_ID, "p-0001", true);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("SELF_VOTE");
      }
    });

    it("rejects vote on closed proposal", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [{ ...PROPOSAL_ROW, status: "executed" }],
      });

      const result = await service.castVote(AGENT_ID, "p-0001", true);

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("PROPOSAL_CLOSED");
      }
    });

    it("auto-executes state_change when quorum reached", async () => {
      const { service, pool, workspaceService } = createService();

      pool.query
        // getProposalInternal — 2/3 eligible, majority = need > 1.5, so 2 votes_for passes
        .mockResolvedValueOnce({
          rows: [{
            ...PROPOSAL_ROW,
            proposer_id: AGENT_B,
            eligible_voters: 3,
            action_payload: { key: "status", value: "active" },
          }],
        })
        // INSERT vote
        .mockResolvedValueOnce({ rows: [] })
        // recount tallies — 2 for, 0 against → majority met
        .mockResolvedValueOnce({ rows: [{ votes_for: "2", votes_against: "0" }] })
        // UPDATE tallies
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE status = passed (optimistic lock — must include rowCount: 1)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // executeProposal guard: SELECT executed_at
        .mockResolvedValueOnce({ rows: [{ executed_at: null }] })
        // executeProposal → UPDATE status = executed
        .mockResolvedValueOnce({ rows: [] })
        // log activity for execution
        .mockResolvedValueOnce({ rows: [] })
        // get vote row
        .mockResolvedValueOnce({ rows: [{ id: "v-002", proposal_id: "p-0001", voter_id: AGENT_ID, vote: true, weight: 1, reason: null, created_at: new Date().toISOString() }] });

      const result = await service.castVote(AGENT_ID, "p-0001", true);

      expect("vote" in result).toBe(true);
      if ("vote" in result) {
        expect(result.proposal.status).toBe("passed");
      }

      // Verify setStateInternal was called
      expect(workspaceService.setStateInternal).toHaveBeenCalledWith(WORKSPACE_ID, "status", "active");
    });

    it("auto-rejects when rejection threshold met", async () => {
      const { service, pool } = createService();

      pool.query
        .mockResolvedValueOnce({
          rows: [{
            ...PROPOSAL_ROW,
            proposer_id: AGENT_B,
            eligible_voters: 3,
          }],
        })
        // INSERT vote
        .mockResolvedValueOnce({ rows: [] })
        // recount — 0 for, 2 against → majority rejection (2 >= ceil(3/2) = 2)
        .mockResolvedValueOnce({ rows: [{ votes_for: "0", votes_against: "2" }] })
        // UPDATE tallies
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE status = rejected
        .mockResolvedValueOnce({ rows: [] })
        // get vote row
        .mockResolvedValueOnce({ rows: [{ id: "v-003", proposal_id: "p-0001", voter_id: AGENT_ID, vote: false, weight: 1, reason: null, created_at: new Date().toISOString() }] });

      const result = await service.castVote(AGENT_ID, "p-0001", false);

      expect("vote" in result).toBe(true);
      if ("vote" in result) {
        expect(result.proposal.status).toBe("rejected");
      }
    });
  });

  describe("checkQuorum", () => {
    it("majority: passes when votes_for > eligible/2", () => {
      const { service } = createService();
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "majority", votes_for: 2, eligible_voters: 3 } as any)).toBe(true);
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "majority", votes_for: 1, eligible_voters: 3 } as any)).toBe(false);
    });

    it("supermajority: passes when votes_for > 2/3 eligible", () => {
      const { service } = createService();
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "supermajority", votes_for: 3, eligible_voters: 4 } as any)).toBe(true);
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "supermajority", votes_for: 2, eligible_voters: 4 } as any)).toBe(false);
    });

    it("unanimous: passes only when all vote for", () => {
      const { service } = createService();
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "unanimous", votes_for: 3, eligible_voters: 3 } as any)).toBe(true);
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "unanimous", votes_for: 2, eligible_voters: 3 } as any)).toBe(false);
    });

    it("threshold: passes when votes_for >= threshold", () => {
      const { service } = createService();
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "threshold", votes_for: 5, quorum_threshold: 5, eligible_voters: 10 } as any)).toBe(true);
      expect(service.checkQuorum({ ...PROPOSAL_ROW, quorum_type: "threshold", votes_for: 4, quorum_threshold: 5, eligible_voters: 10 } as any)).toBe(false);
    });
  });

  describe("checkRejection", () => {
    it("majority: rejects when votes_against >= ceil(eligible/2)", () => {
      const { service } = createService();
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "majority", votes_against: 2, eligible_voters: 3 } as any)).toBe(true);
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "majority", votes_against: 1, eligible_voters: 3 } as any)).toBe(false);
    });

    it("supermajority: rejects when votes_against > eligible/3", () => {
      const { service } = createService();
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "supermajority", votes_against: 2, eligible_voters: 4 } as any)).toBe(true);
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "supermajority", votes_against: 1, eligible_voters: 4 } as any)).toBe(false);
    });

    it("unanimous: any against vote rejects", () => {
      const { service } = createService();
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "unanimous", votes_against: 1, eligible_voters: 5 } as any)).toBe(true);
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "unanimous", votes_against: 0, eligible_voters: 5 } as any)).toBe(false);
    });

    it("threshold: rejects when votes_against > eligible - threshold", () => {
      const { service } = createService();
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "threshold", votes_against: 6, quorum_threshold: 5, eligible_voters: 10 } as any)).toBe(true);
      expect(service.checkRejection({ ...PROPOSAL_ROW, quorum_type: "threshold", votes_against: 5, quorum_threshold: 5, eligible_voters: 10 } as any)).toBe(false);
    });
  });

  describe("cancelProposal", () => {
    it("proposer can cancel own proposal", async () => {
      const { service, pool } = createService();

      pool.query
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW }] }) // getProposalInternal
        .mockResolvedValueOnce({ rows: [] }) // UPDATE status
        .mockResolvedValueOnce({ rows: [] }); // log activity

      const result = await service.cancelProposal(AGENT_ID, "p-0001");

      expect("cancelled" in result).toBe(true);
      if ("cancelled" in result) {
        expect(result.cancelled).toBe(true);
      }
    });

    it("admin can cancel any proposal", async () => {
      const { service, pool, workspaceService } = createService();
      workspaceService.getMemberRole.mockResolvedValueOnce(2); // admin

      pool.query
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW, proposer_id: AGENT_B }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.cancelProposal(AGENT_ID, "p-0001");

      expect("cancelled" in result).toBe(true);
    });

    it("non-proposer non-admin cannot cancel", async () => {
      const { service, pool, workspaceService } = createService();
      workspaceService.getMemberRole.mockResolvedValueOnce(1); // editor only

      pool.query.mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW, proposer_id: AGENT_B }] });

      const result = await service.cancelProposal(AGENT_ID, "p-0001");

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("sweepExpiredProposals", () => {
    it("marks expired proposals and publishes events", async () => {
      const { service, pool, messageBus } = createService();

      pool.query.mockResolvedValueOnce({
        rows: [
          { id: "p-001", workspace_id: "ws-001" },
          { id: "p-002", workspace_id: "ws-002" },
        ],
      });

      const count = await service.sweepExpiredProposals();

      expect(count).toBe(2);
      expect(messageBus.publish).toHaveBeenCalledTimes(2);
      expect(messageBus.publish).toHaveBeenCalledWith(
        "ws:ws-001",
        expect.objectContaining({ type: "workspace.proposal_expired" }),
      );
    });
  });

  describe("quorum rules", () => {
    it("sets quorum rule (admin)", async () => {
      const { service, pool, workspaceService } = createService();
      workspaceService.getMemberRole.mockResolvedValueOnce(2);

      const ruleRow = {
        workspace_id: WORKSPACE_ID,
        action_type: "state_change",
        quorum_type: "supermajority",
        quorum_threshold: null,
        min_voting_period_ms: 7200000,
      };
      pool.query.mockResolvedValueOnce({ rows: [ruleRow] });

      const result = await service.setQuorumRule(AGENT_ID, WORKSPACE_ID, "state_change", {
        quorumType: "supermajority",
        minVotingPeriodMs: 7200000,
      });

      expect("rule" in result).toBe(true);
      if ("rule" in result) {
        expect(result.rule.quorum_type).toBe("supermajority");
      }
    });

    it("rejects quorum rule from non-admin", async () => {
      const { service, workspaceService } = createService();
      workspaceService.getMemberRole.mockResolvedValueOnce(1);

      const result = await service.setQuorumRule(AGENT_ID, WORKSPACE_ID, "state_change", {
        quorumType: "majority",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.code).toBe("FORBIDDEN");
      }
    });

    it("gets quorum rules for workspace", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [{ workspace_id: WORKSPACE_ID, action_type: "state_change", quorum_type: "majority", quorum_threshold: null, min_voting_period_ms: 3600000 }] });

      const rules = await service.getQuorumRules(WORKSPACE_ID);
      expect(rules).toHaveLength(1);
    });

    it("deletes quorum rule (admin)", async () => {
      const { service, pool, workspaceService } = createService();
      workspaceService.getMemberRole.mockResolvedValueOnce(2);

      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.deleteQuorumRule(AGENT_ID, WORKSPACE_ID, "state_change");

      expect("deleted" in result).toBe(true);
      if ("deleted" in result) {
        expect(result.deleted).toBe(true);
      }
    });

    it("falls back to defaults when no rule exists", async () => {
      const { service, pool, creditManager } = createService();

      pool.query
        .mockResolvedValueOnce({ rows: [] }) // no quorum rule
        .mockResolvedValueOnce({ rows: [{ count: "5" }] }) // 5 eligible voters
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW, eligible_voters: 5 }] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }); // activity log

      const result = await service.createProposal(AGENT_ID, WORKSPACE_ID, {
        title: "Test", actionType: "state_change",
      });

      expect("proposal" in result).toBe(true);
      if ("proposal" in result) {
        expect(result.proposal.quorum_type).toBe("majority");
      }
    });
  });

  describe("read methods", () => {
    it("getProposal returns proposal or null", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [PROPOSAL_ROW] });
      const found = await service.getProposal("p-0001");
      expect(found).toBeTruthy();

      pool.query.mockResolvedValueOnce({ rows: [] });
      const notFound = await service.getProposal("p-9999");
      expect(notFound).toBeNull();
    });

    it("listProposals with status filter", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [PROPOSAL_ROW] });

      const proposals = await service.listProposals(WORKSPACE_ID, { status: "open" });
      expect(proposals).toHaveLength(1);

      const call = pool.query.mock.calls[0];
      expect(call[0]).toContain("status = $2");
      expect(call[1]).toContain("open");
    });

    it("getVotes returns votes", async () => {
      const { service, pool } = createService();

      pool.query.mockResolvedValueOnce({ rows: [{ id: "v-001", vote: true }] });

      const votes = await service.getVotes("p-0001");
      expect(votes).toHaveLength(1);
    });
  });
});
