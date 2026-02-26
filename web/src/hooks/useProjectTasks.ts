/**
 * TanStack Query hooks for project tasks, milestones, and broadcasts.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, getApiKey } from "@/hooks/useSandboxFiles";

// ─── Types ───

export interface ProjectTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  milestoneId: string | null;
  milestoneTitle: string | null;
  assignedAddress: string | null;
  assigneeName: string | null;
  creatorAddress: string | null;
  creatorName: string | null;
  linkedCommitId: string | null;
  labels: string[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends ProjectTask {
  comments: TaskComment[];
}

export interface TaskComment {
  id: string;
  body: string;
  authorAddress: string;
  authorName: string | null;
  createdAt: string;
}

export interface ProjectMilestone {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: string;
  completedAt: string | null;
  totalTasks: number;
  completedTasks: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBroadcast {
  id: string;
  type: string;
  body: string;
  mentions: string[];
  metadata: Record<string, unknown>;
  authorAddress: string;
  authorName: string | null;
  createdAt: string;
}

export interface CollaboratorStatus {
  address: string;
  displayName: string | null;
  status: string;
  updatedAt: string;
}

// ─── Task Hooks ───

export function useProjectTasks(
  projectId: string,
  filters?: { status?: string; priority?: string; assignee?: string; milestone?: string },
) {
  const apiKey = getApiKey();

  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.assignee) params.set("assignee", filters.assignee);
  if (filters?.milestone) params.set("milestone", filters.milestone);
  const qs = params.toString() ? `?${params}` : "";

  return useQuery<ProjectTask[]>({
    queryKey: ["projectTasks", projectId, filters],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/tasks${qs}`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
      const data = await res.json();
      return data.tasks;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}

export function useTaskDetail(projectId: string, taskId: string | null) {
  const apiKey = getApiKey();
  return useQuery<TaskDetail>({
    queryKey: ["taskDetail", projectId, taskId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/tasks/${taskId}`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch task: ${res.status}`);
      return res.json();
    },
    enabled: !!apiKey && !!taskId,
    staleTime: 30_000,
  });
}

export function useCreateTask(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title: string; description?: string; milestoneId?: string; priority?: string; labels?: string[] }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projectTasks", projectId] }); },
  });
}

export function useUpdateTask(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, ...body }: { taskId: string; status?: string; priority?: string; title?: string; description?: string; milestoneId?: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to update task: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectTasks", projectId] });
      qc.invalidateQueries({ queryKey: ["projectMilestones", projectId] });
    },
  });
}

export function useAssignTask(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, assigneeAddress }: { taskId: string; assigneeAddress: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/tasks/${taskId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeAddress }),
      });
      if (!res.ok) throw new Error(`Failed to assign task: ${res.status}`);
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projectTasks", projectId] }); },
  });
}

export function useAddTaskComment(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, body }: { taskId: string; body: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["taskDetail", projectId, vars.taskId] });
    },
  });
}

// ─── Milestone Hooks ───

export function useProjectMilestones(projectId: string) {
  const apiKey = getApiKey();
  return useQuery<ProjectMilestone[]>({
    queryKey: ["projectMilestones", projectId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/milestones`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch milestones: ${res.status}`);
      const data = await res.json();
      return data.milestones;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}

export function useCreateMilestone(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title: string; description?: string; dueDate?: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to create milestone: ${res.status}`);
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projectMilestones", projectId] }); },
  });
}

// ─── Broadcast Hooks ───

export function useProjectBroadcasts(projectId: string) {
  const apiKey = getApiKey();
  return useQuery<ProjectBroadcast[]>({
    queryKey: ["projectBroadcasts", projectId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/broadcasts`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch broadcasts: ${res.status}`);
      const data = await res.json();
      return data.broadcasts;
    },
    enabled: !!apiKey,
    staleTime: 30_000,
  });
}

export function usePostBroadcast(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { body: string; type?: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/broadcasts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to post broadcast: ${res.status}`);
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projectBroadcasts", projectId] }); },
  });
}

// ─── Status Hooks ───

export function useProjectStatuses(projectId: string) {
  const apiKey = getApiKey();
  return useQuery<CollaboratorStatus[]>({
    queryKey: ["projectStatuses", projectId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/status`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch statuses: ${res.status}`);
      const data = await res.json();
      return data.statuses;
    },
    enabled: !!apiKey,
    staleTime: 60_000,
  });
}

// ─── Review Comments Hooks ───

export interface ReviewComment {
  id: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  suggestion: string | null;
  suggestionApplied: boolean;
  resolved: boolean;
  authorAddress: string;
  authorName: string | null;
  reviewId: string | null;
  createdAt: string;
}

export function useCommitComments(projectId: string, commitId: string | null) {
  const apiKey = getApiKey();
  return useQuery<ReviewComment[]>({
    queryKey: ["commitComments", projectId, commitId],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/commits/${commitId}/comments`, {
        headers: {},
      });
      if (!res.ok) throw new Error(`Failed to fetch comments: ${res.status}`);
      const data = await res.json();
      return data.comments;
    },
    enabled: !!apiKey && !!commitId,
    staleTime: 30_000,
  });
}

export function useAddReviewComment(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { commitId: string; filePath: string; lineStart?: number; lineEnd?: number; body: string; suggestion?: string }) => {
      const { commitId, ...rest } = body;
      const res = await gatewayFetch(`/v1/projects/${projectId}/commits/${commitId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["commitComments", projectId, vars.commitId] });
    },
  });
}

export function useApplySuggestion(projectId: string) {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ commitId, commentId }: { commitId: string; commentId: string }) => {
      const res = await gatewayFetch(`/v1/projects/${projectId}/commits/${commitId}/apply-suggestion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentId }),
      });
      if (!res.ok) throw new Error(`Failed to apply suggestion: ${res.status}`);
      return res.json();
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["commitComments", projectId, vars.commitId] });
      qc.invalidateQueries({ queryKey: ["projectCommits", projectId] });
    },
  });
}
