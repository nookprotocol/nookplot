import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

export interface Workspace {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  status: string;
  channelId: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  agentId: string;
  role: string;
  joinedAt: string;
}

interface WorkspaceDetail extends Workspace {
  members: WorkspaceMember[];
}

export function useWorkspaces(enabled: boolean) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await gatewayFetch<{ workspaces: Workspace[] }>("/v1/workspaces");
      setWorkspaces(res.workspaces ?? []);
    } catch {
      // Graceful degradation
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (enabled) refresh();
    else setIsLoading(false);
  }, [enabled, refresh]);

  return { workspaces, isLoading, refresh };
}

export function useWorkspaceDetail(id: string | null, enabled: boolean) {
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !id) return;
    setIsLoading(true);
    try {
      const res = await gatewayFetch<WorkspaceDetail>(`/v1/workspaces/${id}`);
      setWorkspace(res);
    } catch {
      setWorkspace(null);
    } finally {
      setIsLoading(false);
    }
  }, [id, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { workspace, isLoading, refresh };
}

export function useWorkspaceMembers(id: string | null, enabled: boolean) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !id) return;
    setIsLoading(true);
    gatewayFetch<{ members: WorkspaceMember[] }>(`/v1/workspaces/${id}/members`)
      .then((res) => setMembers(res.members ?? []))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [id, enabled]);

  return { members, isLoading };
}

export async function createWorkspace(
  name: string,
  description: string,
): Promise<Workspace> {
  return gatewayFetch<Workspace>("/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

// ---------------------------------------------------------------------------
//  Workspace Entries (shared key-value state)
// ---------------------------------------------------------------------------

export interface WorkspaceEntry {
  key: string;
  value: unknown;
  version?: number;
  valueType?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export function useWorkspaceEntries(workspaceId: string | null) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    setIsError(false);
    try {
      const res = await gatewayFetch<{ state: WorkspaceEntry[] }>(
        `/v1/workspaces/${workspaceId}/state`,
      );
      setEntries(res.state ?? []);
    } catch {
      setIsError(true);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId) refresh();
    else {
      setEntries([]);
      setIsLoading(false);
    }
  }, [workspaceId, refresh]);

  return { entries, isLoading, isError, refresh };
}

export async function setWorkspaceEntry(
  workspaceId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await gatewayFetch(`/v1/workspaces/${workspaceId}/state`, {
    method: "PUT",
    body: JSON.stringify({ key, value }),
  });
}

export async function deleteWorkspaceEntry(
  workspaceId: string,
  key: string,
): Promise<void> {
  await gatewayFetch(`/v1/workspaces/${workspaceId}/state/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
//  Workspace Proposals
// ---------------------------------------------------------------------------

export interface WorkspaceProposal {
  id: string;
  workspaceId: string;
  title: string;
  description?: string;
  status: string;
  createdBy: string;
  actionType?: string;
  actionPayload?: unknown;
  approveCount?: number;
  rejectCount?: number;
  createdAt: string;
  expiresAt?: string;
}

export interface ProposalVote {
  agentId: string;
  vote: boolean;
  reason?: string;
  createdAt: string;
}

export function useWorkspaceProposals(workspaceId: string | null) {
  const [proposals, setProposals] = useState<WorkspaceProposal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    setIsError(false);
    try {
      const res = await gatewayFetch<{ proposals: WorkspaceProposal[] }>(
        `/v1/workspaces/${workspaceId}/proposals`,
      );
      setProposals(res.proposals ?? []);
    } catch {
      setIsError(true);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId) refresh();
    else {
      setProposals([]);
      setIsLoading(false);
    }
  }, [workspaceId, refresh]);

  return { proposals, isLoading, isError, refresh };
}

export async function createWorkspaceProposal(
  workspaceId: string,
  title: string,
  description?: string,
): Promise<void> {
  await gatewayFetch(`/v1/workspaces/${workspaceId}/proposals`, {
    method: "POST",
    body: JSON.stringify({ title, description }),
  });
}

export async function voteOnProposal(
  workspaceId: string,
  proposalId: string,
  vote: boolean,
): Promise<void> {
  await gatewayFetch(
    `/v1/workspaces/${workspaceId}/proposals/${proposalId}/vote`,
    {
      method: "POST",
      body: JSON.stringify({ vote }),
    },
  );
}
