/**
 * TanStack Query hooks for project bounties (bounty-project bridge).
 *
 * @module hooks/useProjectBounties
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, getApiKey } from "@/hooks/useSandboxFiles";

// ─── Types ───

export interface ProjectBounty {
  id: string;
  projectId: string;
  taskId: string | null;
  milestoneId: string | null;
  onchainBountyId: number;
  title: string;
  description: string | null;
  creatorAddress: string;
  creatorName: string | null;
  claimerAddress: string | null;
  claimerName: string | null;
  status: string;
  rewardAmount: string | null;
  metadataCid: string | null;
  taskTitle: string | null;
  milestoneTitle: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BountyAccessRequest {
  id: string;
  projectBountyId: string;
  requesterAddress: string;
  requesterName: string | null;
  status: string;
  message: string | null;
  bountyTitle: string;
  onchainBountyId: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MyBountyRequest {
  id: string;
  projectBountyId: string;
  projectId: string;
  projectName: string | null;
  status: string;
  message: string | null;
  bountyTitle: string;
  onchainBountyId: number;
  rewardAmount: string | null;
  bountyStatus: string;
  createdAt: string;
  resolvedAt: string | null;
}

// ─── Global Bounties (cross-project) ───

export function useAllProjectBounties(statusFilter?: string) {
  const apiKey = getApiKey();
  const qs = statusFilter ? `?status=${statusFilter}` : "";

  return useQuery<(ProjectBounty & { projectName: string })[]>({
    queryKey: ["allProjectBounties", statusFilter],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/project-bounties${qs}`, { headers: {} });
      if (!res.ok) throw new Error(`Failed to fetch bounties: ${res.status}`);
      const data = await res.json();
      return data.bounties;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}

// ─── Bounty Hooks ───

export function useProjectBounties(projectId: string, statusFilter?: string) {
  const apiKey = getApiKey();
  const qs = statusFilter ? `?status=${statusFilter}` : "";

  return useQuery<ProjectBounty[]>({
    queryKey: ["projectBounties", projectId, statusFilter],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties${qs}`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch bounties: ${res.status}`);
      const data = await res.json();
      return data.bounties;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}

export function useCreateProjectBounty(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      title: string;
      description?: string;
      taskId?: string;
      milestoneId?: string;
      onchainBountyId: number;
      rewardAmount?: string;
      metadataCid?: string;
    }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to create bounty: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectBounties", projectId] });
    },
  });
}

export function useRequestBountyAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ bountyId, message }: { bountyId: string; message?: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties/${bountyId}/request-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`Failed to request access: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectBounties", projectId] });
      qc.invalidateQueries({ queryKey: ["myBountyRequests"] });
    },
  });
}

export function useGrantBountyAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ bountyId, requestId, requesterAddress }: {
      bountyId: string;
      requestId?: string;
      requesterAddress?: string;
    }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties/${bountyId}/grant-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, requesterAddress }),
      });
      if (!res.ok) throw new Error(`Failed to grant access: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bountyAccessRequests", projectId] });
      qc.invalidateQueries({ queryKey: ["projectBounties", projectId] });
    },
  });
}

export function useDenyBountyAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ bountyId, requestId, requesterAddress }: {
      bountyId: string;
      requestId?: string;
      requesterAddress?: string;
    }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties/${bountyId}/deny-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, requesterAddress }),
      });
      if (!res.ok) throw new Error(`Failed to deny access: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bountyAccessRequests", projectId] });
    },
  });
}

export function useSyncBountyStatus(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ bountyId }: { bountyId: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties/${bountyId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Failed to sync bounty: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectBounties", projectId] });
      qc.invalidateQueries({ queryKey: ["projectTasks", projectId] });
      qc.invalidateQueries({ queryKey: ["projectMilestones", projectId] });
    },
  });
}

export function useBountyAccessRequests(projectId: string) {
  const apiKey = getApiKey();
  return useQuery<BountyAccessRequest[]>({
    queryKey: ["bountyAccessRequests", projectId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/bounties/access-requests`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch access requests: ${res.status}`);
      const data = await res.json();
      return data.requests;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}

export function useMyBountyRequests() {
  const apiKey = getApiKey();
  return useQuery<MyBountyRequest[]>({
    queryKey: ["myBountyRequests"],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/agents/me/bounty-requests`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch my requests: ${res.status}`);
      const data = await res.json();
      return data.requests;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}
