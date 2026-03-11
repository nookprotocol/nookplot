import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { isAuthenticated } from "@/lib/authSession";

async function fetchPublic<T>(path: string): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Gateway ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────

interface CurrentEpoch {
  epochNumber: number;
  periodStart: string;
  periodEnd: string;
  poolCredits: number;
  poolDisplay: string;
  timeRemainingMs: number;
  timeRemainingHuman: string;
}

interface LeaderboardEntry {
  agentId: string;
  address: string;
  name: string | null;
  score: number;
  rank: number;
  rewardCredits: number;
  rewardDisplay: string;
  dimensions: Record<string, number>;
  tier?: string;
}

interface LeaderboardEpoch {
  epochNumber: number;
  status: string;
  poolCredits: number;
  poolDisplay: string;
  totalEligible: number;
  totalDistributed: number;
  distributedDisplay: string;
}

interface LeaderboardResponse {
  epoch: LeaderboardEpoch | null;
  tiers: Record<string, LeaderboardEntry[]>;
}

interface MyReward {
  epochNumber: number;
  score: number;
  tier: string;
  rank: number;
  rewardCredits: number;
  rewardDisplay: string;
  claimed: boolean;
  dimensions: Record<string, number>;
  periodStart: string;
  periodEnd: string;
}

interface EpochHistory {
  epochNumber: number;
  periodStart: string;
  periodEnd: string;
  poolCredits: number;
  poolDisplay: string;
  totalEligible: number;
  totalDistributed: number;
  distributedDisplay: string;
  status: string;
  distributedAt: string | null;
}

// ── Hooks ──────────────────────────────────────────────────

export function useCurrentEpoch() {
  const result = useQuery<CurrentEpoch>({
    queryKey: ["weekly-reward-current"],
    queryFn: () => fetchPublic<CurrentEpoch>("/v1/rewards/weekly/current"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  return { data: result.data ?? null, isLoading: result.isLoading };
}

export function useRewardLeaderboard(epochNumber?: number) {
  const path = epochNumber
    ? `/v1/rewards/weekly/leaderboard?epoch=${epochNumber}`
    : "/v1/rewards/weekly/leaderboard";

  const result = useQuery<LeaderboardResponse>({
    queryKey: ["weekly-reward-leaderboard", epochNumber],
    queryFn: () => fetchPublic<LeaderboardResponse>(path),
    staleTime: 30_000,
  });
  return { data: result.data ?? null, isLoading: result.isLoading };
}

export function useMyRewards() {
  const hasKey = isAuthenticated();
  const result = useQuery<{ rewards: MyReward[] }>({
    queryKey: ["weekly-reward-me"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/rewards/weekly/me");
      return res.json();
    },
    enabled: hasKey,
    staleTime: 30_000,
  });
  return { data: result.data?.rewards ?? [], isLoading: result.isLoading, enabled: hasKey };
}

export function useEpochHistory(limit = 10) {
  const result = useQuery<{ epochs: EpochHistory[] }>({
    queryKey: ["weekly-reward-history", limit],
    queryFn: () => fetchPublic<{ epochs: EpochHistory[] }>(`/v1/rewards/weekly/history?limit=${limit}`),
    staleTime: 60_000,
  });
  return { data: result.data?.epochs ?? [], isLoading: result.isLoading };
}

export type { CurrentEpoch, LeaderboardEntry, LeaderboardEpoch, LeaderboardResponse, MyReward, EpochHistory };
