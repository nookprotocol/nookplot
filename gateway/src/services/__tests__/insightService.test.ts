import { describe, it, expect, vi, beforeEach } from "vitest";
import { InsightService } from "../insightService.js";

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

function createMockContentScanner() {
  return { scanContent: vi.fn().mockResolvedValue({ blocked: false }) };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_A = "a-0001";
const AGENT_B = "a-0002";
const WORKSPACE_ID = "ws-0001";

const INSIGHT_ROW = {
  id: "ins-0001",
  workspace_id: null,
  author_id: AGENT_A,
  title: "Use caching for repeated queries",
  body: "When querying the same data repeatedly, implement an LRU cache to reduce latency by 80%.",
  strategy_type: "optimization",
  tags: ["caching", "performance"],
  context: {},
  outcome_score: 0.9,
  quality_score: 0.5,
  citation_count: 3,
  application_count: 2,
  success_rate: 0.8,
  is_public: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService() {
  const pool = createMockPool();
  const creditManager = createMockCreditManager();
  const messageBus = createMockMessageBus();
  const contentScanner = createMockContentScanner();
  const service = new InsightService(pool);
  service.setCreditManager(creditManager);
  service.setMessageBus(messageBus);
  service.setContentScanner(contentScanner);
  return { pool, creditManager, messageBus, contentScanner, service };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("InsightService", () => {

  // ─── Publish ─────────────────────────────────────────────────

  describe("publishInsight", () => {
    it("deducts credits, inserts, and publishes event", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] }) // INSERT
        .mockResolvedValueOnce({ rows: [] }); // notifySubscribers query

      const result = await service.publishInsight(AGENT_A, {
        title: "Use caching for repeated queries",
        body: "When querying the same data repeatedly, implement an LRU cache to reduce latency by 80%.",
        strategyType: "optimization",
        tags: ["caching", "performance"],
        outcomeScore: 0.9,
      });

      expect("insight" in result).toBe(true);
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_A, 15, expect.any(String), "insight_publish",
      );
      expect(messageBus.publish).toHaveBeenCalledWith("insights", expect.objectContaining({
        type: "insight.published",
      }));
    });

    it("rejects invalid title", async () => {
      const { service } = createService();
      const result = await service.publishInsight(AGENT_A, {
        title: "",
        body: "Some body text that is long enough.",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects invalid body (too short)", async () => {
      const { service } = createService();
      const result = await service.publishInsight(AGENT_A, {
        title: "Valid title",
        body: "Short",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects invalid strategy type", async () => {
      const { service } = createService();
      const result = await service.publishInsight(AGENT_A, {
        title: "Valid title",
        body: "This is a long enough body for testing purposes.",
        strategyType: "invalid_type",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("returns INSUFFICIENT_CREDITS when balance is low", async () => {
      const { creditManager, service } = createService();
      creditManager.deductCredits.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));

      const result = await service.publishInsight(AGENT_A, {
        title: "Valid title",
        body: "This is a long enough body for testing purposes.",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("blocks content flagged by scanner", async () => {
      const { contentScanner, service } = createService();
      contentScanner.scanContent.mockResolvedValueOnce({ blocked: true });

      const result = await service.publishInsight(AGENT_A, {
        title: "Valid title",
        body: "This is a long enough body for testing purposes.",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("CONTENT_SAFETY_BLOCK");
    });

    it("rejects outcomeScore outside 0-1 range", async () => {
      const { service } = createService();
      const result = await service.publishInsight(AGENT_A, {
        title: "Valid title",
        body: "This is a long enough body for testing purposes.",
        outcomeScore: 1.5,
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });
  });

  // ─── Cite ────────────────────────────────────────────────────

  describe("citeInsight", () => {
    it("inserts citation, updates count, recalculates quality", async () => {
      const { pool, messageBus, service } = createService();
      const citationRow = {
        id: "cit-0001", insight_id: INSIGHT_ROW.id, citing_agent_id: AGENT_B,
        context: "Used in project", outcome_score: 0.8, created_at: new Date().toISOString(),
      };
      pool.query
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] })                // getInsightInternal
        .mockResolvedValueOnce({ rows: [citationRow] })                // INSERT citation
        .mockResolvedValueOnce({ rowCount: 1 })                        // UPDATE citation_count
        .mockResolvedValueOnce({ rows: [{ count: "4", avg_outcome: "0.75", recent_count: "2" }] }) // recalc: citation stats
        .mockResolvedValueOnce({ rows: [{ count: "2", success_count: "1", avg_outcome: "0.6" }] })  // recalc: app stats
        .mockResolvedValueOnce({ rowCount: 1 });                       // recalc: UPDATE

      const result = await service.citeInsight(AGENT_B, INSIGHT_ROW.id, "Used in project", 0.8);

      expect("citation" in result).toBe(true);
      expect(messageBus.publish).toHaveBeenCalledWith("insights", expect.objectContaining({
        type: "insight.cited",
      }));
    });

    it("blocks self-citation", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INSIGHT_ROW] }); // getInsightInternal

      const result = await service.citeInsight(AGENT_A, INSIGHT_ROW.id);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("SELF_CITATION");
    });

    it("returns ALREADY_CITED on duplicate", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] })               // getInsightInternal
        .mockRejectedValueOnce({ code: "23505" });                     // unique violation

      const result = await service.citeInsight(AGENT_B, INSIGHT_ROW.id);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("ALREADY_CITED");
    });

    it("returns NOT_FOUND for missing insight", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] }); // getInsightInternal

      const result = await service.citeInsight(AGENT_B, "nonexistent");

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });
  });

  // ─── Apply ───────────────────────────────────────────────────

  describe("applyInsight", () => {
    it("inserts application and recalculates quality", async () => {
      const { pool, messageBus, service } = createService();
      const appRow = {
        id: "app-0001", insight_id: INSIGHT_ROW.id, agent_id: AGENT_B,
        context: "Applied to task", outcome_score: 0.9, created_at: new Date().toISOString(),
      };
      pool.query
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] })                // getInsightInternal
        .mockResolvedValueOnce({ rows: [appRow] })                     // INSERT application
        .mockResolvedValueOnce({ rowCount: 1 })                        // UPDATE application_count
        .mockResolvedValueOnce({ rows: [{ count: "3", avg_outcome: "0.75", recent_count: "1" }] }) // recalc: citations
        .mockResolvedValueOnce({ rows: [{ count: "3", success_count: "2", avg_outcome: "0.7" }] }) // recalc: apps
        .mockResolvedValueOnce({ rowCount: 1 });                       // recalc: UPDATE

      const result = await service.applyInsight(AGENT_B, INSIGHT_ROW.id, "Applied to task", 0.9);

      expect("application" in result).toBe(true);
      expect(messageBus.publish).toHaveBeenCalledWith("insights", expect.objectContaining({
        type: "insight.applied",
      }));
    });

    it("returns NOT_FOUND for missing insight", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.applyInsight(AGENT_B, "nonexistent");

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });
  });

  // ─── Quality Scoring ─────────────────────────────────────────

  describe("recalculateQuality", () => {
    it("computes quality from citations and applications", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ count: "10", weighted_avg_outcome: "0.8", recent_count: "5" }] })
        .mockResolvedValueOnce({ rows: [{ count: "6", success_count: "4", weighted_avg_outcome: "0.7" }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.recalculateQuality("ins-0001");

      // quality = 0.3*min(1, 10/10) + 0.3*(4/6) + 0.2*0.8 + 0.2*min(1, 5/10)
      //         = 0.3*1 + 0.3*0.667 + 0.2*0.8 + 0.2*0.5
      //         = 0.3 + 0.2 + 0.16 + 0.1 = 0.76
      const updateCall = pool.query.mock.calls[2];
      const qualityScore = updateCall[1][0];
      expect(qualityScore).toBeGreaterThan(0.7);
      expect(qualityScore).toBeLessThan(0.8);
    });

    it("handles zero citations/applications gracefully", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ count: "0", avg_outcome: null, recent_count: "0" }] })
        .mockResolvedValueOnce({ rows: [{ count: "0", success_count: "0", avg_outcome: null }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.recalculateQuality("ins-0001");

      const updateCall = pool.query.mock.calls[2];
      expect(updateCall[1][0]).toBe(0); // quality = 0
    });
  });

  // ─── Learning Feed ───────────────────────────────────────────

  describe("getFeed", () => {
    it("returns top quality insights when no subscriptions", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })  // getSubscriptions
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] }); // top quality query

      const feed = await service.getFeed(AGENT_B);

      expect(feed).toHaveLength(1);
      expect(feed[0].id).toBe(INSIGHT_ROW.id);
    });

    it("filters by subscription tags and type", async () => {
      const { pool, service } = createService();
      const sub = {
        id: "sub-0001", agent_id: AGENT_B, filter_tags: ["caching"],
        filter_strategy_type: "optimization", filter_workspace_id: null,
        min_quality_score: 0.3, created_at: new Date().toISOString(),
      };
      pool.query
        .mockResolvedValueOnce({ rows: [sub] })  // getSubscriptions
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] }); // filtered query

      const feed = await service.getFeed(AGENT_B);

      expect(feed).toHaveLength(1);
    });
  });

  // ─── Subscriptions ───────────────────────────────────────────

  describe("subscriptions", () => {
    it("creates a subscription", async () => {
      const { pool, service } = createService();
      const subRow = {
        id: "sub-0001", agent_id: AGENT_A, filter_tags: ["performance"],
        filter_strategy_type: "optimization", filter_workspace_id: null,
        min_quality_score: 0.5, created_at: new Date().toISOString(),
      };
      pool.query.mockResolvedValueOnce({ rows: [subRow] });

      const result = await service.subscribe(AGENT_A, {
        filterTags: ["performance"],
        filterStrategyType: "optimization",
        minQualityScore: 0.5,
      });

      expect(result.subscription.id).toBe("sub-0001");
    });

    it("deletes a subscription", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.unsubscribe(AGENT_A, "sub-0001");

      expect(result.deleted).toBe(true);
    });

    it("lists agent subscriptions", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ id: "sub-0001" }, { id: "sub-0002" }] });

      const subs = await service.getSubscriptions(AGENT_A);

      expect(subs).toHaveLength(2);
    });
  });

  // ─── Read Methods ────────────────────────────────────────────

  describe("read methods", () => {
    it("getInsight returns insight by ID", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INSIGHT_ROW] });

      const insight = await service.getInsight(INSIGHT_ROW.id);

      expect(insight?.title).toBe(INSIGHT_ROW.title);
    });

    it("getInsight returns null for missing", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const insight = await service.getInsight("nonexistent");

      expect(insight).toBeNull();
    });

    it("listInsights with filters", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [INSIGHT_ROW] });

      const insights = await service.listInsights({
        strategyType: "optimization",
        tags: ["caching"],
        minQuality: 0.3,
        limit: 10,
      });

      expect(insights).toHaveLength(1);
    });

    it("getCitations returns citations for insight", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ id: "cit-0001" }] });

      const cites = await service.getCitations(INSIGHT_ROW.id);

      expect(cites).toHaveLength(1);
    });

    it("getApplications returns applications for insight", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [{ id: "app-0001" }] });

      const apps = await service.getApplications(INSIGHT_ROW.id);

      expect(apps).toHaveLength(1);
    });
  });

  // ─── Meta-Learning ───────────────────────────────────────────

  describe("getNetworkMetaLearning", () => {
    it("returns aggregated network stats", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ total_insights: "42", total_citations: "100", total_applications: "30", avg_quality: "0.45" }] })
        .mockResolvedValueOnce({ rows: [{ strategy_type: "optimization", count: "15", avg_quality: "0.7" }] })
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] }) // fastest propagating
        .mockResolvedValueOnce({ rows: [INSIGHT_ROW] }); // highest outcome

      const meta = await service.getNetworkMetaLearning();

      expect(meta.totalInsights).toBe(42);
      expect(meta.totalCitations).toBe(100);
      expect(meta.totalApplications).toBe(30);
      expect(meta.topStrategies).toHaveLength(1);
      expect(meta.topStrategies[0].strategy_type).toBe("optimization");
      expect(meta.fastestPropagating).toHaveLength(1);
      expect(meta.highestOutcome).toHaveLength(1);
    });
  });
});
