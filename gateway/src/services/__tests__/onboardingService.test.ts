import { describe, it, expect, vi, beforeEach } from "vitest";
import { OnboardingService } from "../onboardingService.js";

function createMockPool() {
  return {
    query: vi.fn(),
  } as any;
}

function createMockSearchService() {
  return {
    search: vi.fn().mockResolvedValue({
      results: [],
      total: 0,
      limit: 5,
      offset: 0,
      query: "",
    }),
  } as any;
}

function createMockBundleDiscoveryService() {
  return {
    discover: vi.fn().mockResolvedValue([]),
  } as any;
}

function createMockInterestEngine() {
  return {
    createSubscription: vi.fn().mockResolvedValue({ id: "sub-1" }),
  } as any;
}

describe("OnboardingService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let searchService: ReturnType<typeof createMockSearchService>;
  let bundleDiscovery: ReturnType<typeof createMockBundleDiscoveryService>;
  let interestEngine: ReturnType<typeof createMockInterestEngine>;
  let service: OnboardingService;

  beforeEach(() => {
    pool = createMockPool();
    searchService = createMockSearchService();
    bundleDiscovery = createMockBundleDiscoveryService();
    interestEngine = createMockInterestEngine();
    service = new OnboardingService(pool);
  });

  // ============================================================
  //  buildBootstrapPayload
  // ============================================================

  describe("buildBootstrapPayload", () => {
    it("returns a bootstrap payload with network stats", async () => {
      // Mock network stats queries
      pool.query
        .mockResolvedValueOnce({ rows: [{ count: "42" }] })   // agents
        .mockResolvedValueOnce({ rows: [{ count: "8" }] })    // communities
        .mockResolvedValueOnce({ rows: [{ count: "6" }] });   // bounties

      const payload = await service.buildBootstrapPayload(
        "agent-1", null, null, null, null,
      );

      expect(payload).not.toBeNull();
      expect(payload!.credits).toEqual({ balance: 1000.0, currency: "credits" });
      expect(payload!.network.totalAgents).toBe(42);
      expect(payload!.network.totalCommunities).toBe(8);
      expect(payload!.network.openBounties).toBe(6);
      expect(payload!.suggestedActions.length).toBeGreaterThanOrEqual(2);
    });

    it("includes relevant items when capabilities provided", async () => {
      // Mock network stats
      pool.query
        .mockResolvedValueOnce({ rows: [{ count: "10" }] })
        .mockResolvedValueOnce({ rows: [{ count: "3" }] })
        .mockResolvedValueOnce({ rows: [{ count: "2" }] });

      // Mock search results
      searchService.search
        .mockResolvedValueOnce({
          results: [{ type: "agent", id: "a1", title: "ML Bot", snippet: "ML expert", relevance: 0.9, metadata: {} }],
          total: 1, limit: 3, offset: 0, query: "ml",
        })
        .mockResolvedValueOnce({
          results: [{ type: "channel", id: "c1", title: "ML Hub", snippet: "ML community", relevance: 0.8, metadata: {} }],
          total: 1, limit: 3, offset: 0, query: "ml",
        })
        .mockResolvedValueOnce({
          results: [{ type: "bounty", id: "b1", title: "Build classifier", snippet: "Need ML model", relevance: 0.7, metadata: {} }],
          total: 1, limit: 3, offset: 0, query: "ml",
        });

      const payload = await service.buildBootstrapPayload(
        "agent-1", ["ml", "nlp"], "Machine learning researcher", searchService, null,
      );

      expect(payload).not.toBeNull();
      expect(payload!.relevantTo.agents.length).toBe(1);
      expect(payload!.relevantTo.agents[0].name).toBe("ML Bot");
      expect(payload!.relevantTo.communities.length).toBe(1);
      expect(payload!.relevantTo.bounties.length).toBe(1);
    });

    it("returns null on timeout", async () => {
      // Simulate a slow query that exceeds the 500ms timeout
      pool.query.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ rows: [{ count: "0" }] }), 600)));

      const payload = await service.buildBootstrapPayload(
        "agent-1", null, null, null, null,
      );

      expect(payload).toBeNull();
    });

    it("handles query failures gracefully with zero stats", async () => {
      pool.query.mockRejectedValue(new Error("DB error"));

      const payload = await service.buildBootstrapPayload(
        "agent-1", null, null, null, null,
      );

      // Promise.allSettled makes this resilient — returns zero stats, not null
      expect(payload).not.toBeNull();
      expect(payload!.network.totalAgents).toBe(0);
      expect(payload!.network.totalCommunities).toBe(0);
      expect(payload!.network.openBounties).toBe(0);
    });
  });

  // ============================================================
  //  checkOnboardingProgress
  // ============================================================

  describe("checkOnboardingProgress", () => {
    it("returns null if onboarding already completed", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ onboarding_completed_at: new Date() }],
      });

      const nudge = await service.checkOnboardingProgress("agent-1");
      expect(nudge).toBeNull();
    });

    it("returns first uncompleted milestone as nudge", async () => {
      // onboarding_completed_at is null
      pool.query.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] });
      // agent address
      pool.query.mockResolvedValueOnce({ rows: [{ address: "0xabc" }] });
      // community membership check (not found)
      pool.query.mockResolvedValueOnce({ rows: [] });
      // nudge already sent check (not sent)
      pool.query.mockResolvedValueOnce({ rows: [] });

      const nudge = await service.checkOnboardingProgress("agent-1");
      expect(nudge).not.toBeNull();
      expect(nudge!.milestone).toBe("join_community");
      expect(nudge!.signalType).toBe("onboarding_suggestion");
    });

    it("skips already-sent nudges", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] });
      pool.query.mockResolvedValueOnce({ rows: [{ address: "0xabc" }] });
      // community membership check — NOT a member
      pool.query.mockResolvedValueOnce({ rows: [] });
      // nudge already sent — YES, community nudge was sent
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // post check — NOT posted
      pool.query.mockResolvedValueOnce({ rows: [] });
      // post nudge already sent — NO
      pool.query.mockResolvedValueOnce({ rows: [] });

      const nudge = await service.checkOnboardingProgress("agent-1");
      expect(nudge).not.toBeNull();
      expect(nudge!.milestone).toBe("first_post");
    });

    it("marks onboarding complete when all milestones done", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ onboarding_completed_at: null }] });
      pool.query.mockResolvedValueOnce({ rows: [{ address: "0xabc" }] });
      // community — completed
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // post — completed
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // follow — completed
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // service listing — completed
      pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // update onboarding_completed_at
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const nudge = await service.checkOnboardingProgress("agent-1");
      expect(nudge).toBeNull();
      // The last query should update onboarding_completed_at
      const lastCall = pool.query.mock.calls[pool.query.mock.calls.length - 1];
      expect(lastCall[0]).toContain("onboarding_completed_at");
    });
  });

  // ============================================================
  //  buildSpecializationPlan
  // ============================================================

  describe("buildSpecializationPlan", () => {
    it("returns a specialization plan with steps", async () => {
      // Mock marketplace gaps query
      pool.query.mockResolvedValueOnce({
        rows: [{ category: "consulting", count: "2" }],
      });
      // Mock proactive settings update
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      // Mock proactive_actions insert
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const plan = await service.buildSpecializationPlan(
        "agent-1", "machine-learning", null, null, null,
      );

      expect(plan.domain).toBe("machine-learning");
      expect(plan.steps).toHaveLength(4);
      expect(plan.steps[0].phase).toBe("learn");
      expect(plan.steps[1].phase).toBe("connect");
      expect(plan.steps[2].phase).toBe("contribute");
      expect(plan.steps[3].phase).toBe("monetize");
      expect(plan.suggestedSettings.maxCreditsPerCycle).toBe(3000);
    });

    it("creates interest subscription when interestEngine available", async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await service.buildSpecializationPlan(
        "agent-1", "research", null, null, interestEngine,
      );

      expect(interestEngine.createSubscription).toHaveBeenCalledWith("agent-1", {
        label: "Specialization: research",
        tags: ["research"],
        matchMode: "any",
        notifyRealtime: true,
      });
    });

    it("includes search results when services available", async () => {
      // Mock marketplace gaps
      pool.query.mockResolvedValueOnce({ rows: [] });
      // Mock settings update
      pool.query.mockResolvedValueOnce({ rowCount: 1 });
      // Mock action insert
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      searchService.search
        .mockResolvedValueOnce({
          results: [{ type: "channel", id: "c1", title: "AI Research", snippet: "Research community", relevance: 0.9, metadata: {} }],
          total: 1, limit: 5, offset: 0, query: "ai",
        })
        .mockResolvedValueOnce({
          results: [{ type: "agent", id: "a1", title: "ResearchBot", snippet: "AI researcher", relevance: 0.8, metadata: { address: "0x123" } }],
          total: 1, limit: 5, offset: 0, query: "ai",
        })
        .mockResolvedValueOnce({
          results: [],
          total: 0, limit: 5, offset: 0, query: "ai",
        });

      bundleDiscovery.discover.mockResolvedValueOnce([
        { bundleId: 1, name: "AI Basics", summary: "Intro to AI", relevanceScore: 0.9 },
      ]);

      const plan = await service.buildSpecializationPlan(
        "agent-1", "ai", searchService, bundleDiscovery, null,
      );

      expect(plan.steps[0].items.length).toBe(1); // learn — 1 bundle
      expect(plan.steps[0].items[0].name).toBe("AI Basics");
      expect(plan.steps[1].items.length).toBe(2); // connect — 1 community + 1 expert
    });
  });

  // ============================================================
  //  recordNudgeSent
  // ============================================================

  describe("recordNudgeSent", () => {
    it("inserts a proactive_actions row", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.recordNudgeSent("agent-1", "onboarding_nudge_community");

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO proactive_actions"),
        ["agent-1", "onboarding_nudge_community"],
      );
    });
  });
});
