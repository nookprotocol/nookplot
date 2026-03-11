import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpertiseProfiler } from "../expertiseProfiler.js";

// ============================================================
//  Mock factory
// ============================================================

function createMockPool() {
  return { query: vi.fn() } as any;
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ADDRESS = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";

// ============================================================
//  Tests
// ============================================================

describe("ExpertiseProfiler", () => {
  let pool: ReturnType<typeof createMockPool>;
  let profiler: ExpertiseProfiler;

  beforeEach(() => {
    pool = createMockPool();
    profiler = new ExpertiseProfiler(pool);
  });

  describe("profileAgent", () => {
    it("ingests self-reported capabilities", async () => {
      const upsertedTags: string[] = [];

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        // Self-reported: agents.capabilities
        if (sql.includes("SELECT capabilities FROM agents")) {
          return Promise.resolve({
            rows: [{ capabilities: ["React", "TypeScript", "Machine Learning"] }],
          });
        }
        // Commit history: no commits
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [] });
        }
        // Activity: agent address
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        // Bounty completions
        if (sql.includes("project_bounties") || sql.includes("idx_bounties")) {
          return Promise.resolve({ rows: [] });
        }
        // Service agreements
        if (sql.includes("service_agreements")) {
          return Promise.resolve({ rows: [] });
        }
        // External claims
        if (sql.includes("external_claims")) {
          return Promise.resolve({ rows: [] });
        }
        // UPSERT expertise_tags
        if (sql.includes("INSERT INTO expertise_tags")) {
          upsertedTags.push(params?.[1]);
          return Promise.resolve({ rowCount: 1 });
        }
        // DELETE stale tags
        if (sql.includes("DELETE FROM expertise_tags")) {
          return Promise.resolve({ rowCount: 0 });
        }
        // skill_tsv rebuild
        if (sql.includes("UPDATE agents SET skill_tsv")) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const count = await profiler.profileAgent(AGENT_ID);
      expect(count).toBe(3);
      expect(upsertedTags).toContain("React");
      expect(upsertedTags).toContain("TypeScript");
      expect(upsertedTags).toContain("Machine Learning");
    });

    it("ingests commit history languages and frameworks", async () => {
      const upsertedTags: Array<{ tag: string; source: string; verification: string }> = [];

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        // Self-reported: no capabilities
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          return Promise.resolve({ rows: [{ capabilities: null }] });
        }
        // Commit languages
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({
            rows: [
              { lang: "TypeScript", freq: "100" },
              { lang: "Python", freq: "30" },
            ],
          });
        }
        // Commit frameworks
        if (sql.includes("unnest(frameworks)")) {
          return Promise.resolve({
            rows: [{ fw: ".tsx", freq: "80" }],
          });
        }
        // Activity: agent address
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        // Bounty/service/external — empty
        if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
            sql.includes("service_agreements") || sql.includes("external_claims") ||
            sql.includes("service_listings")) {
          return Promise.resolve({ rows: [] });
        }
        // UPSERT expertise_tags
        if (sql.includes("INSERT INTO expertise_tags")) {
          upsertedTags.push({
            tag: params?.[1],
            source: params?.[3],
            verification: params?.[5],
          });
          return Promise.resolve({ rowCount: 1 });
        }
        // DELETE / UPDATE
        if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const count = await profiler.profileAgent(AGENT_ID);
      expect(count).toBeGreaterThanOrEqual(3); // TypeScript + Python + React framework
      expect(upsertedTags.some((t) => t.tag === "TypeScript" && t.source === "language")).toBe(true);
      expect(upsertedTags.some((t) => t.tag === "React" && t.source === "framework")).toBe(true);
    });

    it("ingests activity-verified bounty tags", async () => {
      const upsertedTags: Array<{ tag: string; verification: string }> = [];

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        // Self-reported: no capabilities
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          return Promise.resolve({ rows: [{ capabilities: null }] });
        }
        // Commit history: no commits
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [] });
        }
        // Activity: agent address
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        // Bounty completions with tags
        if (sql.includes("project_bounties") && sql.includes("unnest")) {
          return Promise.resolve({
            rows: [
              { tag: "smart-contracts", bounty_count: "3" },
              { tag: "security-audit", bounty_count: "1" },
            ],
          });
        }
        // Service agreements — empty
        if (sql.includes("service_agreements")) {
          return Promise.resolve({ rows: [] });
        }
        // External claims — empty
        if (sql.includes("external_claims")) {
          return Promise.resolve({ rows: [] });
        }
        // UPSERT
        if (sql.includes("INSERT INTO expertise_tags")) {
          upsertedTags.push({ tag: params?.[1], verification: params?.[5] });
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const count = await profiler.profileAgent(AGENT_ID);
      expect(count).toBe(2);
      const scTag = upsertedTags.find((t) => t.tag === "smart-contracts");
      expect(scTag).toBeDefined();
      expect(scTag!.verification).toBe("activity_verified");
    });

    it("ingests externally-verified GitHub claims", async () => {
      const upsertedTags: Array<{ tag: string; verification: string }> = [];

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          return Promise.resolve({ rows: [{ capabilities: null }] });
        }
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        if (sql.includes("project_bounties") || sql.includes("idx_bounties")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("service_agreements") || sql.includes("service_listings")) {
          return Promise.resolve({ rows: [] });
        }
        // External claims — GitHub with languages
        if (sql.includes("external_claims")) {
          return Promise.resolve({
            rows: [{
              platform: "github",
              verification_data: {
                languages: ["Rust", "Go"],
                topics: ["blockchain", "web3"],
              },
            }],
          });
        }
        if (sql.includes("INSERT INTO expertise_tags")) {
          upsertedTags.push({ tag: params?.[1], verification: params?.[5] });
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const count = await profiler.profileAgent(AGENT_ID);
      expect(count).toBe(4); // Rust, Go, blockchain, web3
      expect(upsertedTags.every((t) => t.verification === "externally_verified")).toBe(true);
      expect(upsertedTags.some((t) => t.tag === "Rust")).toBe(true);
      expect(upsertedTags.some((t) => t.tag === "blockchain")).toBe(true);
    });

    it("merges tags from multiple sources — higher confidence wins", async () => {
      const upsertedTags: Array<{ tag: string; confidence: number; verification: string }> = [];

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        // Self-reported: includes "TypeScript"
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          return Promise.resolve({ rows: [{ capabilities: ["TypeScript"] }] });
        }
        // Commit languages: "TypeScript" with high frequency
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [{ lang: "TypeScript", freq: "100" }] });
        }
        if (sql.includes("unnest(frameworks)")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
            sql.includes("service_agreements") || sql.includes("service_listings") ||
            sql.includes("external_claims")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("INSERT INTO expertise_tags")) {
          upsertedTags.push({
            tag: params?.[1],
            confidence: params?.[2],
            verification: params?.[5],
          });
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await profiler.profileAgent(AGENT_ID);
      // TypeScript should appear once with the higher confidence (1.0 from commits, not 0.5 from self-reported)
      const tsTags = upsertedTags.filter((t) => t.tag.toLowerCase() === "typescript");
      expect(tsTags.length).toBe(1);
      expect(tsTags[0].confidence).toBe(1.0);
      // Should be upgraded to "inferred" (rank 1) over "self_reported" (rank 0)
      expect(tsTags[0].verification).toBe("inferred");
    });

    it("rebuilds skill_tsv after profiling", async () => {
      let skillTsvUpdated = false;

      pool.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          return Promise.resolve({ rows: [{ capabilities: ["React"] }] });
        }
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
            sql.includes("service_agreements") || sql.includes("service_listings") ||
            sql.includes("external_claims")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("INSERT INTO expertise_tags")) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes("DELETE FROM expertise_tags")) {
          return Promise.resolve({ rowCount: 0 });
        }
        if (sql.includes("UPDATE agents SET skill_tsv")) {
          skillTsvUpdated = true;
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await profiler.profileAgent(AGENT_ID);
      expect(skillTsvUpdated).toBe(true);
    });

    it("respects MAX_TAGS limit of 30", async () => {
      const upsertedTags: string[] = [];

      // Generate 40 capabilities
      const capabilities = Array.from({ length: 40 }, (_, i) => `Skill${i}`);

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          return Promise.resolve({ rows: [{ capabilities }] });
        }
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
        }
        if (sql.includes("project_bounties") || sql.includes("idx_bounties") ||
            sql.includes("service_agreements") || sql.includes("service_listings") ||
            sql.includes("external_claims")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("INSERT INTO expertise_tags")) {
          upsertedTags.push(params?.[1]);
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes("DELETE FROM expertise_tags") || sql.includes("UPDATE agents SET skill_tsv")) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const count = await profiler.profileAgent(AGENT_ID);
      expect(count).toBeLessThanOrEqual(30);
    });
  });

  describe("profileAllAgents", () => {
    it("profiles agents with commit history OR capabilities", async () => {
      const profiledAgents: string[] = [];

      pool.query.mockImplementation((sql: string, params?: any[]) => {
        // The UNION query for all agents
        if (sql.includes("SELECT DISTINCT agent_id FROM")) {
          return Promise.resolve({
            rows: [
              { agent_id: "agent-1" },
              { agent_id: "agent-2" },
            ],
          });
        }
        // For profileAgent calls — track which agents are profiled
        if (sql.includes("SELECT capabilities FROM agents") && !sql.includes("address")) {
          profiledAgents.push(params?.[0]);
          return Promise.resolve({ rows: [{ capabilities: null }] });
        }
        if (sql.includes("unnest(languages)")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("SELECT address FROM agents")) {
          return Promise.resolve({ rows: [{ address: ADDRESS }] });
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

      const count = await profiler.profileAllAgents();
      expect(count).toBe(2);
      expect(profiledAgents).toContain("agent-1");
      expect(profiledAgents).toContain("agent-2");
    });
  });

  describe("getAgentSkills", () => {
    it("returns enriched skill data", async () => {
      pool.query.mockResolvedValue({
        rows: [
          {
            tag: "TypeScript",
            confidence: 0.95,
            source: "language",
            category: "language",
            verification_level: "activity_verified",
            evidence_count: 12,
            evidence_summary: { commits: 47, bounties_completed: 3 },
          },
          {
            tag: "React",
            confidence: 0.8,
            source: "framework",
            category: "framework",
            verification_level: "inferred",
            evidence_count: 5,
            evidence_summary: { framework_heuristic: true },
          },
        ],
      });

      const skills = await profiler.getAgentSkills(AGENT_ID);
      expect(skills).toHaveLength(2);
      expect(skills[0].tag).toBe("TypeScript");
      expect(skills[0].verificationLevel).toBe("activity_verified");
      expect(skills[0].evidenceCount).toBe(12);
      expect(skills[1].tag).toBe("React");
    });
  });
});
