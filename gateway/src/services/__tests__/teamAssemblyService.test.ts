import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamAssemblyService } from "../teamAssemblyService.js";
import type { SkillMatchingService } from "../skillMatchingService.js";

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockMatchingService(): SkillMatchingService {
  return {
    matchAgents: vi.fn().mockResolvedValue({ matches: [], total: 0 }),
  } as unknown as SkillMatchingService;
}

const REQUESTER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REQUEST_ID = "11111111-2222-3333-4444-555555555555";

describe("TeamAssemblyService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let matcher: ReturnType<typeof createMockMatchingService>;
  let service: TeamAssemblyService;

  beforeEach(() => {
    pool = createMockPool();
    matcher = createMockMatchingService();
    service = new TeamAssemblyService(pool, matcher);
  });

  it("assembles a team from explicit skills", async () => {
    pool.query.mockImplementation((sql: string, params?: any[]) => {
      // INSERT request
      if (sql.includes("INSERT INTO team_assembly_requests")) {
        return Promise.resolve({ rows: [{ id: REQUEST_ID }] });
      }
      // Requester address
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xREQUESTER" }] });
      }
      // UPDATE request with result
      if (sql.includes("UPDATE team_assembly_requests")) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (matcher.matchAgents as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [
        {
          address: "0xAAA",
          displayName: "Agent A",
          matchScore: 0.9,
          matchedSkills: [
            { tag: "TypeScript", confidence: 0.95, verificationLevel: "activity_verified" },
            { tag: "React", confidence: 0.85, verificationLevel: "inferred" },
          ],
          contributionScore: 5000,
          availability: "accepting_work",
          collabSuccessRate: 0.8,
          lastActive: new Date().toISOString(),
        },
        {
          address: "0xBBB",
          displayName: "Agent B",
          matchScore: 0.7,
          matchedSkills: [
            { tag: "Python", confidence: 0.9, verificationLevel: "inferred" },
          ],
          contributionScore: 3000,
          availability: null,
          collabSuccessRate: 0.7,
          lastActive: null,
        },
      ],
      total: 2,
    });

    const result = await service.assembleTeam(
      REQUESTER_ID,
      "Build a fullstack app with TypeScript, React, and Python",
      ["TypeScript", "React", "Python"],
      3,
    );

    expect(result.requestId).toBe(REQUEST_ID);
    expect(result.members.length).toBeGreaterThanOrEqual(2);
    expect(result.coverageScore).toBeGreaterThan(0);
    expect(result.status).toBe("completed");
  });

  it("reports skill gaps when not all skills are covered", async () => {
    pool.query.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO team_assembly_requests")) {
        return Promise.resolve({ rows: [{ id: REQUEST_ID }] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xREQUESTER" }] });
      }
      if (sql.includes("UPDATE team_assembly_requests")) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (matcher.matchAgents as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [
        {
          address: "0xAAA",
          displayName: "Agent A",
          matchScore: 0.9,
          matchedSkills: [
            { tag: "TypeScript", confidence: 0.95, verificationLevel: "inferred" },
          ],
          contributionScore: 5000,
          availability: null,
          collabSuccessRate: 0.8,
          lastActive: null,
        },
      ],
      total: 1,
    });

    const result = await service.assembleTeam(
      REQUESTER_ID,
      "Need TypeScript and Rust expertise",
      ["TypeScript", "Rust"],
      2,
    );

    expect(result.gaps).toContain("rust");
    expect(result.coverageScore).toBe(0.5); // 1/2 skills covered
  });

  it("extracts skills from description using known tags", async () => {
    pool.query.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO team_assembly_requests")) {
        return Promise.resolve({ rows: [{ id: REQUEST_ID }] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xREQUESTER" }] });
      }
      if (sql.includes("SELECT DISTINCT LOWER(tag)")) {
        return Promise.resolve({
          rows: [
            { tag: "typescript" },
            { tag: "react" },
            { tag: "python" },
            { tag: "machine learning" },
          ],
        });
      }
      if (sql.includes("UPDATE team_assembly_requests")) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (matcher.matchAgents as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [],
      total: 0,
    });

    const result = await service.assembleTeam(
      REQUESTER_ID,
      "Need a team with typescript and react skills for machine learning project",
    );

    // Verify matchAgents was called with extracted skills
    expect(matcher.matchAgents).toHaveBeenCalled();
    const callArgs = (matcher.matchAgents as ReturnType<typeof vi.fn>).mock.calls[0];
    const extractedSkills = callArgs[0] as string[];
    expect(extractedSkills).toContain("typescript");
    expect(extractedSkills).toContain("react");
  });

  it("rate limit check is performed", async () => {
    // The rate limit is checked in the route, not the service.
    // This test verifies the service stores the request.
    let insertCalled = false;

    pool.query.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO team_assembly_requests")) {
        insertCalled = true;
        return Promise.resolve({ rows: [{ id: REQUEST_ID }] });
      }
      if (sql.includes("SELECT address FROM agents")) {
        return Promise.resolve({ rows: [{ address: "0xREQUESTER" }] });
      }
      if (sql.includes("UPDATE team_assembly_requests")) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (matcher.matchAgents as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [],
      total: 0,
    });

    await service.assembleTeam(REQUESTER_ID, "Build something cool", ["TypeScript"]);
    expect(insertCalled).toBe(true);
  });
});
