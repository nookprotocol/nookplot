/**
 * TanStack Query hooks for the GitHub Knowledge System.
 *
 * Provides hooks for GitHub OAuth status, repo listing,
 * import, trending browse, claim, and README content.
 *
 * @module hooks/useGitHubKnowledge
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { isAuthenticated } from "@/lib/authSession";
import { GATEWAY_URL } from "@/config/constants";

// ---- Types ----

export interface GitHubRepo {
  fullName: string;
  owner: string;
  repo: string;
  description: string | null;
  stars: number;
  language: string | null;
  topics: string[];
  updatedAt: string | null;
}

export interface ImportResult {
  projectId: string;
  name: string;
  source: string;
  isNew: boolean;
}

export interface TrendingProject {
  project_id: string;
  name: string;
  description: string | null;
  github_owner: string;
  github_repo: string;
  github_stars: number;
  github_forks: number;
  github_topics: string[];
  github_is_archived: boolean;
  source: string;
  readme_snippet: string | null;
  languages: string[];
  tags: string[];
  license: string | null;
  github_pushed_at: string | null;
  created_at: string;
  search_category: string | null;
  creator_name: string | null;
  creator_address: string | null;
}

// ---- Hooks ----

/** Check if GitHub is connected for the current agent. */
export function useGitHubOAuthStatus() {
  return useQuery<{ connected: boolean; username?: string }>({
    queryKey: ["github-oauth-status"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/github/repos");
      if (res.status === 400) {
        return { connected: false };
      }
      const data = await res.json();
      return { connected: true, username: data.username };
    },
    enabled: isAuthenticated(),
    staleTime: 60_000,
  });
}

/** List user's GitHub repos (requires connected GitHub). */
export function useGitHubRepos() {
  return useQuery<{ repos: GitHubRepo[]; username: string }>({
    queryKey: ["github-repos"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/github/repos");
      return res.json();
    },
    enabled: isAuthenticated(),
    staleTime: 60_000,
  });
}

/** Import selected GitHub repos as projects. */
export function useImportRepos() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (repos: Array<{ owner: string; repo: string }>) => {
      const res = await gatewayFetch("/v1/github/import", {
        method: "POST",
        body: JSON.stringify({ repos }),
      });
      const data = await res.json();
      return data.results as ImportResult[];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["network-projects"] });
      queryClient.invalidateQueries({ queryKey: ["github-trending"] });
    },
  });
}

/** Browse auto-curated trending repos (public). */
export function useTrendingRepos(category?: string, page = 0) {
  const limit = 20;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(page * limit),
  });
  if (category) params.set("category", category);

  return useQuery<{ projects: TrendingProject[]; total: number }>({
    queryKey: ["github-trending", category ?? "all", page],
    queryFn: async () => {
      const res = await fetch(
        `${GATEWAY_URL}/v1/github/knowledge/trending?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });
}

/** Claim an unclaimed auto-curated project. */
export function useClaimProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      githubUsername,
    }: {
      projectId: string;
      githubUsername: string;
    }) => {
      const res = await gatewayFetch(
        `/v1/github/knowledge/${encodeURIComponent(projectId)}/claim`,
        {
          method: "POST",
          body: JSON.stringify({ githubUsername }),
        },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["github-trending"] });
      queryClient.invalidateQueries({ queryKey: ["project-detail"] });
    },
  });
}

/** Fetch README content for a GitHub-sourced project (public). */
export function useReadmeContent(projectId: string | undefined) {
  return useQuery<{ projectId: string; content: string }>({
    queryKey: ["github-readme", projectId],
    queryFn: async () => {
      const res = await fetch(
        `${GATEWAY_URL}/v1/github/knowledge/${encodeURIComponent(projectId!)}/readme`,
      );
      if (!res.ok) {
        if (res.status === 404) return { projectId: projectId!, content: "" };
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: !!projectId,
    staleTime: 300_000, // 5 min
  });
}

/** Start GitHub OAuth connection flow. */
export function useConnectGitHub() {
  return useMutation({
    mutationFn: async () => {
      const res = await gatewayFetch("/v1/github/connect-oauth", { method: "POST" });
      const data = await res.json();
      return data.redirectUrl as string;
    },
  });
}

/** Force re-sync a project's GitHub data. */
export function useSyncProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await gatewayFetch(
        `/v1/github/import/${encodeURIComponent(projectId)}/sync`,
        { method: "POST" },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-detail"] });
      queryClient.invalidateQueries({ queryKey: ["network-projects"] });
    },
  });
}
