import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TeachingExchangeService,
  TEACHING_CREDIT_PROPOSE,
  TEACHING_CREDIT_ACCEPT,
  TEACHING_CREDIT_REWARD,
  type OfferingType,
  type TeachingOfferingRow,
} from "../teachingExchangeService.js";

// ─── Mock Helpers ─────────────────────────────────────────────────────────────

function createMockPool() {
  return {
    query: vi.fn(),
  } as any;
}

function createMockCreditManager() {
  return {
    deductCredits: vi.fn().mockResolvedValue({ balanceAfter: 100 }),
    addCredits: vi.fn().mockResolvedValue({ balanceAfter: 200 }),
  } as any;
}

function createMockChannelService() {
  return {
    createChannel: vi.fn().mockResolvedValue({ id: "channel-123", slug: "teaching-abc" }),
    joinChannel: vi.fn().mockResolvedValue({ id: "member-1" }),
  } as any;
}

const TEACHER_ID = "teacher-001";
const LEARNER_ID = "learner-002";

function makeExchangeRow(overrides: Record<string, any> = {}) {
  return {
    id: "ex-uuid-1",
    teacher_id: TEACHER_ID,
    learner_id: LEARNER_ID,
    goal: "Learn DeFi yield strategies",
    status: "proposed",
    channel_id: null,
    teacher_notes: null,
    learner_feedback: null,
    rating: null,
    credit_cost_teacher: TEACHING_CREDIT_PROPOSE,
    credit_cost_learner: 0,
    credit_reward_teacher: 0,
    proposed_at: "2026-01-01T00:00:00Z",
    accepted_at: null,
    delivered_at: null,
    resolved_at: null,
    expires_at: "2026-01-08T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeOfferingRow(overrides: Record<string, any> = {}): TeachingOfferingRow {
  return {
    id: "off-uuid-1",
    exchange_id: "ex-uuid-1",
    offering_type: "bundle" as OfferingType,
    reference_id: "bundle-42",
    insight_cid: null,
    description: "A great bundle",
    actionable: true,
    actionability_reason: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TeachingExchangeService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let creditManager: ReturnType<typeof createMockCreditManager>;
  let channelService: ReturnType<typeof createMockChannelService>;
  let service: TeachingExchangeService;

  beforeEach(() => {
    pool = createMockPool();
    creditManager = createMockCreditManager();
    channelService = createMockChannelService();
    service = new TeachingExchangeService(pool);
    service.setCreditManager(creditManager);
    service.setChannelService(channelService);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  propose()
  // ════════════════════════════════════════════════════════════════════════════

  describe("propose()", () => {
    it("creates exchange, deducts credits, inserts offerings, checks actionability", async () => {
      const exchangeRow = makeExchangeRow();
      const offeringRow = makeOfferingRow();

      pool.query
        // 1. Validate learner exists
        .mockResolvedValueOnce({ rows: [{ id: LEARNER_ID }] })
        // 2. INSERT exchange
        .mockResolvedValueOnce({ rows: [exchangeRow] })
        // 3. INSERT offering
        .mockResolvedValueOnce({ rows: [offeringRow] });

      const result = await service.propose({
        teacherId: TEACHER_ID,
        learnerId: LEARNER_ID,
        goal: "Learn DeFi yield strategies",
        offerings: [{ type: "bundle", referenceId: "bundle-42", description: "A great bundle" }],
      });

      expect(result.exchange).toEqual(exchangeRow);
      expect(result.offerings).toHaveLength(1);
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        TEACHER_ID,
        TEACHING_CREDIT_PROPOSE,
        expect.stringContaining("teaching-propose"),
        "teaching_propose",
      );
      // Actionability: bundle is always actionable
      expect(result.actionabilityResults[0].actionable).toBe(true);
    });

    it("rejects self-teaching", async () => {
      await expect(
        service.propose({
          teacherId: TEACHER_ID,
          learnerId: TEACHER_ID,
          goal: "Teach myself",
          offerings: [{ type: "insight", description: "test" }],
        }),
      ).rejects.toThrow("Cannot teach yourself");
    });

    it("propagates insufficient credits error", async () => {
      // Validate learner exists
      pool.query.mockResolvedValueOnce({ rows: [{ id: LEARNER_ID }] });
      creditManager.deductCredits.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));

      await expect(
        service.propose({
          teacherId: TEACHER_ID,
          learnerId: LEARNER_ID,
          goal: "Learn something",
          offerings: [{ type: "insight", description: "test" }],
        }),
      ).rejects.toThrow("INSUFFICIENT_CREDITS");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  accept()
  // ════════════════════════════════════════════════════════════════════════════

  describe("accept()", () => {
    it("deducts credits, creates channel, joins both, transitions to accepted", async () => {
      const proposedExchange = makeExchangeRow({ status: "proposed" });
      const acceptedExchange = makeExchangeRow({
        status: "accepted",
        channel_id: "channel-123",
        credit_cost_learner: TEACHING_CREDIT_ACCEPT,
      });

      pool.query
        // getExchangeForUpdate
        .mockResolvedValueOnce({ rows: [proposedExchange] })
        // UPDATE to accepted
        .mockResolvedValueOnce({ rows: [acceptedExchange] });

      const result = await service.accept("ex-uuid-1", LEARNER_ID);

      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        LEARNER_ID,
        TEACHING_CREDIT_ACCEPT,
        "teaching-accept-ex-uuid-1",
        "teaching_accept",
      );
      expect(channelService.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: expect.stringContaining("teaching-"),
          isPublic: false,
          channelType: "teaching",
        }),
      );
      expect(channelService.joinChannel).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("accepted");
    });

    it("rejects if wrong status", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeExchangeRow({ status: "delivered" })],
      });

      await expect(service.accept("ex-uuid-1", LEARNER_ID)).rejects.toThrow(
        "not in 'proposed' status",
      );
    });

    it("rejects if wrong learner", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [makeExchangeRow({ status: "proposed" })],
      });

      await expect(service.accept("ex-uuid-1", "wrong-agent")).rejects.toThrow(
        "Not authorized",
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  deliver()
  // ════════════════════════════════════════════════════════════════════════════

  describe("deliver()", () => {
    it("transitions to delivered with notes", async () => {
      const acceptedExchange = makeExchangeRow({ status: "accepted" });
      const deliveredExchange = makeExchangeRow({
        status: "delivered",
        teacher_notes: "Here's what I taught",
      });

      pool.query
        .mockResolvedValueOnce({ rows: [acceptedExchange] })
        .mockResolvedValueOnce({ rows: [deliveredExchange] });

      const result = await service.deliver("ex-uuid-1", TEACHER_ID, "Here's what I taught");
      expect(result.status).toBe("delivered");
      expect(result.teacher_notes).toBe("Here's what I taught");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  approve()
  // ════════════════════════════════════════════════════════════════════════════

  describe("approve()", () => {
    it("rewards teacher, transitions to approved, recomputes stats", async () => {
      const deliveredExchange = makeExchangeRow({ status: "delivered" });
      const approvedExchange = makeExchangeRow({
        status: "approved",
        rating: 5,
        learner_feedback: "Great teaching!",
        credit_reward_teacher: TEACHING_CREDIT_REWARD,
      });

      pool.query
        // getExchangeForUpdate
        .mockResolvedValueOnce({ rows: [deliveredExchange] })
        // UPDATE to approved
        .mockResolvedValueOnce({ rows: [approvedExchange] })
        // recomputeStats teacher (UPSERT)
        .mockResolvedValueOnce({ rowCount: 1 })
        // recomputeStats learner (UPSERT)
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.approve("ex-uuid-1", LEARNER_ID, "Great teaching!", 5);

      expect(creditManager.addCredits).toHaveBeenCalledWith(
        TEACHER_ID,
        TEACHING_CREDIT_REWARD,
        "teaching_reward",
        "ex-uuid-1",
      );
      expect(result.status).toBe("approved");
      expect(result.rating).toBe(5);
      // Stats recomputed for both
      expect(pool.query).toHaveBeenCalledTimes(4);
    });

    it("rejects invalid rating", async () => {
      await expect(
        service.approve("ex-uuid-1", LEARNER_ID, "Feedback", 6),
      ).rejects.toThrow("Rating must be an integer between 1 and 5");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  reject()
  // ════════════════════════════════════════════════════════════════════════════

  describe("reject()", () => {
    it("transitions to rejected without credit reward, recomputes stats", async () => {
      const deliveredExchange = makeExchangeRow({ status: "delivered" });
      const rejectedExchange = makeExchangeRow({
        status: "rejected",
        learner_feedback: "Not helpful",
      });

      pool.query
        .mockResolvedValueOnce({ rows: [deliveredExchange] })
        .mockResolvedValueOnce({ rows: [rejectedExchange] })
        .mockResolvedValueOnce({ rowCount: 1 }) // recomputeStats teacher
        .mockResolvedValueOnce({ rowCount: 1 }); // recomputeStats learner

      const result = await service.reject("ex-uuid-1", LEARNER_ID, "Not helpful");

      expect(creditManager.addCredits).not.toHaveBeenCalled();
      expect(result.status).toBe("rejected");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  checkActionability()
  // ════════════════════════════════════════════════════════════════════════════

  describe("checkActionability()", () => {
    it("bundle is always actionable", async () => {
      const offerings = [makeOfferingRow({ offering_type: "bundle" })];
      const results = await service.checkActionability(offerings, LEARNER_ID);
      expect(results[0].actionable).toBe(true);
    });

    it("insight is always actionable", async () => {
      const offerings = [makeOfferingRow({ offering_type: "insight", reference_id: null, insight_cid: "bafyabc" })];
      const results = await service.checkActionability(offerings, LEARNER_ID);
      expect(results[0].actionable).toBe(true);
    });

    it("community is not actionable if not found", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] }); // community not found
      const offerings = [makeOfferingRow({ offering_type: "community", reference_id: "comm-1" })];
      const results = await service.checkActionability(offerings, LEARNER_ID);
      expect(results[0].actionable).toBe(false);
      expect(results[0].reason).toContain("not found");
    });

    it("private channel is not actionable if learner not a member", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: "ch-1", is_public: false }] }) // channel exists, private
        .mockResolvedValueOnce({ rows: [] }); // learner not a member
      const offerings = [makeOfferingRow({ offering_type: "channel", reference_id: "ch-1" })];
      const results = await service.checkActionability(offerings, LEARNER_ID);
      expect(results[0].actionable).toBe(false);
      expect(results[0].reason).toContain("private");
    });

    it("guild is not actionable if learner already a member", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ clique_id: "g-1", status: 2 }] }) // guild exists, active
        .mockResolvedValueOnce({ rows: [{ member: LEARNER_ID }] }); // already a member
      const offerings = [makeOfferingRow({ offering_type: "guild", reference_id: "g-1" })];
      const results = await service.checkActionability(offerings, LEARNER_ID);
      expect(results[0].actionable).toBe(false);
      expect(results[0].reason).toContain("already a guild member");
    });

    it("project is not actionable if not active", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: "p-1", status: "archived" }] });
      const offerings = [makeOfferingRow({ offering_type: "project", reference_id: "p-1" })];
      const results = await service.checkActionability(offerings, LEARNER_ID);
      expect(results[0].actionable).toBe(false);
      expect(results[0].reason).toContain("not active");
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  searchTeachers()
  // ════════════════════════════════════════════════════════════════════════════

  describe("searchTeachers()", () => {
    it("returns teachers sorted by composite score", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            address: "0xTeacher1",
            display_name: "Alice",
            bundle_id: "b-1",
            bundle_title: "DeFi Basics",
            relevance: 0.9,
            teaching_reputation: 80,
            approval_rate: 0.95,
          },
        ],
      });

      const results = await service.searchTeachers("DeFi yield strategies");
      expect(results).toHaveLength(1);
      expect(results[0].address).toBe("0xTeacher1");
      expect(results[0].compositeScore).toBeGreaterThan(0);
    });

    it("returns empty for very short/garbage query", async () => {
      const results = await service.searchTeachers("a");
      expect(results).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  expireStaleExchanges()
  // ════════════════════════════════════════════════════════════════════════════

  describe("expireStaleExchanges()", () => {
    it("returns count of expired exchanges", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 3 });
      const count = await service.expireStaleExchanges();
      expect(count).toBe(3);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  Gap signals
  // ════════════════════════════════════════════════════════════════════════════

  describe("recordGapSignal()", () => {
    it("inserts gap signal for low-result queries", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      await service.recordGapSignal("how to optimize DeFi yields", 1, 0.3, "agent-1");
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("skips if result count >= 3", async () => {
      await service.recordGapSignal("popular topic", 5, 0.9);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("skips if query too short", async () => {
      await service.recordGapSignal("short", 0, 0);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe("markGapFilled()", () => {
    it("updates gap and increments filler stats", async () => {
      const filledGap = {
        id: "gap-1",
        query_text: "how to optimize yields",
        filled: true,
        filled_by: "agent-1",
        filled_bundle_id: "b-1",
      };

      pool.query
        .mockResolvedValueOnce({ rows: [filledGap] }) // UPDATE gap
        .mockResolvedValueOnce({ rowCount: 1 }); // UPSERT stats

      const result = await service.markGapFilled("gap-1", "agent-1", "b-1");
      expect(result).not.toBeNull();
      expect(result!.filled).toBe(true);
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("returns null if gap already filled", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const result = await service.markGapFilled("gap-1", "agent-1", "b-1");
      expect(result).toBeNull();
    });
  });
});
