import { describe, it, expect, vi } from "vitest";
import { ExpertiseProfiler } from "./expertiseProfiler.js";
import { createMockPool } from "../test/helpers.js";

// ---------------------------------------------------------------------------
//  profileAgent
// ---------------------------------------------------------------------------

describe("ExpertiseProfiler — profileAgent", () => {
  it("derives language tags with normalized confidence", async () => {
    const pool = createMockPool();
    const upserted: string[] = [];

    pool.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes("SELECT capabilities FROM agents")) {
        return Promise.resolve({ rows: [{ capabilities: null }] });
      }
      if (sql.includes("unnest(languages)")) {
        return Promise.resolve({
          rows: [
            { lang: "TypeScript", freq: "100" },
            { lang: "Python", freq: "50" },
            { lang: "Rust", freq: "10" },
          ],
        });
      }
      if (sql.includes("unnest(frameworks)")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xTest" }] });
      }
      if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
          sql.includes("service_agreements") || sql.includes("service_listings") ||
          sql.includes("external_claims")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO expertise_tags")) {
        upserted.push(params?.[1]);
        return Promise.resolve({ rowCount: 1 });
      }
      if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAgent("agt_1");

    // TypeScript (1.0) and Python (0.5) pass threshold; Rust (0.1) filtered out
    expect(count).toBe(2);
    expect(upserted).toContain("TypeScript");
    expect(upserted).toContain("Python");
    expect(upserted).not.toContain("Rust");
  });

  it("returns 0 when no commits and no capabilities", async () => {
    const pool = createMockPool();

    pool.query.mockImplementation((sql: string) => {
      if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
        return Promise.resolve({ rows: [{ capabilities: null }] });
      }
      if (sql.includes("unnest(languages)")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xTest" }] });
      }
      if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
          sql.includes("service_agreements") || sql.includes("service_listings") ||
          sql.includes("external_claims")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAgent("agt_1");

    expect(count).toBe(0);
  });

  it("infers framework tags from heuristics", async () => {
    const pool = createMockPool();
    const upserted: string[] = [];

    pool.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
        return Promise.resolve({ rows: [{ capabilities: null }] });
      }
      if (sql.includes("unnest(languages)")) {
        return Promise.resolve({
          rows: [{ lang: "TypeScript", freq: "50" }],
        });
      }
      if (sql.includes("unnest(frameworks)")) {
        return Promise.resolve({
          rows: [{ fw: ".tsx", freq: "30" }],
        });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xTest" }] });
      }
      if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
          sql.includes("service_agreements") || sql.includes("service_listings") ||
          sql.includes("external_claims")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO expertise_tags")) {
        upserted.push(params?.[1]);
        return Promise.resolve({ rowCount: 1 });
      }
      if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAgent("agt_1");

    expect(count).toBe(2); // TypeScript + React
    expect(upserted).toContain("React");
  });

  it("caps at 30 tags", async () => {
    const pool = createMockPool();
    const upserted: string[] = [];

    // 35 languages — only top 30 by confidence should be kept
    const langs = Array.from({ length: 35 }, (_, i) => ({
      lang: `Lang${i}`,
      freq: String(100 - i * 2),
    }));

    pool.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
        return Promise.resolve({ rows: [{ capabilities: null }] });
      }
      if (sql.includes("unnest(languages)")) {
        return Promise.resolve({ rows: langs });
      }
      if (sql.includes("unnest(frameworks)")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xTest" }] });
      }
      if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
          sql.includes("service_agreements") || sql.includes("service_listings") ||
          sql.includes("external_claims")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO expertise_tags")) {
        upserted.push(params?.[1]);
        return Promise.resolve({ rowCount: 1 });
      }
      if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAgent("agt_1");

    expect(count).toBeLessThanOrEqual(30);
  });

  it("handles single tag above threshold", async () => {
    const pool = createMockPool();

    pool.query.mockImplementation((sql: string) => {
      if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
        return Promise.resolve({ rows: [{ capabilities: null }] });
      }
      if (sql.includes("unnest(languages)")) {
        return Promise.resolve({ rows: [{ lang: "Obscure", freq: "1" }] });
      }
      if (sql.includes("unnest(frameworks)")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xTest" }] });
      }
      if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
          sql.includes("service_agreements") || sql.includes("service_listings") ||
          sql.includes("external_claims")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO expertise_tags")) {
        return Promise.resolve({ rowCount: 1 });
      }
      if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAgent("agt_1");

    // Single language at confidence 1.0 (1/1) — above threshold
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  profileAllAgents — batch
// ---------------------------------------------------------------------------

describe("ExpertiseProfiler — profileAllAgents", () => {
  it("profiles all agents with commits or capabilities", async () => {
    const pool = createMockPool();

    pool.query.mockImplementation((sql: string) => {
      // The UNION query
      if (sql.includes("SELECT DISTINCT agent_id FROM")) {
        return Promise.resolve({ rows: [{ agent_id: "agt_1" }] });
      }
      if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
        return Promise.resolve({ rows: [{ capabilities: null }] });
      }
      if (sql.includes("unnest(languages)")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xTest" }] });
      }
      if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
          sql.includes("service_agreements") || sql.includes("service_listings") ||
          sql.includes("external_claims")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAllAgents();

    expect(count).toBe(1);
  });

  it("returns 0 when no agents have commits or capabilities", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const profiler = new ExpertiseProfiler(pool as any);
    const count = await profiler.profileAllAgents();

    expect(count).toBe(0);
  });
});
