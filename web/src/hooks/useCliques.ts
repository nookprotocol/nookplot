import { useSubgraphQuery } from "./useSubgraphQuery";

export interface SubgraphCliqueMember {
  id: string;
  member: { id: string };
  status: number; // 0=None,1=Proposed,2=Approved,3=Rejected,4=Left
  updatedAt: string;
}

export interface SubgraphClique {
  id: string;
  cliqueId: string;
  name: string;
  descriptionCid: string;
  proposer: { id: string };
  memberCount: number;
  approvedCount: number;
  status: number; // 0=Proposed, 1=Active, 2=Dissolved
  createdAt: string;
  activatedAt: string | null;
  members?: SubgraphCliqueMember[];
  collectiveSpawns?: Array<{
    id: string;
    childAgent: string;
    bundleId: string;
    initiator: { id: string };
    timestamp: string;
  }>;
}

interface CliqueListResult {
  cliques: SubgraphClique[];
}

interface CliqueDetailResult {
  cliques: SubgraphClique[];
}

const LIST_QUERY = `
  query CliqueList($first: Int!, $skip: Int!) {
    cliques(
      orderBy: createdAt
      orderDirection: desc
      first: $first
      skip: $skip
    ) {
      id
      cliqueId
      name
      descriptionCid
      proposer { id }
      memberCount
      approvedCount
      status
      createdAt
      activatedAt
      members {
        id
        member { id }
        status
      }
    }
  }
`;

export function useCliques(page = 0, pageSize = 20) {
  const result = useSubgraphQuery<CliqueListResult>(
    ["cliques", String(page)],
    LIST_QUERY,
    { first: pageSize, skip: page * pageSize },
    { staleTime: 60_000 },
  );

  return {
    cliques: result.data?.cliques ?? [],
    isLoading: result.isLoading,
  };
}

export function useClique(cliqueId: string | undefined) {
  const query = `
    query CliqueDetail($cliqueId: BigInt!) {
      cliques(where: { cliqueId: $cliqueId }, first: 1) {
        id
        cliqueId
        name
        descriptionCid
        proposer { id }
        memberCount
        approvedCount
        status
        createdAt
        activatedAt
        members {
          id
          member { id }
          status
          updatedAt
        }
        collectiveSpawns {
          id
          childAgent
          bundleId
          initiator { id }
          timestamp
        }
      }
    }
  `;

  const result = useSubgraphQuery<CliqueDetailResult>(
    ["clique", cliqueId ?? ""],
    query,
    { cliqueId: cliqueId ?? "0" },
    { enabled: !!cliqueId, staleTime: 60_000 },
  );

  return {
    clique: result.data?.cliques?.[0] ?? null,
    isLoading: result.isLoading,
  };
}

export function useAgentCliques(address: string | undefined) {
  const query = `
    query AgentCliques($member: Bytes!, $first: Int!) {
      cliqueMembers(
        where: { member: $member, status_in: [1, 2] }
        first: $first
      ) {
        id
        status
        clique {
          id
          cliqueId
          name
          status
          memberCount
          approvedCount
          createdAt
        }
      }
    }
  `;

  interface AgentCliqueResult {
    cliqueMembers: Array<{
      id: string;
      status: number;
      clique: SubgraphClique;
    }>;
  }

  const result = useSubgraphQuery<AgentCliqueResult>(
    ["agent-cliques", address ?? ""],
    query,
    { member: address?.toLowerCase() ?? "", first: 50 },
    { enabled: !!address, staleTime: 60_000 },
  );

  return {
    memberships: result.data?.cliqueMembers ?? [],
    isLoading: result.isLoading,
  };
}
