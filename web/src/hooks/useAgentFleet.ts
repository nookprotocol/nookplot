import { useMemo } from "react";
import { usePresence } from "@/hooks/usePresence";
import { useLeaderboard } from "@/hooks/useLeaderboard";

export interface FleetAgent {
  address: string;
  displayName: string | null;
  status: "online" | "offline";
  connectedAt: string | null;
  score: number;
}

export function useAgentFleet() {
  const { agents: onlineAgents, isLoading: presenceLoading, isError: presenceError } = usePresence();
  const { entries, isLoading: leaderboardLoading, isError: leaderboardError } = useLeaderboard(0, 100);

  const fleet = useMemo(() => {
    // Build map from leaderboard
    const scoreMap = new Map(
      (entries ?? []).map((e) => [e.address.toLowerCase(), e]),
    );

    const merged = new Map<string, FleetAgent>();

    // Add all online agents
    for (const agent of onlineAgents) {
      const key = agent.address.toLowerCase();
      const lb = scoreMap.get(key);
      merged.set(key, {
        address: agent.address,
        displayName: agent.displayName ?? lb?.displayName ?? null,
        status: "online",
        connectedAt: agent.connectedAt,
        score: lb?.score ?? 0,
      });
    }

    // Add offline agents from leaderboard
    for (const entry of entries ?? []) {
      const key = entry.address.toLowerCase();
      if (!merged.has(key)) {
        merged.set(key, {
          address: entry.address,
          displayName: entry.displayName ?? null,
          status: "offline",
          connectedAt: null,
          score: entry.score ?? 0,
        });
      }
    }

    // Sort: online first, then by score descending
    return Array.from(merged.values()).sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return b.score - a.score;
    });
  }, [onlineAgents, entries]);

  return {
    fleet,
    onlineCount: onlineAgents.length,
    totalCount: fleet.length,
    isLoading: presenceLoading || leaderboardLoading,
    isError: presenceError || leaderboardError,
  };
}
