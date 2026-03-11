import { describe, it, expect, vi, beforeEach } from "vitest";
import { IntentService } from "../intentService.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ─── Mock Factories ──────────────────────────────────────────────────────────

function createMockPool() {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  } as any;
}

function createMockMessageBus() {
  return { publish: vi.fn() };
}

function createMockEmbeddingService() {
  return { embedAndStore: vi.fn().mockResolvedValue(undefined) };
}

function createMockProactiveScheduler() {
  return { handleReactiveSignal: vi.fn().mockResolvedValue(undefined) };
}

function createMockInboxService() {
  return { send: vi.fn().mockResolvedValue({ id: "msg-1" }) };
}

function createMockSpecializationService() {
  return { recordSignal: vi.fn().mockResolvedValue(undefined) };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_ID = "agent-1";
const AGENT_ADDRESS = "0x1234567890123456789012345678901234567890";
const OTHER_AGENT_ID = "agent-2";
const OTHER_AGENT_ADDRESS = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
const INTENT_ID = "intent-1";
const PROPOSAL_ID = "proposal-1";

const INTENT_ROW = {
  id: INTENT_ID,
  creator_id: AGENT_ID,
  creator_address: AGENT_ADDRESS.toLowerCase(),
  title: "Build a REST API",
  description: "Need an agent to build a REST API with authentication and rate limiting",
  required_skills: ["typescript", "api-design"],
  budget_amount: "500",
  budget_token: null,
  deadline: null,
  category: "development",
  tags: ["api", "backend"],
  status: "open",
  metadata: {},
  accepted_proposal_id: null,
  agreement_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const PROPOSAL_ROW = {
  id: PROPOSAL_ID,
  intent_id: INTENT_ID,
  proposer_id: OTHER_AGENT_ID,
  proposer_address: OTHER_AGENT_ADDRESS.toLowerCase(),
  description: "I can build this API using Express with JWT auth and Redis rate limiting",
  approach: "Will use Express, Postgres, and Redis",
  estimated_cost: "400",
  estimated_duration_hours: 40,
  status: "pending",
  metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService(opts?: { withMatching?: boolean }) {
  const pool = createMockPool();
  const messageBus = createMockMessageBus();
  const embeddingService = createMockEmbeddingService();
  const proactiveScheduler = createMockProactiveScheduler();
  const inboxService = createMockInboxService();
  const specializationService = createMockSpecializationService();
  const service = new IntentService(pool);
  service.setMessageBus(messageBus as any);
  service.setEmbeddingService(embeddingService as any);
  if (opts?.withMatching) {
    service.setProactiveScheduler(proactiveScheduler as any);
    service.setInboxService(inboxService as any);
    service.setSpecializationService(specializationService as any);
  }
  return { pool, messageBus, embeddingService, proactiveScheduler, inboxService, specializationService, service };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IntentService", () => {

  // ─── createIntent ─────────────────────────────────────────────

  describe("createIntent", () => {
    it("inserts intent, publishes event, and triggers embedding", async () => {
      const { pool, messageBus, embeddingService, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      const result = await service.createIntent({
        creatorId: AGENT_ID,
        creatorAddress: AGENT_ADDRESS,
        title: "Build a REST API",
        description: "Need an agent to build a REST API with authentication and rate limiting",
        requiredSkills: ["TypeScript", "API-Design"],
        budgetAmount: 500,
        category: "development",
        tags: ["API", "Backend"],
      });

      expect(result).toEqual(INTENT_ROW);
      expect(pool.query).toHaveBeenCalledTimes(1);
      // Skills and tags lowercased
      const insertArgs = pool.query.mock.calls[0][1];
      expect(insertArgs[4]).toEqual(["typescript", "api-design"]);
      expect(insertArgs[9]).toEqual(["api", "backend"]);
      // Address lowercased
      expect(insertArgs[1]).toBe(AGENT_ADDRESS.toLowerCase());

      expect(messageBus.publish).toHaveBeenCalledWith("entity:intent", expect.objectContaining({
        type: "entity:intent",
      }));
      expect(embeddingService.embedAndStore).toHaveBeenCalledWith(
        "intent",
        INTENT_ID,
        expect.stringContaining("Build a REST API"),
      );
    });

    it("throws on title too short", async () => {
      const { service } = createService();
      await expect(
        service.createIntent({
          creatorId: AGENT_ID,
          creatorAddress: AGENT_ADDRESS,
          title: "ab",
          description: "A valid description that is long enough",
        }),
      ).rejects.toThrow("Title must be at least 3 characters");
    });

    it("throws on description too short", async () => {
      const { service } = createService();
      await expect(
        service.createIntent({
          creatorId: AGENT_ID,
          creatorAddress: AGENT_ADDRESS,
          title: "Valid title",
          description: "Short",
        }),
      ).rejects.toThrow("Description must be at least 10 characters");
    });

    it("works without optional fields", async () => {
      const { pool, service } = createService();
      const minimalRow = { ...INTENT_ROW, required_skills: [], tags: [], category: null };
      pool.query.mockResolvedValueOnce({ rows: [minimalRow] });

      const result = await service.createIntent({
        creatorId: AGENT_ID,
        creatorAddress: AGENT_ADDRESS,
        title: "Simple task",
        description: "A straightforward task with no special requirements",
      });

      expect(result).toEqual(minimalRow);
      const insertArgs = pool.query.mock.calls[0][1];
      expect(insertArgs[4]).toEqual([]); // empty skills
      expect(insertArgs[9]).toEqual([]); // empty tags
    });
  });

  // ─── getIntent ─────────────────────────────────────────────

  describe("getIntent", () => {
    it("returns intent row when found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      const result = await service.getIntent(INTENT_ID);
      expect(result).toEqual(INTENT_ROW);
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("SELECT * FROM intents"), [INTENT_ID]);
    });

    it("returns null when not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getIntent("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ─── searchIntents ─────────────────────────────────────────

  describe("searchIntents", () => {
    it("returns intents and total count with no filters", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })
        .mockResolvedValueOnce({ rows: [{ count: "1" }] });

      const result = await service.searchIntents({});
      expect(result.intents).toEqual([INTENT_ROW]);
      expect(result.total).toBe(1);
    });

    it("applies status and category filters", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.searchIntents({ status: "open", category: "development" });

      const dataSql = pool.query.mock.calls[0][0] as string;
      expect(dataSql).toContain("status = $1");
      expect(dataSql).toContain("category = $2");
      expect(pool.query.mock.calls[0][1]).toEqual(["open", "development", 50, 0]);
    });

    it("applies text search filter", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.searchIntents({ q: "REST" });

      const dataSql = pool.query.mock.calls[0][0] as string;
      expect(dataSql).toContain("ILIKE");
      expect(pool.query.mock.calls[0][1]).toEqual(["%REST%", 50, 0]);
    });

    it("caps limit at 200", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.searchIntents({ limit: 500 });

      const args = pool.query.mock.calls[0][1] as unknown[];
      expect(args[0]).toBe(200); // capped
    });
  });

  // ─── updateIntent ─────────────────────────────────────────

  describe("updateIntent", () => {
    it("updates fields on an open intent owned by creator", async () => {
      const { pool, service } = createService();
      const updated = { ...INTENT_ROW, title: "Updated title" };
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })  // getIntent
        .mockResolvedValueOnce({ rows: [updated] });     // UPDATE

      const result = await service.updateIntent(INTENT_ID, AGENT_ID, { title: "Updated title" });
      expect(result?.title).toBe("Updated title");
    });

    it("throws if intent not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.updateIntent(INTENT_ID, AGENT_ID, { title: "X" }))
        .rejects.toThrow("Intent not found");
    });

    it("throws if not the creator", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      await expect(service.updateIntent(INTENT_ID, OTHER_AGENT_ID, { title: "X" }))
        .rejects.toThrow("Not the intent creator");
    });

    it("throws if intent is not open", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "in_progress" }] });

      await expect(service.updateIntent(INTENT_ID, AGENT_ID, { title: "X" }))
        .rejects.toThrow("Can only update open intents");
    });

    it("returns existing intent when no fields provided", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      const result = await service.updateIntent(INTENT_ID, AGENT_ID, {});
      expect(result).toEqual(INTENT_ROW);
      // Only the getIntent query should fire, no UPDATE
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  // ─── cancelIntent ─────────────────────────────────────────

  describe("cancelIntent", () => {
    it("cancels an open intent", async () => {
      const { pool, service } = createService();
      const cancelled = { ...INTENT_ROW, status: "cancelled" };
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })    // getIntent
        .mockResolvedValueOnce({ rows: [cancelled] });     // UPDATE

      const result = await service.cancelIntent(INTENT_ID, AGENT_ID);
      expect(result.status).toBe("cancelled");
    });

    it("throws if not the creator", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      await expect(service.cancelIntent(INTENT_ID, OTHER_AGENT_ID))
        .rejects.toThrow("Not the intent creator");
    });

    it("throws if already cancelled", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "cancelled" }] });

      await expect(service.cancelIntent(INTENT_ID, AGENT_ID))
        .rejects.toThrow("Cannot cancel intent with status: cancelled");
    });

    it("throws if already completed", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "completed" }] });

      await expect(service.cancelIntent(INTENT_ID, AGENT_ID))
        .rejects.toThrow("Cannot cancel intent with status: completed");
    });
  });

  // ─── completeIntent ─────────────────────────────────────────

  describe("completeIntent", () => {
    it("completes an in-progress intent", async () => {
      const { pool, service } = createService();
      const inProgress = { ...INTENT_ROW, status: "in_progress" };
      const completed = { ...INTENT_ROW, status: "completed" };
      pool.query
        .mockResolvedValueOnce({ rows: [inProgress] })   // getIntent
        .mockResolvedValueOnce({ rows: [completed] });    // UPDATE

      const result = await service.completeIntent(INTENT_ID, AGENT_ID);
      expect(result.status).toBe("completed");
    });

    it("throws if not in_progress", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] }); // status = "open"

      await expect(service.completeIntent(INTENT_ID, AGENT_ID))
        .rejects.toThrow("Can only complete in-progress intents");
    });

    it("throws if not the creator", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "in_progress" }] });

      await expect(service.completeIntent(INTENT_ID, OTHER_AGENT_ID))
        .rejects.toThrow("Not the intent creator");
    });
  });

  // ─── createProposal ─────────────────────────────────────────

  describe("createProposal", () => {
    it("creates a proposal on an open intent", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })      // getIntent
        .mockResolvedValueOnce({ rows: [PROPOSAL_ROW] });    // INSERT

      const result = await service.createProposal({
        intentId: INTENT_ID,
        proposerId: OTHER_AGENT_ID,
        proposerAddress: OTHER_AGENT_ADDRESS,
        description: "I can build this API using Express with JWT auth and Redis rate limiting",
        approach: "Will use Express, Postgres, and Redis",
        estimatedCost: 400,
        estimatedDurationHours: 40,
      });

      expect(result).toEqual(PROPOSAL_ROW);
      // Address lowercased in insert
      const insertArgs = pool.query.mock.calls[1][1];
      expect(insertArgs[2]).toBe(OTHER_AGENT_ADDRESS.toLowerCase());
    });

    it("throws if intent is not open", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "in_progress" }] });

      await expect(
        service.createProposal({
          intentId: INTENT_ID,
          proposerId: OTHER_AGENT_ID,
          proposerAddress: OTHER_AGENT_ADDRESS,
          description: "A sufficiently long description for the proposal",
        }),
      ).rejects.toThrow("Intent is not open for proposals");
    });

    it("throws if proposer is the intent creator", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      await expect(
        service.createProposal({
          intentId: INTENT_ID,
          proposerId: AGENT_ID, // same as creator
          proposerAddress: AGENT_ADDRESS,
          description: "A sufficiently long description for the proposal",
        }),
      ).rejects.toThrow("Cannot propose on your own intent");
    });

    it("throws if description is too short", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      await expect(
        service.createProposal({
          intentId: INTENT_ID,
          proposerId: OTHER_AGENT_ID,
          proposerAddress: OTHER_AGENT_ADDRESS,
          description: "Too short",
        }),
      ).rejects.toThrow("Proposal description must be at least 10 characters");
    });
  });

  // ─── listProposals ─────────────────────────────────────────

  describe("listProposals", () => {
    it("returns proposals for an intent", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [PROPOSAL_ROW] });

      const result = await service.listProposals(INTENT_ID);
      expect(result).toEqual([PROPOSAL_ROW]);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("intent_id = $1"),
        [INTENT_ID],
      );
    });
  });

  // ─── acceptProposal ─────────────────────────────────────────

  describe("acceptProposal", () => {
    it("accepts proposal in a transaction", async () => {
      const { pool, service } = createService();
      const client = pool._client;
      // getIntent (via pool.query, not client)
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });
      // Transaction queries via client
      client.query
        .mockResolvedValueOnce(undefined)                                                    // BEGIN
        .mockResolvedValueOnce({ rows: [{ ...PROPOSAL_ROW, status: "accepted" }] })          // accept proposal
        .mockResolvedValueOnce({ rowCount: 2 })                                              // reject others
        .mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "in_progress" }] })          // update intent
        .mockResolvedValueOnce(undefined);                                                   // COMMIT

      const result = await service.acceptProposal(INTENT_ID, PROPOSAL_ID, AGENT_ID);
      expect(result.proposal.status).toBe("accepted");
      expect(result.intent.status).toBe("in_progress");
      expect(client.query).toHaveBeenCalledWith("BEGIN");
      expect(client.query).toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    it("throws if not the intent creator", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      await expect(service.acceptProposal(INTENT_ID, PROPOSAL_ID, OTHER_AGENT_ID))
        .rejects.toThrow("Not the intent creator");
    });

    it("throws if intent is not open", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: "in_progress" }] });

      await expect(service.acceptProposal(INTENT_ID, PROPOSAL_ID, AGENT_ID))
        .rejects.toThrow("Intent is not open");
    });

    it("rolls back and throws if proposal not found", async () => {
      const { pool, service } = createService();
      const client = pool._client;
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });
      client.query
        .mockResolvedValueOnce(undefined)                // BEGIN
        .mockResolvedValueOnce({ rows: [] })             // proposal not found
        .mockResolvedValueOnce(undefined);               // ROLLBACK

      await expect(service.acceptProposal(INTENT_ID, "bad-id", AGENT_ID))
        .rejects.toThrow("Proposal not found");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });
  });

  // ─── rejectProposal ─────────────────────────────────────────

  describe("rejectProposal", () => {
    it("rejects a pending proposal", async () => {
      const { pool, service } = createService();
      const rejected = { ...PROPOSAL_ROW, status: "rejected" };
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })  // getIntent
        .mockResolvedValueOnce({ rows: [rejected] });    // UPDATE

      const result = await service.rejectProposal(INTENT_ID, PROPOSAL_ID, AGENT_ID);
      expect(result.status).toBe("rejected");
    });

    it("throws if proposal not found or not pending", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(service.rejectProposal(INTENT_ID, PROPOSAL_ID, AGENT_ID))
        .rejects.toThrow("Proposal not found or not pending");
    });
  });

  // ─── withdrawProposal ─────────────────────────────────────────

  describe("withdrawProposal", () => {
    it("withdraws a pending proposal by its proposer", async () => {
      const { pool, service } = createService();
      const withdrawn = { ...PROPOSAL_ROW, status: "withdrawn" };
      pool.query.mockResolvedValueOnce({ rows: [withdrawn] });

      const result = await service.withdrawProposal(INTENT_ID, PROPOSAL_ID, OTHER_AGENT_ID);
      expect(result.status).toBe("withdrawn");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("proposer_id = $3"),
        [PROPOSAL_ID, INTENT_ID, OTHER_AGENT_ID],
      );
    });

    it("throws if proposal not found or not pending", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.withdrawProposal(INTENT_ID, PROPOSAL_ID, OTHER_AGENT_ID))
        .rejects.toThrow("Proposal not found or not pending");
    });
  });

  // ─── matchAgentsToIntent ─────────────────────────────────────

  describe("matchAgentsToIntent", () => {
    it("returns top agents by contribution score when no skills required", async () => {
      const { pool, service } = createService();
      const noSkillsIntent = { ...INTENT_ROW, required_skills: [] };
      pool.query
        .mockResolvedValueOnce({ rows: [noSkillsIntent] })   // getIntent
        .mockResolvedValueOnce({                               // agent query
          rows: [
            { agent_id: "a-99", address: "0x99", display_name: "topagent", total_score: "5000" },
          ],
        });

      const matches = await service.matchAgentsToIntent(INTENT_ID);
      expect(matches).toHaveLength(1);
      expect(matches[0].agentId).toBe("a-99");
      expect(matches[0].matchScore).toBe(50); // 5000 / 100
    });

    it("returns skill-matched agents with composite score", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })  // getIntent (skills: ["typescript", "api-design"])
        .mockResolvedValueOnce({
          rows: [
            { agent_id: "a-50", address: "0x50", display_name: "skilldev", overlap: "2", total_score: "10000" },
          ],
        });

      const matches = await service.matchAgentsToIntent(INTENT_ID);
      expect(matches).toHaveLength(1);
      // (2/2)*0.7 + (10000/20000)*0.3 = 0.7 + 0.15 = 0.85
      expect(matches[0].matchScore).toBeCloseTo(0.85);
    });

    it("returns empty array when intent not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const matches = await service.matchAgentsToIntent("missing");
      expect(matches).toEqual([]);
    });
  });

  // ─── matchIntentsToAgent ─────────────────────────────────────

  describe("matchIntentsToAgent", () => {
    it("returns open intents matching agent expertise", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      const result = await service.matchIntentsToAgent(OTHER_AGENT_ID);
      expect(result).toEqual([INTENT_ROW]);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'open'"),
        [OTHER_AGENT_ID, 20],
      );
    });
  });

  // ─── notifyMatchingAgents (via createIntent) ──────────────

  describe("notifyMatchingAgents", () => {
    it("sends proactive signals and inbox messages to matching agents", async () => {
      const { pool, proactiveScheduler, inboxService, specializationService, service } = createService({ withMatching: true });

      // createIntent INSERT
      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });
      // notifyMatchingAgents: expertise_tags + endorsements query
      pool.query.mockResolvedValueOnce({
        rows: [
          { agent_id: "match-1", address: "0xM1", display_name: "matcher", tag: "typescript", confidence: 0.9, endorsement_score: 4.5 },
          { agent_id: "match-2", address: "0xM2", display_name: null, tag: "api-design", confidence: 0.7, endorsement_score: 0 },
        ],
      });

      await service.createIntent({
        creatorId: AGENT_ID,
        creatorAddress: AGENT_ADDRESS,
        title: "Build a REST API",
        description: "Need an agent to build a REST API with authentication and rate limiting",
        requiredSkills: ["TypeScript", "API-Design"],
        tags: ["API", "Backend"],
        budgetAmount: 500,
      });

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 50));

      // Proactive signals sent for both matches
      expect(proactiveScheduler.handleReactiveSignal).toHaveBeenCalledTimes(2);
      expect(proactiveScheduler.handleReactiveSignal).toHaveBeenCalledWith(
        "match-1",
        expect.objectContaining({ signalType: "intent_opportunity", intentId: INTENT_ID }),
      );
      expect(proactiveScheduler.handleReactiveSignal).toHaveBeenCalledWith(
        "match-2",
        expect.objectContaining({ signalType: "intent_opportunity" }),
      );

      // Inbox messages sent for both matches
      expect(inboxService.send).toHaveBeenCalledTimes(2);
      expect(inboxService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          fromAgentId: AGENT_ID,
          toAgentId: "match-1",
          messageType: "intent_opportunity",
        }),
      );

      // Demand signals recorded
      expect(specializationService.recordSignal).toHaveBeenCalled();
      expect(specializationService.recordSignal).toHaveBeenCalledWith(
        "typescript", "demand", 1.0, "intent", INTENT_ID, expect.any(Object),
      );
    });

    it("skips matching when no skill keywords can be derived", async () => {
      const { pool, proactiveScheduler, inboxService, service } = createService({ withMatching: true });

      // All words are <= 2 chars, so no skill keywords are extracted
      const noSkillsRow = { ...INTENT_ROW, required_skills: [], tags: [], title: "Go do it", description: "Do it or no go" };
      pool.query.mockResolvedValueOnce({ rows: [noSkillsRow] });

      await service.createIntent({
        creatorId: AGENT_ID,
        creatorAddress: AGENT_ADDRESS,
        title: "Go do it",
        description: "Do it or no go",
      });

      await new Promise((r) => setTimeout(r, 50));

      // No matching query should fire (only the INSERT)
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(proactiveScheduler.handleReactiveSignal).not.toHaveBeenCalled();
      expect(inboxService.send).not.toHaveBeenCalled();
    });

    it("handles zero matches gracefully", async () => {
      const { pool, proactiveScheduler, inboxService, service } = createService({ withMatching: true });

      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });
      pool.query.mockResolvedValueOnce({ rows: [] }); // no matches

      await service.createIntent({
        creatorId: AGENT_ID,
        creatorAddress: AGENT_ADDRESS,
        title: "Build a REST API",
        description: "Need an agent to build a REST API with authentication and rate limiting",
        requiredSkills: ["TypeScript"],
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(proactiveScheduler.handleReactiveSignal).not.toHaveBeenCalled();
      expect(inboxService.send).not.toHaveBeenCalled();
    });

    it("does not notify when no matching services are wired", async () => {
      const { pool, service } = createService(); // withMatching: false (default)

      pool.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });

      await service.createIntent({
        creatorId: AGENT_ID,
        creatorAddress: AGENT_ADDRESS,
        title: "Build a REST API",
        description: "Need an agent to build a REST API with authentication and rate limiting",
        requiredSkills: ["TypeScript"],
      });

      await new Promise((r) => setTimeout(r, 50));

      // Only INSERT query, no matching query
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  // ─── expireIntents ─────────────────────────────────────────

  describe("expireIntents", () => {
    it("expires overdue open intents and returns count", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 3 });

      const count = await service.expireIntents();
      expect(count).toBe(3);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'expired'"),
      );
    });

    it("returns 0 when no intents expired", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      const count = await service.expireIntents();
      expect(count).toBe(0);
    });

    it("returns 0 when rowCount is null", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: null });

      const count = await service.expireIntents();
      expect(count).toBe(0);
    });
  });
});
