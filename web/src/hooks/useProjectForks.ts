/**
 * TanStack Query hooks for project fork/merge-request operations.
 *
 * @module hooks/useProjectForks
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

// ─── Types ───

export interface MergeRequest {
  id: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
  targetProjectId: string;
  targetProjectName: string | null;
  authorAddress: string;
  authorName: string | null;
  title: string;
  description: string | null;
  commitIds: string[];
  status: "open" | "merged" | "closed";
  reviewerAddress: string | null;
  reviewerName: string | null;
  reviewComment: string | null;
  mergedCommitId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileCommitChange {
  filePath: string;
  changeType: "added" | "modified" | "deleted";
  linesAdded: number;
  linesRemoved: number;
  oldContent: string | null;
  newContent: string | null;
}

export interface MergeRequestDetail extends MergeRequest {
  commits: {
    id: string;
    commitId: string;
    projectId: string;
    authorAddress: string;
    authorName: string | null;
    message: string;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    reviewStatus: string;
    approvals: number;
    rejections: number;
    source: string;
    createdAt: string;
  }[];
  fileDiffs: FileCommitChange[];
}

export interface ForkResult {
  projectId: string;
  name: string;
  forkedFrom: string;
  filesCount: number;
  initialCommitId: string;
}

// ─── Mutations ───

/** Fork a project — POST /v1/projects/:id/fork */
export function useForkProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return gatewayFetch<ForkResult>(
        `/v1/projects/${encodeURIComponent(projectId)}/fork`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-detail", projectId] });
    },
  });
}

/** Create a merge request — POST /v1/projects/:sourceProjectId/merge-requests
 *  The sourceProjectId (fork) is the URL param; body has title, description, commitIds.
 *  The targetProjectId param here is used to invalidate the target's MR cache. */
export function useCreateMR(sourceProjectId: string, targetProjectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; commitIds: string[]; description?: string }) => {
      return gatewayFetch<MergeRequest>(
        `/v1/projects/${encodeURIComponent(sourceProjectId)}/merge-requests`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["merge-requests", sourceProjectId] });
      if (targetProjectId) {
        queryClient.invalidateQueries({ queryKey: ["merge-requests", targetProjectId] });
      }
      queryClient.invalidateQueries({ queryKey: ["project-activity", sourceProjectId] });
    },
  });
}

/** Merge a merge request — POST /v1/projects/:id/merge-requests/:mrId/merge */
export function useMergeMR(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ mrId }: { mrId: string }) => {
      return gatewayFetch<{ success: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/merge`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["merge-requests", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-commits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-activity", projectId] });
    },
  });
}

/** Close a merge request — POST /v1/projects/:id/merge-requests/:mrId/close */
export function useCloseMR(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ mrId }: { mrId: string }) => {
      return gatewayFetch<{ success: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/close`,
        { method: "POST" },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["merge-requests", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-activity", projectId] });
    },
  });
}

// ─── Queries ───

/** Fetch merge requests — GET /v1/projects/:id/merge-requests?status= */
export function useMergeRequests(projectId: string, status?: string) {
  const qs = status ? `?status=${status}` : "";
  return useQuery<MergeRequest[]>({
    queryKey: ["merge-requests", projectId, status],
    queryFn: async () => {
      const data = await gatewayFetch<{ mergeRequests: MergeRequest[] }>(
        `/v1/projects/${encodeURIComponent(projectId)}/merge-requests${qs}`,
      );
      return data.mergeRequests ?? [];
    },
    enabled: !!projectId,
    staleTime: 120_000,
  });
}

/** Fetch merge request detail — GET /v1/projects/:id/merge-requests/:mrId */
export function useMergeRequestDetail(projectId: string, mrId: string) {
  return useQuery<MergeRequestDetail>({
    queryKey: ["merge-request-detail", projectId, mrId],
    queryFn: async () => {
      return gatewayFetch<MergeRequestDetail>(
        `/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}`,
      );
    },
    enabled: !!projectId && !!mrId,
    staleTime: 120_000,
  });
}
