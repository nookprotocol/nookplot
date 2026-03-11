import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillMatchingService } from "../skillMatchingService.js";
import { CollaborationTracker } from "../collaborationTracker.js";

function createMockPool() {
  return { query: vi.fn() } as any;
}

function createMockTracker() {
  return {
    getCollabSuccessRate: vi.fn().mockResolvedValue(0.8),
    trackAll: vi.fn().mockResolvedValue(0),
  } as unknown as CollaborationTracker;
}

describe("SkillMatchingService", () => {
  let pool: ReturnType<typeof createMockPool>;
  let tracker: CollaborationTracker;
  let service: SkillMatchingService;

  beforeEach(() => {
    pool = createMockPool();
    tracker = createMockTracker();
    service = new SkillMatchingService(pool, tracker);
  });

  it("returns empty for no skills", async () => {
    const result = await service.matchAgents([]);
    expect(result.matches).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns matches ranked by composite score", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          agent_id: "a1",
          address: "0xAAA",
          display_name: "Agent Alpha",
          tag: "TypeScript",
          confidence: 0.95,
          verification_level: "activity_verified",
          overall_score: 5000,
          last_heartbeat: new Date().toISOString(),
          availability: "accepting_work",
        },
        {
          agent_id: "a2",
          address: "0xBBB",
          display_name: "Agent Beta",
          tag: "TypeScript",
          confidence: 0.5,
          verification_level: "self_reported",
          overall_score: 1000,
          last_heartbeat: null,
          availability: null,
        },
      ],
    });

    const result = await service.matchAgents(["typescript"]);
    expect(result.matches).toHaveLength(2);
    expect(result.total).toBe(2);
    // Agent Alpha should rank higher (higher confidence, contribution, availability)
    expect(result.matches[0].address).toBe("0xAAA");
    expect(result.matches[0].matchScore).toBeGreaterThan(result.matches[1].matchScore);
  });

  it("groups skills per agent correctly", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          agent_id: "a1", address: "0xAAA", display_name: "Multi",
          tag: "TypeScript", confidence: 0.9, verification_level: "inferred",
          overall_score: 3000, last_heartbeat: new Date().toISOString(),
          availability: null,
        },
        {
          agent_id: "a1", address: "0xAAA", display_name: "Multi",
          tag: "React", confidence: 0.8, verification_level: "activity_verified",
          overall_score: 3000, last_heartbeat: new Date().toISOString(),
          availability: null,
        },
      ],
    });

    const result = await service.matchAgents(["typescript", "react"]);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchedSkills).toHaveLength(2);
  });

  it("filters by availability when availableOnly=true", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          agent_id: "a1", address: "0xAAA", display_name: "Online",
          tag: "Python", confidence: 0.9, verification_level: "inferred",
          overall_score: 3000, last_heartbeat: new Date().toISOString(),
          availability: "accepting_work",
        },
        {
          agent_id: "a2", address: "0xBBB", display_name: "Offline",
          tag: "Python", confidence: 0.8, verification_level: "inferred",
          overall_score: 4000, last_heartbeat: null,
          availability: null,
        },
      ],
    });

    const result = await service.matchAgents(["python"], { availableOnly: true });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].address).toBe("0xAAA");
  });

  it("respects minReputation filter", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          agent_id: "a1", address: "0xAAA", display_name: "High Rep",
          tag: "Go", confidence: 0.9, verification_level: "inferred",
          overall_score: 5000, last_heartbeat: null,
          availability: null,
        },
        {
          agent_id: "a2", address: "0xBBB", display_name: "Low Rep",
          tag: "Go", confidence: 0.9, verification_level: "inferred",
          overall_score: 50, last_heartbeat: null,
          availability: null,
        },
      ],
    });

    const result = await service.matchAgents(["go"], { minReputation: 1000 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].address).toBe("0xAAA");
  });
});
