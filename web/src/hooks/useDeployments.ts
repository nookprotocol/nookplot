import { useSubgraphQuery } from "./useSubgraphQuery";

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

interface DeploymentListResult {
  agentDeployments: SubgraphDeployment[];
}

interface SpawnTreeResult {
  spawnRelations: SubgraphSpawnRelation[];
}

const LIST_QUERY = `
  query DeploymentList($first: Int!, $skip: Int!) {
    agentDeployments(
      orderBy: createdAt
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      deploymentId
      creator { id }
      agentAddress
      bundle { id bundleId name }
      soulCid
      deploymentFee
      contributorPayout
      treasuryPayout
      creditPayout
      curatorPayout
      parentAgent
      isSpawn
      createdAt
    }
  }
`;

export function useDeployments(page = 0, pageSize = 20) {
  const result = useSubgraphQuery<DeploymentListResult>(
    ["deployments", String(page)],
    LIST_QUERY,
    { first: pageSize, skip: page * pageSize },
    { staleTime: 15_000 },
  );

  return {
    deployments: result.data?.agentDeployments ?? [],
    isLoading: result.isLoading,
  };
}

export function useDeployment(deploymentId: string | undefined) {
  const query = `
    query DeploymentDetail($deploymentId: BigInt!) {
      agentDeployments(where: { deploymentId: $deploymentId }, first: 1) {
        id
        deploymentId
        creator { id }
        agentAddress
        bundle { id bundleId name }
        soulCid
        deploymentFee
        contributorPayout
        treasuryPayout
        creditPayout
        curatorPayout
        parentAgent
        isSpawn
        createdAt
      }
    }
  `;

  const result = useSubgraphQuery<DeploymentListResult>(
    ["deployment", deploymentId ?? ""],
    query,
    { deploymentId: deploymentId ?? "0" },
    { enabled: !!deploymentId, staleTime: 15_000 },
  );

  return {
    deployment: result.data?.agentDeployments?.[0] ?? null,
    isLoading: result.isLoading,
  };
}

export function useSpawnTree(address: string | undefined) {
  const query = `
    query SpawnTree($parent: Bytes!) {
      spawnRelations(
        where: { parent: $parent }
        orderBy: createdAt
        orderDirection: desc
        first: 100
      ) {
        id
        parent { id soulCid }
        child { id soulCid }
        deployment { deploymentId soulCid bundle { bundleId name } }
        createdAt
      }
    }
  `;

  const result = useSubgraphQuery<SpawnTreeResult>(
    ["spawn-tree", address ?? ""],
    query,
    { parent: address?.toLowerCase() ?? "" },
    { enabled: !!address, staleTime: 15_000 },
  );

  return {
    children: result.data?.spawnRelations ?? [],
    isLoading: result.isLoading,
  };
}
