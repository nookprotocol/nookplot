/**
 * Hooks for gateway-hosted file operations, commit history, and code reviews.
 *
 * @module hooks/useProjectFiles
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";
import { getApiKey } from "@/hooks/useSandboxFiles";

// ─── Types ───

export interface GatewayFileEntry {
  path: string;
  size: number;
  language: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface GatewayFileContent {
  path: string;
  content: string;
  size: number;
  language: string | null;
  sha256: string;
  updatedAt: string;
}

export interface FileCommit {
  commitId: string;
  projectId: string;
  authorAddress: string | null;
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
}

export interface FileCommitChange {
  filePath: string;
  changeType: string;
  linesAdded: number;
  linesRemoved: number;
  oldContent: string | null;
  newContent: string | null;
}

export interface CommitReview {
  id: string;
  reviewerAddress: string | null;
  reviewerName: string | null;
  verdict: string;
  body: string | null;
  createdAt: string;
}

export interface FileCommitDetail extends FileCommit {
  changes: FileCommitChange[];
  reviews: CommitReview[];
}

export interface ProjectActivityEvent {
  id: string;
  projectId: string;
  projectName: string | null;
  eventType: string;
  actorAddress: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ─── File Queries ───

export function useProjectFiles(projectId: string) {
  return useQuery<GatewayFileEntry[]>({
    queryKey: ["project-gateway-files", projectId],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      const data = await gatewayFetch<{ files: GatewayFileEntry[] }>(
        `/v1/projects/${encodeURIComponent(projectId)}/gateway-files`,
        apiKey,
      );
      return data.files ?? [];
    },
    enabled: !!projectId && !!getApiKey(),
    staleTime: 60_000,
  });
}

export function useProjectFile(projectId: string, filePath: string) {
  return useQuery<GatewayFileContent>({
    queryKey: ["project-gateway-file", projectId, filePath],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      return gatewayFetch<GatewayFileContent>(
        `/v1/projects/${encodeURIComponent(projectId)}/gateway-files/${filePath}`,
        apiKey,
      );
    },
    enabled: !!projectId && !!filePath && !!getApiKey(),
    staleTime: 60_000,
  });
}

// ─── Commit Queries ───

export function useProjectCommits(projectId: string, limit = 20) {
  return useQuery<FileCommit[]>({
    queryKey: ["project-commits", projectId, limit],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      const data = await gatewayFetch<{ commits: FileCommit[] }>(
        `/v1/projects/${encodeURIComponent(projectId)}/commits?limit=${limit}`,
        apiKey,
      );
      return data.commits ?? [];
    },
    enabled: !!projectId && !!getApiKey(),
    staleTime: 60_000,
  });
}

export function useCommitDetail(projectId: string, commitId: string) {
  return useQuery<FileCommitDetail>({
    queryKey: ["commit-detail", projectId, commitId],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      return gatewayFetch<FileCommitDetail>(
        `/v1/projects/${encodeURIComponent(projectId)}/commits/${encodeURIComponent(commitId)}`,
        apiKey,
      );
    },
    enabled: !!projectId && !!commitId && !!getApiKey(),
    staleTime: 60_000,
  });
}

// ─── Review Queries ───

export function useCommitReviews(projectId: string, commitId: string) {
  return useQuery<CommitReview[]>({
    queryKey: ["commit-reviews", projectId, commitId],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      const data = await gatewayFetch<{ reviews: CommitReview[] }>(
        `/v1/projects/${encodeURIComponent(projectId)}/commits/${encodeURIComponent(commitId)}/reviews`,
        apiKey,
      );
      return data.reviews ?? [];
    },
    enabled: !!projectId && !!commitId && !!getApiKey(),
    staleTime: 60_000,
  });
}

// ─── Activity Queries ───

export function useProjectActivity(projectId: string, limit = 20) {
  return useQuery<ProjectActivityEvent[]>({
    queryKey: ["project-activity", projectId, limit],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      const data = await gatewayFetch<{ activity: ProjectActivityEvent[] }>(
        `/v1/projects/${encodeURIComponent(projectId)}/activity?limit=${limit}`,
        apiKey,
      );
      return data.activity ?? [];
    },
    enabled: !!projectId && !!getApiKey(),
    staleTime: 60_000,
  });
}

/** Global project activity (for merging into the main feed). */
export function useGatewayActivity(limit = 20) {
  return useQuery<ProjectActivityEvent[]>({
    queryKey: ["gateway-activity", limit],
    queryFn: async () => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      const data = await gatewayFetch<{ activity: ProjectActivityEvent[] }>(
        `/v1/activity?limit=${limit}`,
        apiKey,
      );
      return data.activity ?? [];
    },
    enabled: !!getApiKey(),
    staleTime: 30_000,
  });
}

// ─── Mutations ───

export function useCommitFiles(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { files: { path: string; content: string | null }[]; message: string }) => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      return gatewayFetch<Record<string, unknown>>(
        `/v1/projects/${encodeURIComponent(projectId)}/gateway-commit`,
        apiKey,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-gateway-files", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-commits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-activity", projectId] });
    },
  });
}

export function useSubmitReview(projectId: string, commitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { verdict: string; body?: string }) => {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error("No API key");
      return gatewayFetch<Record<string, unknown>>(
        `/v1/projects/${encodeURIComponent(projectId)}/commits/${encodeURIComponent(commitId)}/review`,
        apiKey,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commit-reviews", projectId, commitId] });
      queryClient.invalidateQueries({ queryKey: ["commit-detail", projectId, commitId] });
      queryClient.invalidateQueries({ queryKey: ["project-commits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project-activity", projectId] });
    },
  });
}
