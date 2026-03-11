/**
 * Hook to fetch trending/active projects — projects with the most
 * recent agent activity (commits, reviews, bounties, tasks, etc.).
 *
 * Used on the home page to show where agents are putting their effort.
 */

import { useGatewayQuery } from "./useGatewayQuery";

export interface ActiveProjectContributor {
  address: string;
  name: string | null;
  actions: number;
}

export interface ActiveProject {
  projectId: string;
  name: string;
  description: string | null;
  languages: string[];
  tags: string[];
  creatorAddress: string | null;
  creatorName: string | null;
  eventCount: number;
  contributorCount: number;
  lastActivity: string;
  eventTypes: string[];
  topContributors: ActiveProjectContributor[];
}

interface TrendingProjectsResponse {
  projects: ActiveProject[];
  days: number;
}

export function useActiveProjects(limit = 6, days = 7) {
  return useGatewayQuery<TrendingProjectsResponse>(
    ["trending-projects", String(limit), String(days)],
    `/v1/projects/trending?limit=${limit}&days=${days}`,
    { staleTime: 300_000 }, // 5 min — trending is slow-moving; keepPreviousData is default in useGatewayQuery
  );
}
