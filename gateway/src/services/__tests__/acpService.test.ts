import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpService } from "../acpService.js";

function createMockPool() {
  return {
    query: vi.fn(),
  } as any;
}

function createMockIntentService() {
  return {
    createIntent: vi.fn().mockResolvedValue({ id: "intent-1", title: "Test", status: "open" }),
    createProposal: vi.fn().mockResolvedValue({ id: "proposal-1", status: "pending" }),
    acceptProposal: vi.fn().mockResolvedValue({
      intent: { id: "intent-1", status: "accepted" },
      proposal: { id: "proposal-1", status: "accepted" },
    }),
    getIntent: vi.fn().mockResolvedValue({ id: "intent-1", title: "Test", status: "open" }),
  } as any;
}

function createMockMarketplaceService() {
  return {
    searchListings: vi.fn().mockResolvedValue([]),
  } as any;
}

describe("AcpService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let intentService: ReturnType<typeof createMockIntentService>;
  let marketplaceService: ReturnType<typeof createMockMarketplaceService>;
  let service: AcpService;

  beforeEach(() => {
    pool = createMockPool();
    intentService = createMockIntentService();
    marketplaceService = createMockMarketplaceService();
    service = new AcpService(pool, intentService, marketplaceService);
  });

  // ============================================================
  //  getServiceDescriptor
  // ============================================================

  describe("getServiceDescriptor", () => {
    it("returns the ACP protocol descriptor", () => {
      const desc = service.getServiceDescriptor("https://gateway.nookplot.com");

      expect(desc.protocol).toBe("acp");
      expect(desc.version).toBe("1.0");
      expect(desc.name).toBe("Nookplot");
      expect(desc.baseUrl).toBe("https://gateway.nookplot.com");
      expect(desc.capabilities).toBe("/v1/acp/capabilities");
      expect(desc.endpoints).toEqual({
        capabilities: "/v1/acp/capabilities",
        request: "/v1/acp/requests",
        negotiate: "/v1/acp/requests/:id/negotiate",
        execute: "/v1/acp/requests/:id/execute",
        evaluate: "/v1/acp/requests/:id/evaluate",
      });
    });
  });

  // ============================================================
  //  getCapabilities
  // ============================================================

  describe("getCapabilities", () => {
    it("merges marketplace listings and agent expertise", async () => {
      marketplaceService.searchListings.mockResolvedValueOnce([
        { id: "7", listing_id: 42, metadata_cid: "QmAuditCid", category: "security", provider_address: "0xAAA", price_amount: "500" },
      ]);
      pool.query.mockResolvedValueOnce({
        rows: [{ address: "0xBBB", display_name: "alice", expertise: ["rust", "solidity"] }],
      });

      const caps = await service.getCapabilities();

      expect(caps).toHaveLength(3);
      expect(caps[0]).toEqual({
        id: "listing-7",
        name: "listing-42",
        description: "QmAuditCid",
        category: "security",
        provider: "0xAAA",
        pricing: { amount: 5, currency: "credits" },
      });
      expect(caps[1].id).toBe("agent-skill-0xBBB-rust");
      expect(caps[2].id).toBe("agent-skill-0xBBB-solidity");
      expect(caps[2].description).toBe("alice specializes in solidity");
    });

    it("works without marketplace service", async () => {
      const svcNoMkt = new AcpService(pool, intentService, null);
      pool.query.mockResolvedValueOnce({
        rows: [{ address: "0xCCC", display_name: null, expertise: ["python"] }],
      });

      const caps = await svcNoMkt.getCapabilities();

      expect(caps).toHaveLength(1);
      expect(caps[0].description).toBe("0xCCC specializes in python");
    });

    it("filters by category and respects limit", async () => {
      marketplaceService.searchListings.mockResolvedValueOnce([]);
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getCapabilities("security", 10);

      expect(marketplaceService.searchListings).toHaveBeenCalledWith({
        category: "security",
        activeOnly: true,
        limit: 10,
      });
    });

    it("gracefully handles marketplace errors", async () => {
      marketplaceService.searchListings.mockRejectedValueOnce(new Error("db down"));
      pool.query.mockResolvedValueOnce({ rows: [] });

      const caps = await service.getCapabilities();

      expect(caps).toEqual([]);
    });
  });

  // ============================================================
  //  createRequest
  // ============================================================

  describe("createRequest", () => {
    it("delegates to intentService.createIntent with correct arguments", async () => {
      const result = await service.createRequest("agent-1", "0xAAA", {
        title: "Build API",
        description: "Build a REST API",
        category: "development",
        budget: 100,
        skills: ["typescript"],
      });

      expect(intentService.createIntent).toHaveBeenCalledWith({
        creatorId: "agent-1",
        creatorAddress: "0xAAA",
        title: "Build API",
        description: "Build a REST API",
        category: "development",
        budgetAmount: 100,
        requiredSkills: ["typescript"],
        metadata: { source: "acp" },
      });
      expect(result).toEqual({ id: "intent-1", title: "Test", status: "open" });
    });
  });

  // ============================================================
  //  negotiate
  // ============================================================

  describe("negotiate", () => {
    it("delegates to intentService.createProposal with correct arguments", async () => {
      const result = await service.negotiate("intent-1", "agent-2", "0xBBB", {
        description: "I can build it",
        approach: "Express + Postgres",
        estimatedCost: 50,
        estimatedDuration: 8,
      });

      expect(intentService.createProposal).toHaveBeenCalledWith({
        intentId: "intent-1",
        proposerId: "agent-2",
        proposerAddress: "0xBBB",
        description: "I can build it",
        approach: "Express + Postgres",
        estimatedCost: 50,
        estimatedDurationHours: 8,
        metadata: { source: "acp" },
      });
      expect(result).toEqual({ id: "proposal-1", status: "pending" });
    });
  });

  // ============================================================
  //  execute
  // ============================================================

  describe("execute", () => {
    it("delegates to intentService.acceptProposal", async () => {
      const result = await service.execute("intent-1", "agent-1", "proposal-1");

      expect(intentService.acceptProposal).toHaveBeenCalledWith("intent-1", "proposal-1", "agent-1");
      expect(result.intent.status).toBe("accepted");
      expect(result.proposal.status).toBe("accepted");
    });
  });

  // ============================================================
  //  evaluate
  // ============================================================

  describe("evaluate", () => {
    it("stores evaluation as intent metadata", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.evaluate("intent-1", "agent-1", { rating: 4, comment: "Great work" });

      expect(result).toEqual({ success: true });
      expect(intentService.getIntent).toHaveBeenCalledWith("intent-1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE intents SET metadata"),
        expect.arrayContaining(["intent-1"]),
      );
      // Verify the stored JSON includes clamped rating
      const storedJson = JSON.parse(pool.query.mock.calls[0][1][0]);
      expect(storedJson.rating).toBe(4);
      expect(storedJson.comment).toBe("Great work");
      expect(storedJson.reviewerId).toBe("agent-1");
    });

    it("clamps rating to 1-5 range", async () => {
      pool.query.mockResolvedValueOnce({ rowCount: 1 });

      await service.evaluate("intent-1", "agent-1", { rating: 99 });

      const storedJson = JSON.parse(pool.query.mock.calls[0][1][0]);
      expect(storedJson.rating).toBe(5);
      expect(storedJson.comment).toBeNull();
    });

    it("throws when intent not found", async () => {
      intentService.getIntent.mockResolvedValueOnce(null);

      await expect(service.evaluate("missing-id", "agent-1", { rating: 3 }))
        .rejects.toThrow("Intent not found");
    });
  });
});
