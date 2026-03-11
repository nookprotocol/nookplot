import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillRegistryService } from "../skillRegistryService.js";

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

function createMockProactiveScheduler() {
  return { handleReactiveSignal: vi.fn().mockResolvedValue(undefined) };
}

function createMockInboxService() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

function createMockSpecializationService() {
  return { recordSignal: vi.fn().mockResolvedValue(undefined) };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_A = "a-0001";
const AGENT_B = "a-0002";
const ADDRESS_A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const ADDRESS_B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";

const DEFAULT_CONFIG = {
  publishCost: 200,
  updateCost: 50,
  reviewCost: 25,
  githubImportCost: 100,
  bundleExtractCost: 150,
};

const SKILL_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  publisher_id: AGENT_A,
  publisher_address: ADDRESS_A,
  name: "Test Skill",
  slug: "test-skill",
  description: "A test skill for unit testing purposes.",
  package_type: "skill_md",
  github_url: null,
  github_path: null,
  npm_package: null,
  install_command: null,
  version: "1.0.0",
  tags: ["test", "unit"],
  category: "tools",
  content: "# Test Skill\n\nThis is test content.",
  source_bundle_id: null,
  status: "active",
  install_count: 5,
  rating_count: 3,
  rating_avg: 4.33,
  metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const REVIEW_ROW = {
  id: "00000000-0000-0000-0000-000000000010",
  skill_id: SKILL_ROW.id,
  reviewer_id: AGENT_B,
  rating: 4,
  review: "Great skill!",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function createService() {
  const pool = createMockPool();
  const creditManager = createMockCreditManager();
  const messageBus = createMockMessageBus();
  const contentScanner = createMockContentScanner();
  const service = new SkillRegistryService(pool, DEFAULT_CONFIG);
  service.setCreditManager(creditManager);
  service.setMessageBus(messageBus);
  service.setContentScanner(contentScanner);
  return { pool, creditManager, messageBus, contentScanner, service };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SkillRegistryService", () => {

  // ─── Publish ─────────────────────────────────────────────────

  describe("publishSkill", () => {
    it("deducts credits, inserts, and publishes event", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })      // slug collision check
        .mockResolvedValueOnce({ rows: [SKILL_ROW] }); // INSERT

      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
        category: "tools",
        tags: ["test", "unit"],
        content: "# Test Skill\n\nThis is test content.",
      });

      expect("skill" in result).toBe(true);
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_A, 200, expect.any(String), "skill_publish",
      );
      expect(messageBus.publish).toHaveBeenCalledWith("skill-registry", expect.objectContaining({
        type: "skill.published",
      }));
    });

    it("rejects empty name", async () => {
      const { service } = createService();
      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "",
        description: "A test skill for unit testing purposes.",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects name too short", async () => {
      const { service } = createService();
      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "X",
        description: "A test skill for unit testing purposes.",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects description too short", async () => {
      const { service } = createService();
      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "Short",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects invalid package type", async () => {
      const { service } = createService();
      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
        packageType: "invalid_type",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects invalid category", async () => {
      const { service } = createService();
      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
        category: "nonexistent_category",
      });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("caps tags at 10", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })      // slug check
        .mockResolvedValueOnce({ rows: [SKILL_ROW] }); // INSERT

      const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
      await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
        tags,
      });

      // The INSERT call is the second query — check tags param (index 11 in params array)
      const insertCall = pool.query.mock.calls[1];
      expect(insertCall[1][11].length).toBe(10);
    });

    it("returns error on insufficient credits", async () => {
      const { creditManager, service } = createService();
      creditManager.deductCredits.mockRejectedValueOnce(new Error("INSUFFICIENT_CREDITS"));

      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("blocks content flagged by scanner", async () => {
      const { contentScanner, service } = createService();
      contentScanner.scanContent.mockResolvedValueOnce({ blocked: true });

      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
      });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("CONTENT_SAFETY_BLOCK");
    });

    it("handles slug collision", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [{ slug: "test-skill" }] }) // slug collision found
        .mockResolvedValueOnce({ rows: [{ ...SKILL_ROW, slug: "test-skill-2" }] }); // INSERT

      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Test Skill",
        description: "A test skill for unit testing purposes.",
      });

      expect("skill" in result).toBe(true);
    });
  });

  // ─── List ────────────────────────────────────────────────────

  describe("listSkills", () => {
    it("returns skills with total count", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [SKILL_ROW] })           // SELECT
        .mockResolvedValueOnce({ rows: [{ count: "1" }] });     // COUNT

      const result = await service.listSkills();

      expect(result.skills).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("passes FTS query", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.listSkills({ q: "caching optimization" });

      // First query should include plainto_tsquery
      const firstCall = pool.query.mock.calls[0][0];
      expect(firstCall).toContain("plainto_tsquery");
    });

    it("filters by category", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.listSkills({ category: "tools" });

      const firstCall = pool.query.mock.calls[0];
      expect(firstCall[1]).toContain("tools");
    });

    it("filters by tags", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.listSkills({ tags: ["ai", "ml"] });

      const firstCall = pool.query.mock.calls[0];
      expect(firstCall[0]).toContain("tags &&");
    });

    it("filters by package type", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.listSkills({ packageType: "mcp_server" });

      const firstCall = pool.query.mock.calls[0];
      expect(firstCall[1]).toContain("mcp_server");
    });

    it("respects limit cap at 200", async () => {
      const { pool, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] });

      await service.listSkills({ limit: 500 });

      const firstCall = pool.query.mock.calls[0];
      expect(firstCall[1]).toContain(200);
    });
  });

  // ─── Get ─────────────────────────────────────────────────────

  describe("getSkill", () => {
    it("returns skill by UUID", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const skill = await service.getSkill(SKILL_ROW.id);
      expect(skill).toEqual(SKILL_ROW);
    });

    it("returns null for missing UUID", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const skill = await service.getSkill("nonexistent");
      expect(skill).toBeNull();
    });
  });

  describe("getSkillBySlug", () => {
    it("returns skill by slug", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const skill = await service.getSkillBySlug("test-skill");
      expect(skill).toEqual(SKILL_ROW);
    });

    it("returns null for missing slug", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const skill = await service.getSkillBySlug("nonexistent");
      expect(skill).toBeNull();
    });
  });

  // ─── Update ──────────────────────────────────────────────────

  describe("updateSkill", () => {
    it("updates owned skill and deducts credits", async () => {
      const { pool, creditManager, service } = createService();
      const updated = { ...SKILL_ROW, name: "Updated Skill" };
      pool.query
        .mockResolvedValueOnce({ rows: [SKILL_ROW] })  // getSkill (ownership check)
        .mockResolvedValueOnce({ rows: [updated] });    // UPDATE

      const result = await service.updateSkill(AGENT_A, SKILL_ROW.id, { name: "Updated Skill" });

      expect("skill" in result).toBe(true);
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_A, 50, expect.any(String), "skill_update",
      );
    });

    it("rejects non-owner", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.updateSkill(AGENT_B, SKILL_ROW.id, { name: "Hijacked" });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("FORBIDDEN");
    });

    it("returns NOT_FOUND for missing skill", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.updateSkill(AGENT_A, "missing-id", { name: "x" });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });

    it("rejects invalid name length", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.updateSkill(AGENT_A, SKILL_ROW.id, { name: "X" });

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });
  });

  // ─── Unlist ──────────────────────────────────────────────────

  describe("unlistSkill", () => {
    it("sets status to unlisted", async () => {
      const { pool, messageBus, service } = createService();
      const unlisted = { ...SKILL_ROW, status: "unlisted" };
      pool.query
        .mockResolvedValueOnce({ rows: [SKILL_ROW] })
        .mockResolvedValueOnce({ rows: [unlisted] });

      const result = await service.unlistSkill(AGENT_A, SKILL_ROW.id);

      expect("skill" in result).toBe(true);
      if ("skill" in result) expect(result.skill.status).toBe("unlisted");
      expect(messageBus.publish).toHaveBeenCalledWith("skill-registry", expect.objectContaining({
        type: "skill.unlisted",
      }));
    });

    it("rejects non-owner", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.unlistSkill(AGENT_B, SKILL_ROW.id);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("FORBIDDEN");
    });
  });

  // ─── Review ──────────────────────────────────────────────────

  describe("reviewSkill", () => {
    it("upserts review, deducts credits, recalculates avg", async () => {
      const { pool, creditManager, messageBus, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [SKILL_ROW] })    // getSkill
        .mockResolvedValueOnce({ rows: [REVIEW_ROW] })    // UPSERT review
        .mockResolvedValueOnce({ rows: [] });              // UPDATE rating_avg

      const result = await service.reviewSkill(AGENT_B, SKILL_ROW.id, 4, "Great skill!");

      expect("review" in result).toBe(true);
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_B, 25, expect.any(String), "skill_review",
      );
      expect(messageBus.publish).toHaveBeenCalledWith("skill-registry", expect.objectContaining({
        type: "skill.reviewed",
      }));
    });

    it("blocks self-review", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] }); // getSkill (publisher is AGENT_A)

      const result = await service.reviewSkill(AGENT_A, SKILL_ROW.id, 5);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("SELF_REVIEW");
    });

    it("rejects rating out of range (0)", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.reviewSkill(AGENT_B, SKILL_ROW.id, 0);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects rating out of range (6)", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.reviewSkill(AGENT_B, SKILL_ROW.id, 6);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("rejects non-integer rating", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.reviewSkill(AGENT_B, SKILL_ROW.id, 3.5);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("returns NOT_FOUND for missing skill", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.reviewSkill(AGENT_B, "missing", 5);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });
  });

  // ─── Install ─────────────────────────────────────────────────

  describe("recordInstall", () => {
    it("increments count on first install", async () => {
      const { pool, messageBus, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [SKILL_ROW] })          // getSkill
        .mockResolvedValueOnce({ rowCount: 1 })                 // INSERT install
        .mockResolvedValueOnce({ rows: [] })                    // UPDATE count
        .mockResolvedValueOnce({ rows: [{ ...SKILL_ROW, install_count: 6 }] }); // refresh getSkill

      const result = await service.recordInstall(AGENT_B, SKILL_ROW.id);

      expect("skill" in result).toBe(true);
      if ("skill" in result) {
        expect(result.installed).toBe(true);
      }
      expect(messageBus.publish).toHaveBeenCalledWith("skill-registry", expect.objectContaining({
        type: "skill.installed",
      }));
    });

    it("is idempotent on duplicate install", async () => {
      const { pool, messageBus, service } = createService();
      pool.query
        .mockResolvedValueOnce({ rows: [SKILL_ROW] })  // getSkill
        .mockResolvedValueOnce({ rowCount: 0 })         // INSERT (conflict, no insert)
        .mockResolvedValueOnce({ rows: [SKILL_ROW] });  // refresh getSkill

      const result = await service.recordInstall(AGENT_B, SKILL_ROW.id);

      expect("skill" in result).toBe(true);
      if ("skill" in result) {
        expect(result.installed).toBe(false);
        expect(result.skill.install_count).toBe(5); // unchanged
      }
      // No event published for duplicate
      expect(messageBus.publish).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND for missing skill", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.recordInstall(AGENT_B, "missing");

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });
  });

  // ─── Get Reviews ─────────────────────────────────────────────

  describe("getReviews", () => {
    it("returns reviews with reviewer names and total", async () => {
      const { pool, service } = createService();
      const reviewWithName = { ...REVIEW_ROW, reviewer_name: "Agent B" };
      pool.query
        .mockResolvedValueOnce({ rows: [reviewWithName] })
        .mockResolvedValueOnce({ rows: [{ count: "1" }] });

      const result = await service.getReviews(SKILL_ROW.id);

      expect(result.reviews).toHaveLength(1);
      expect(result.reviews[0].reviewer_name).toBe("Agent B");
      expect(result.total).toBe(1);
    });
  });

  // ─── Trending ────────────────────────────────────────────────

  describe("getTrending", () => {
    it("returns trending skills weighted by recency", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.getTrending(10, 7);

      expect(result).toHaveLength(1);
      const query = pool.query.mock.calls[0][0];
      expect(query).toContain("weighted_installs");
    });

    it("caps limit at 100", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.getTrending(500);

      const params = pool.query.mock.calls[0][1];
      expect(params[1]).toBe(100);
    });
  });

  // ─── Import from GitHub ──────────────────────────────────────

  describe("importFromGitHub", () => {
    it("rejects invalid GitHub URL", async () => {
      const { service } = createService();

      const result = await service.importFromGitHub(AGENT_A, ADDRESS_A, "https://example.com/not-github");

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("INVALID_INPUT");
    });

    it("deducts github import credits", async () => {
      const { pool, creditManager, service } = createService();
      // Mock fetch globally
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("# My Skill\n\nThis is a skill description that is long enough."),
      });

      pool.query
        .mockResolvedValueOnce({ rows: [] })       // slug check
        .mockResolvedValueOnce({ rows: [SKILL_ROW] }); // INSERT

      try {
        await service.importFromGitHub(AGENT_A, ADDRESS_A, "https://github.com/owner/repo");

        expect(creditManager.deductCredits).toHaveBeenCalledWith(
          AGENT_A, 100, expect.any(String), "skill_github_import",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ─── Extract from Bundle ─────────────────────────────────────

  describe("extractFromBundle", () => {
    it("returns NOT_FOUND when bundle missing", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] }); // idx_knowledge_bundles

      const result = await service.extractFromBundle(AGENT_A, ADDRESS_A, "999");

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });

    it("deducts bundle extract credits and publishes skill", async () => {
      const { pool, creditManager, service } = createService();
      const bundleRow = {
        bundle_id: "42",
        name: "ML Patterns",
        summary: "Machine learning design patterns for production systems.",
        tags: ["ml", "patterns"],
        domain: "ai",
        bundle_type: "curated",
        content_cid: "bafybeig...",
      };

      pool.query
        .mockResolvedValueOnce({ rows: [bundleRow] })     // idx_knowledge_bundles
        .mockResolvedValueOnce({ rows: [] })               // idx_bundle_contributors
        .mockResolvedValueOnce({ rows: [] })               // slug check (from publishSkill)
        .mockResolvedValueOnce({ rows: [{ ...SKILL_ROW, source_bundle_id: 42 }] }) // INSERT (from publishSkill)
        .mockResolvedValueOnce({ rows: [] });              // UPDATE source_bundle_id

      const result = await service.extractFromBundle(AGENT_A, ADDRESS_A, "42");

      expect("skill" in result).toBe(true);
      // Two credit deductions: bundle extract (150) then publish (200)
      expect(creditManager.deductCredits).toHaveBeenCalledWith(
        AGENT_A, 150, expect.any(String), "skill_bundle_extract",
      );
    });
  });

  // ─── Convert to Bundle ───────────────────────────────────────

  describe("convertToBundle", () => {
    it("returns bundle data for owned skill", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.convertToBundle(AGENT_A, SKILL_ROW.id);

      expect("bundleData" in result).toBe(true);
      if ("bundleData" in result) {
        expect(result.bundleData.name).toBe(SKILL_ROW.name);
        expect(result.bundleData.suggestedTags).toEqual(SKILL_ROW.tags);
      }
    });

    it("rejects non-owner", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [SKILL_ROW] });

      const result = await service.convertToBundle(AGENT_B, SKILL_ROW.id);

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("FORBIDDEN");
    });

    it("returns NOT_FOUND for missing skill", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.convertToBundle(AGENT_A, "missing");

      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.code).toBe("NOT_FOUND");
    });
  });

  // ─── Skill-Gap Bridge ──────────────────────────────────────

  describe("notifyAgentsOfNewSkill (skill-gap bridge)", () => {
    it("notifies agents with matching recommendations on publish", async () => {
      const { pool, service } = createService();
      const proactive = createMockProactiveScheduler();
      const inbox = createMockInboxService();
      const specialization = createMockSpecializationService();
      service.setProactiveScheduler(proactive);
      service.setInboxService(inbox);
      service.setSpecializationService(specialization);

      const skillWithTags = { ...SKILL_ROW, tags: ["rust", "async"] };
      pool.query
        .mockResolvedValueOnce({ rows: [] })          // slug collision check
        .mockResolvedValueOnce({ rows: [skillWithTags] }) // INSERT
        // notifyAgentsOfNewSkill queries:
        .mockResolvedValueOnce({ rows: [             // recommendation matches
          { agent_id: AGENT_B, skill_domain: "rust", gap_opportunity: 45 },
        ] })
        .mockResolvedValueOnce({ rows: [] });         // gap_opportunity matches (none extra)

      const result = await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Rust Async Guide",
        description: "A comprehensive guide to async programming in Rust.",
        tags: ["rust", "async"],
      });

      expect("skill" in result).toBe(true);

      // Wait for fire-and-forget to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(proactive.handleReactiveSignal).toHaveBeenCalledWith(
        AGENT_B,
        expect.objectContaining({
          signalType: "skill_published_match",
          metadata: expect.objectContaining({ matchedDomain: "rust" }),
        }),
      );
      expect(inbox.send).toHaveBeenCalledWith(
        expect.objectContaining({
          toAgentId: AGENT_B,
          messageType: "skill_recommendation",
        }),
      );
    });

    it("records supply signals for published skill tags", async () => {
      const { pool, service } = createService();
      const specialization = createMockSpecializationService();
      service.setSpecializationService(specialization);
      service.setProactiveScheduler(createMockProactiveScheduler());

      const skillWithTags = { ...SKILL_ROW, tags: ["typescript", "caching"] };
      pool.query
        .mockResolvedValueOnce({ rows: [] })              // slug check
        .mockResolvedValueOnce({ rows: [skillWithTags] }) // INSERT
        .mockResolvedValueOnce({ rows: [                  // recommendation matches
          { agent_id: AGENT_B, skill_domain: "typescript", gap_opportunity: 20 },
        ] })
        .mockResolvedValueOnce({ rows: [] });             // gap matches

      await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "TS Caching",
        description: "TypeScript caching patterns for production applications.",
        tags: ["typescript", "caching"],
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Supply signals use the returned skill row data (SKILL_ROW)
      expect(specialization.recordSignal).toHaveBeenCalledWith(
        "typescript", "supply", 1.0, "skill_registry",
        SKILL_ROW.id, expect.objectContaining({ slug: SKILL_ROW.slug }),
      );
      expect(specialization.recordSignal).toHaveBeenCalledWith(
        "caching", "supply", 1.0, "skill_registry",
        SKILL_ROW.id, expect.objectContaining({ slug: SKILL_ROW.slug }),
      );
    });

    it("skips notification when no tags on skill", async () => {
      const { pool, service } = createService();
      const proactive = createMockProactiveScheduler();
      service.setProactiveScheduler(proactive);

      const skillNoTags = { ...SKILL_ROW, tags: [] };
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [skillNoTags] });

      await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "No Tags Skill",
        description: "A skill with no tags at all for testing.",
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // No notification queries should have been made beyond publish
      expect(proactive.handleReactiveSignal).not.toHaveBeenCalled();
    });

    it("excludes publisher from notifications", async () => {
      const { pool, service } = createService();
      const proactive = createMockProactiveScheduler();
      service.setProactiveScheduler(proactive);
      service.setInboxService(createMockInboxService());

      const skillWithTags = { ...SKILL_ROW, tags: ["solidity"] };
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [skillWithTags] })
        .mockResolvedValueOnce({ rows: [] })  // no recommendation matches (publisher excluded)
        .mockResolvedValueOnce({ rows: [] }); // no gap matches

      await service.publishSkill(AGENT_A, ADDRESS_A, {
        name: "Solidity Skill",
        description: "A Solidity smart contract development guide.",
        tags: ["solidity"],
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(proactive.handleReactiveSignal).not.toHaveBeenCalled();
    });
  });
});
