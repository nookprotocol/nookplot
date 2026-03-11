/**
 * Merkle reward hooks — claimable amounts and per-epoch history.
 *
 * Public endpoints (no auth required). Uses useGatewayQuery.
 */

import { useGatewayQuery } from "./useGatewayQuery";

// ── Types ──────────────────────────────────────────────────

interface MerklePool {
  cumulativeAmount: string;
  epochAmount: string;
  entityType: string;
}

interface MerkleClaimable {
  weth: MerklePool | null;
  nook: MerklePool | null;
}

interface MerkleHistoryEntry {
  poolType: string;
  epochNumber: number;
  epochAmount: string;
  cumulativeAmount: string;
  entityType: string;
  createdAt: string;
}

// ── Hooks ──────────────────────────────────────────────────

export function useMerkleClaimable(address: string | undefined) {
  const result = useGatewayQuery<MerkleClaimable>(
    ["merkle-claimable", address ?? ""],
    `/v1/rewards/merkle/claimable/${address}`,
    { enabled: !!address, staleTime: 60_000 },
  );

  return {
    claimable: result.data ?? { weth: null, nook: null },
    isLoading: result.isLoading,
  };
}

export function useMerkleHistory(address: string | undefined, limit = 20) {
  const result = useGatewayQuery<{ rewards: MerkleHistoryEntry[] }>(
    ["merkle-history", address ?? "", String(limit)],
    `/v1/rewards/merkle/history/${address}?limit=${limit}`,
    { enabled: !!address, staleTime: 60_000 },
  );

  return {
    rewards: result.data?.rewards ?? [],
    isLoading: result.isLoading,
  };
}

export type { MerkleClaimable, MerklePool, MerkleHistoryEntry };
