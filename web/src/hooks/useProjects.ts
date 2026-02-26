/**
 * TanStack Query hooks for project CRUD operations.
 *
 * `useCreateProject` uses the prepare → sign → relay non-custodial flow:
 *   1. POST /v1/prepare/project — uploads metadata to IPFS, returns unsigned ForwardRequest
 *   2. Wallet signs the EIP-712 typed data (ForwardRequest)
 *   3. POST /v1/relay — gateway relays the signed meta-tx and syncs to DB
 *
 * @module hooks/useProjects
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWalletClient } from "wagmi";
import { gatewayFetch, getApiKey } from "@/hooks/useSandboxFiles";
import { GATEWAY_URL } from "@/config/constants";

export interface Project {
  projectId: string;
  name: string;
  description?: string;
  repoUrl?: string;
  defaultBranch?: string;
  languages: string[];
  tags?: string[];
  license?: string;
  metadataCid?: string;
  status: "active" | "archived";
  createdAt: string;
  creatorAddress?: string;
  creatorName?: string;
}

interface CreateProjectInput {
  id: string;
  name: string;
  description?: string;
  repo?: string;
  branch?: string;
  languages?: string[];
  tags?: string[];
  license?: string;
}

interface PrepareProjectResponse {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  metadataCid: string;
}

interface NetworkProjectsResult {
  projects: Project[];
  total: number;
}

export interface ProjectCollaborator {
  address: string;
  name: string | null;
  role: number;
}

export interface ProjectDetail extends Project {
  collaborators: ProjectCollaborator[];
}

/** Fetch detailed information about a specific project (includes collaborators). Public endpoint. */
export function useProjectDetail(projectId: string | undefined) {
  return useQuery<ProjectDetail>({
    queryKey: ["project-detail", projectId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${encodeURIComponent(projectId!)}`);
      return res.json() as Promise<ProjectDetail>;
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

/** Fetch all projects for the current API key. */
export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/projects");
      const data = await res.json();
      return data.projects ?? [];
    },
    enabled: !!getApiKey(),
    staleTime: 30_000,
  });
}

/** Fetch all active projects across the network (paginated). Public endpoint. */
export function useNetworkProjects(page = 0, sort = "newest") {
  const limit = 20;
  return useQuery<NetworkProjectsResult>({
    queryKey: ["network-projects", page, sort],
    queryFn: async () => {
      const res = await gatewayFetch(
        `/v1/projects/network?limit=${limit}&offset=${page * limit}&sort=${encodeURIComponent(sort)}`,
      );
      return res.json() as Promise<NetworkProjectsResult>;
    },
    staleTime: 30_000,
  });
}

/** Fetch ALL active projects for client-side search. Enabled only when searching. */
export function useAllNetworkProjects(enabled: boolean) {
  return useQuery<Project[]>({
    queryKey: ["network-projects-all"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/projects/network?limit=100&offset=0");
      const data: NetworkProjectsResult = await res.json();
      return data.projects ?? [];
    },
    enabled,
    staleTime: 60_000, // 1 min — heavier query, cache longer
  });
}

/** Fetch another agent's projects by their address (public, no auth). */
export function useAgentProjects(address: string | undefined) {
  return useQuery<Project[]>({
    queryKey: ["agent-projects", address],
    queryFn: async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/agents/${address}/projects`);
      if (!res.ok) throw new Error(`Failed to fetch agent projects (HTTP ${res.status})`);
      const data = await res.json();
      return data.projects ?? [];
    },
    enabled: !!address,
    staleTime: 30_000,
  });
}

/**
 * Create a new project via prepare → sign → relay flow.
 *
 * Requires both a gateway API key and a connected wallet.
 */
export function useCreateProject() {
  const queryClient = useQueryClient();
  const { data: walletClient } = useWalletClient();

  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      if (!walletClient?.account) {
        throw new Error("Wallet not connected");
      }

      // 1. Prepare — uploads metadata to IPFS, returns unsigned ForwardRequest
      const prepRes = await gatewayFetch("/v1/prepare/project", {
        method: "POST",
        body: JSON.stringify({
          projectId: input.id,
          name: input.name,
          description: input.description,
          repoUrl: input.repo,
          defaultBranch: input.branch,
          languages: input.languages,
          tags: input.tags,
          license: input.license,
        }),
      });
      const prepared = (await prepRes.json()) as PrepareProjectResponse;

      // 2. Sign — EIP-712 typed data with connected wallet
      const { forwardRequest, domain, types } = prepared;

      // Verify the connected wallet matches the ForwardRequest `from` address.
      // The gateway sets `from` to the API key's agent address. If the connected
      // wallet is a different address (e.g. a human using an agent's API key),
      // the relay will reject the signature. Catch this early with a clear error.
      if (
        walletClient.account.address.toLowerCase() !==
        forwardRequest.from.toLowerCase()
      ) {
        throw new Error(
          "Wallet mismatch: your connected wallet does not match the API key's agent address. " +
          "Project creation requires your own agent API key — register as an agent via the CLI first.",
        );
      }

      // wagmi/viem expects bigint for numeric fields
      const message = {
        from: forwardRequest.from as `0x${string}`,
        to: forwardRequest.to as `0x${string}`,
        value: BigInt(forwardRequest.value),
        gas: BigInt(forwardRequest.gas),
        nonce: BigInt(forwardRequest.nonce),
        deadline: BigInt(forwardRequest.deadline),
        data: forwardRequest.data as `0x${string}`,
      };

      const signature = await walletClient.signTypedData({
        account: walletClient.account,
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: BigInt(domain.chainId),
          verifyingContract: domain.verifyingContract as `0x${string}`,
        },
        types: {
          ForwardRequest: types.ForwardRequest.map((f) => ({
            name: f.name,
            type: f.type,
          })),
        },
        primaryType: "ForwardRequest",
        message,
      });

      // 3. Relay — submit signed ForwardRequest
      const relayRes = await gatewayFetch("/v1/relay", {
        method: "POST",
        body: JSON.stringify({
          ...forwardRequest,
          signature,
        }),
      });
      const relayData = (await relayRes.json()) as { txHash: string; status: string };

      return {
        projectId: input.id,
        name: input.name,
        txHash: relayData.txHash,
        metadataCid: prepared.metadataCid,
      };
    },
    onSuccess: () => {
      // Invalidate after a short delay to give the relay background task time to sync
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["projects"] });
      }, 3000);
    },
  });
}
