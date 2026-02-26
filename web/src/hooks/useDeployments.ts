import { useGatewayQuery } from "./useGatewayQuery";

export interface SubgraphDeployment {
  id: string;
  deploymentId: string;
  creator: { id: string };
  agentAddress: string;
  bundle: { id: string; bundleId: string; name: string };
  soulCid: string;
  deploymentFee: string;
  contributorPayout: string;
  treasuryPayout: string;
  creditPayout: string;
  curatorPayout: string;
  parentAgent: string | null;
  isSpawn: boolean;
  createdAt: string;
}

export interface SubgraphSpawnRelation {
  id: string;
  parent: { id: string; soulCid?: string };
  child: { id: string; soulCid?: string };
  deployment: { deploymentId: string; soulCid: string; bundle: { bundleId: string; name: string } };
  createdAt: string;
}

/** Gateway GET /v1/deployments response */
interface GatewayDeploymentsResult {
  deployments: SubgraphDeployment[];
  first: number;
  skip: number;
}

/** Gateway GET /v1/deployments/tree/:address response */
interface GatewaySpawnTreeResult {
  address: string;
  children: SubgraphSpawnRelation[];
}

/**
 * List deployments — gateway-first (benefits from 72h stale cache).
 */
export function useDeployments(page = 0, pageSize = 20) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));

  const result = useGatewayQuery<GatewayDeploymentsResult>(
    ["deployments", String(page)],
    `/v1/deployments?${params}`,
    { staleTime: 60_000 },
  );

  return {
    deployments: result.data?.deployments ?? [],
    isLoading: result.isLoading,
  };
}

/**
 * Single deployment detail — gateway-first.
 */
export function useDeployment(deploymentId: string | undefined) {
  const result = useGatewayQuery<SubgraphDeployment | null>(
    ["deployment", deploymentId ?? ""],
    `/v1/deployments/${deploymentId}`,
    { enabled: !!deploymentId, staleTime: 60_000 },
  );

  return {
    deployment: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/**
 * Spawn tree — gateway-first.
 */
export function useSpawnTree(address: string | undefined) {
  const normalised = address?.toLowerCase();

  const result = useGatewayQuery<GatewaySpawnTreeResult>(
    ["spawn-tree", normalised ?? ""],
    `/v1/deployments/tree/${normalised}`,
    { enabled: !!normalised, staleTime: 60_000 },
  );

  return {
    children: result.data?.children ?? [],
    isLoading: result.isLoading,
  };
}
