import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAgentFleet } from "./useAgentFleet";

// Mock dependencies
const mockPresence = { agents: [] as { address: string; displayName: string | null; connectedAt: string; lastHeartbeat: string }[], isLoading: false };
const mockLeaderboard = { entries: [] as { address: string; displayName: string | null; score: number }[], isLoading: false };

vi.mock("@/hooks/usePresence", () => ({
  usePresence: () => mockPresence,
}));

vi.mock("@/hooks/useLeaderboard", () => ({
  useLeaderboard: () => mockLeaderboard,
}));

beforeEach(() => {
  mockPresence.agents = [];
  mockPresence.isLoading = false;
  mockLeaderboard.entries = [];
  mockLeaderboard.isLoading = false;
});

describe("useAgentFleet", () => {
  it("returns empty fleet when no agents exist", () => {
    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.fleet).toEqual([]);
    expect(result.current.onlineCount).toBe(0);
    expect(result.current.totalCount).toBe(0);
    expect(result.current.isLoading).toBe(false);
  });

  it("marks online agents correctly", () => {
    mockPresence.agents = [
      { address: "0xAAA", displayName: "alice", connectedAt: "2025-01-01T00:00:00Z", lastHeartbeat: "2025-01-01T00:00:00Z" },
    ];

    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.fleet).toHaveLength(1);
    expect(result.current.fleet[0].status).toBe("online");
    expect(result.current.fleet[0].displayName).toBe("alice");
    expect(result.current.onlineCount).toBe(1);
  });

  it("marks leaderboard-only agents as offline", () => {
    mockLeaderboard.entries = [
      { address: "0xBBB", displayName: "bob", score: 100 },
    ];

    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.fleet).toHaveLength(1);
    expect(result.current.fleet[0].status).toBe("offline");
    expect(result.current.fleet[0].score).toBe(100);
    expect(result.current.onlineCount).toBe(0);
  });

  it("merges online and leaderboard data for the same agent", () => {
    mockPresence.agents = [
      { address: "0xAAA", displayName: null, connectedAt: "2025-01-01T00:00:00Z", lastHeartbeat: "2025-01-01T00:00:00Z" },
    ];
    mockLeaderboard.entries = [
      { address: "0xAAA", displayName: "alice", score: 250 },
    ];

    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.fleet).toHaveLength(1);
    expect(result.current.fleet[0].status).toBe("online");
    expect(result.current.fleet[0].score).toBe(250);
    // Leaderboard displayName used as fallback when presence displayName is null
    expect(result.current.fleet[0].displayName).toBe("alice");
  });

  it("sorts online agents before offline, then by score descending", () => {
    mockPresence.agents = [
      { address: "0xAAA", displayName: "alice", connectedAt: "2025-01-01T00:00:00Z", lastHeartbeat: "2025-01-01T00:00:00Z" },
    ];
    mockLeaderboard.entries = [
      { address: "0xAAA", displayName: "alice", score: 50 },
      { address: "0xBBB", displayName: "bob", score: 500 },
      { address: "0xCCC", displayName: "charlie", score: 10 },
    ];

    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.fleet).toHaveLength(3);
    // Online first regardless of score
    expect(result.current.fleet[0].address).toBe("0xAAA");
    expect(result.current.fleet[0].status).toBe("online");
    // Then offline by score descending
    expect(result.current.fleet[1].address).toBe("0xBBB");
    expect(result.current.fleet[1].score).toBe(500);
    expect(result.current.fleet[2].address).toBe("0xCCC");
    expect(result.current.fleet[2].score).toBe(10);
  });

  it("handles case-insensitive address matching", () => {
    mockPresence.agents = [
      { address: "0xAaA", displayName: "alice", connectedAt: "2025-01-01T00:00:00Z", lastHeartbeat: "2025-01-01T00:00:00Z" },
    ];
    mockLeaderboard.entries = [
      { address: "0xaaa", displayName: "Alice", score: 100 },
    ];

    const { result } = renderHook(() => useAgentFleet());
    // Should merge as one agent, not two
    expect(result.current.fleet).toHaveLength(1);
    expect(result.current.fleet[0].score).toBe(100);
  });

  it("reports isLoading when either source is loading", () => {
    mockPresence.isLoading = true;
    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.isLoading).toBe(true);
  });

  it("reports isLoading when leaderboard is loading", () => {
    mockLeaderboard.isLoading = true;
    const { result } = renderHook(() => useAgentFleet());
    expect(result.current.isLoading).toBe(true);
  });
});
