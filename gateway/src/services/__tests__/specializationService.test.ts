import { describe, it, expect, vi } from "vitest";
import { SpecializationService } from "../specializationService.js";

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockMessageBus() {
  return { publish: vi.fn() };
}

const AGENT_A = "a-001";
const GAP_ID = "gap-001";

function createService() {
  const pool = createMockPool();
  const messageBus = createMockMessageBus();
  const service = new SpecializationService(pool);
  service.setMessageBus(messageBus);
  return { pool, messageBus, service };
}

describe("SpecializationService", () => {
  describe("recordGap", () => {
    it("inserts or increments skill gap", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: GAP_ID }] });

      await service.recordGap("How to deploy Solidity contracts?", ["solidity", "deployment"]);
      // Should call query multiple times (upsert + signal recording)
      expect(pool.query).toHaveBeenCalled();
    });

    it("skips empty query", async () => {
      const { pool, service } = createService();
      await service.recordGap("", []);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe("resolveGap", () => {
    it("marks gap as resolved", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: GAP_ID, resolved: true }] });

      const result = await service.resolveGap(AGENT_A, GAP_ID);
      expect(result.resolved).toBe(true);
    });

    it("rejects already resolved gap", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.resolveGap(AGENT_A, "bad-id")).rejects.toThrow("not found");
    });
  });

  describe("listGaps", () => {
    it("returns open gaps sorted by count", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 2,
        rows: [
          { id: "g1", query_text: "Rust async", gap_count: 10 },
          { id: "g2", query_text: "ML ops", gap_count: 5 },
        ],
      });

      const result = await service.listGaps({ limit: 10 });
      expect(result).toHaveLength(2);
    });

    it("filters by tag", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: "g1" }] });

      await service.listGaps({ tag: "rust" });
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("ANY(query_tags)"), expect.any(Array));
    });
  });

  describe("recordSignal", () => {
    it("inserts demand signal", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [] });

      await service.recordSignal("typescript", "demand", 5.0, "bounty", "b-1");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO specialization_signals"),
        expect.arrayContaining(["typescript", "demand"]),
      );
    });

    it("ignores invalid signal type", async () => {
      const { pool, service } = createService();
      await service.recordSignal("ts", "invalid_type", 1.0);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe("getSignals", () => {
    it("returns aggregated signals", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 2,
        rows: [
          { skill_domain: "rust", signal_type: "demand", signal_count: 15, avg_intensity: 3.5 },
          { skill_domain: "solidity", signal_type: "demand", signal_count: 10, avg_intensity: 5.0 },
        ],
      });

      const result = await service.getSignals({ days: 7 });
      expect(result).toHaveLength(2);
    });
  });

  describe("updateProficiency", () => {
    it("upserts proficiency", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ agent_id: AGENT_A, skill_domain: "typescript", proficiency: 75 }],
      });

      const result = await service.updateProficiency(AGENT_A, "TypeScript", 75);
      expect(result.proficiency).toBe(75);
    });

    it("rejects out of range", async () => {
      const { service } = createService();
      await expect(service.updateProficiency(AGENT_A, "ts", 150)).rejects.toThrow("0-100");
    });
  });

  describe("getProfile", () => {
    it("returns agent specializations", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 2,
        rows: [
          { skill_domain: "typescript", proficiency: 80, gap_opportunity: 20 },
          { skill_domain: "rust", proficiency: 30, gap_opportunity: 50 },
        ],
      });

      const result = await service.getProfile(AGENT_A);
      expect(result).toHaveLength(2);
    });
  });

  describe("generateRecommendations", () => {
    it("generates recommendations from demand/supply gap", async () => {
      const { pool, messageBus, service } = createService();
      let queryCount = 0;
      pool.query.mockImplementation((sql: string) => {
        // Agent profile
        if (sql.includes("agent_specializations") && sql.includes("WHERE agent_id")) {
          return { rowCount: 1, rows: [{ skill_domain: "typescript", proficiency: 60 }] };
        }
        // Demand
        if (sql.includes("signal_type = 'demand'") && sql.includes("GROUP BY")) {
          return {
            rowCount: 2,
            rows: [
              { skill_domain: "rust", demand: 20, avg_intensity: 5.0 },
              { skill_domain: "typescript", demand: 10, avg_intensity: 3.0 },
            ],
          };
        }
        // Supply
        if (sql.includes("proficiency >= 30") && sql.includes("GROUP BY")) {
          return {
            rowCount: 1,
            rows: [{ skill_domain: "typescript", supply: 5, avg_proficiency: 60 }],
          };
        }
        // Insert recommendation + update specialization
        return { rowCount: 1, rows: [] };
      });

      const result = await service.generateRecommendations(AGENT_A);
      expect(result.length).toBeGreaterThan(0);
      expect(messageBus.publish).toHaveBeenCalled();
    });
  });

  describe("getRecommendations", () => {
    it("returns active recommendations", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ id: "r-1", skill_domain: "rust", gap_opportunity: 50 }],
      });

      const result = await service.getRecommendations(AGENT_A, "active");
      expect(result).toHaveLength(1);
    });
  });

  describe("dismissRecommendation", () => {
    it("dismisses recommendation", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 1, rows: [] });
      await service.dismissRecommendation(AGENT_A, "r-1");
    });

    it("rejects not found", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      await expect(service.dismissRecommendation(AGENT_A, "bad")).rejects.toThrow("not found");
    });
  });

  describe("getSkillLandscape", () => {
    it("returns demand/supply/gaps overview", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{ skill_domain: "rust", demand_count: 10 }],
      });

      const result = await service.getSkillLandscape(7);
      expect(result.windowDays).toBe(7);
      expect(result.demand).toBeDefined();
      expect(result.supply).toBeDefined();
      expect(result.gaps).toBeDefined();
    });
  });

  // ─── Skill-Gap Bridge ──────────────────────────────────────

  describe("findMatchingSkills", () => {
    it("returns skills matching given tags", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({
        rowCount: 2,
        rows: [
          { id: "s-1", name: "Rust Guide", slug: "rust-guide", tags: ["rust"], rating_avg: 4.5, install_count: 20 },
          { id: "s-2", name: "Async Patterns", slug: "async-patterns", tags: ["async"], rating_avg: 4.0, install_count: 10 },
        ],
      });

      const result = await service.findMatchingSkills(["rust", "async"]);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Rust Guide");
    });

    it("returns empty array for empty tags", async () => {
      const { pool, service } = createService();
      const result = await service.findMatchingSkills([]);
      expect(result).toEqual([]);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("lowercases tags before querying", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

      await service.findMatchingSkills(["TypeScript", "REACT"]);
      expect(pool.query).toHaveBeenCalledWith(
        expect.any(String),
        [["typescript", "react"], 5],
      );
    });

    it("respects limit parameter", async () => {
      const { pool, service } = createService();
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

      await service.findMatchingSkills(["rust"], 3);
      expect(pool.query).toHaveBeenCalledWith(
        expect.any(String),
        [["rust"], 3],
      );
    });

    it("gracefully handles missing table", async () => {
      const { pool, service } = createService();
      pool.query.mockRejectedValue(new Error("relation \"skill_packages\" does not exist"));

      const result = await service.findMatchingSkills(["rust"]);
      expect(result).toEqual([]);
    });
  });

  describe("recordGap with matching skills", () => {
    it("returns matching skills when registry has relevant packages", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        // Gap upsert / insert / signal recording
        if (sql.includes("skill_gaps") || sql.includes("specialization_signals")) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: "gap-1" }] });
        }
        // findMatchingSkills query
        if (sql.includes("skill_packages")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ id: "s-1", name: "Solidity Guide", slug: "solidity-guide", tags: ["solidity"], rating_avg: 4.8, install_count: 50 }],
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      });

      const result = await service.recordGap("How to write Solidity contracts?", ["solidity", "smart-contracts"]);
      expect(result.matchingSkills).toBeDefined();
      expect(result.matchingSkills).toHaveLength(1);
      expect(result.matchingSkills![0].name).toBe("Solidity Guide");
    });

    it("returns empty when no matching skills exist", async () => {
      const { pool, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("skill_packages")) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        return Promise.resolve({ rowCount: 1, rows: [{ id: "gap-1" }] });
      });

      const result = await service.recordGap("Obscure niche topic", ["obscure"]);
      expect(result.matchingSkills).toBeUndefined();
    });
  });

  describe("generateRecommendations with suggested_skills", () => {
    it("enriches recommendations with matching skill packages", async () => {
      const { pool, messageBus, service } = createService();
      pool.query.mockImplementation((sql: string) => {
        // Agent profile
        if (sql.includes("agent_specializations") && sql.includes("WHERE agent_id")) {
          return { rowCount: 1, rows: [{ skill_domain: "typescript", proficiency: 60 }] };
        }
        // Demand
        if (sql.includes("signal_type = 'demand'") && sql.includes("GROUP BY")) {
          return {
            rowCount: 1,
            rows: [{ skill_domain: "rust", demand: 20, avg_intensity: 5.0 }],
          };
        }
        // Supply
        if (sql.includes("proficiency >= 30") && sql.includes("GROUP BY")) {
          return { rowCount: 0, rows: [] };
        }
        // findMatchingSkills (for recommendation enrichment)
        if (sql.includes("skill_packages")) {
          return {
            rowCount: 1,
            rows: [{ id: "s-1", name: "Rust Mastery", slug: "rust-mastery", rating_avg: 4.7, install_count: 30, package_type: "skill_md" }],
          };
        }
        // Insert recommendation + update specialization
        return { rowCount: 1, rows: [] };
      });

      const result = await service.generateRecommendations(AGENT_A);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].suggested_skills).toBeDefined();
      expect(result[0].suggested_skills[0].name).toBe("Rust Mastery");
      expect(result[0].suggested_skills[0].slug).toBe("rust-mastery");
    });
  });
});
