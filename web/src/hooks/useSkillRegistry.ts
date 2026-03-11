/**
 * TanStack Query hooks for the community skill registry.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";
import { gatewayFetch } from "./useSandboxFiles";

/* ---------- Types ---------- */

export interface SkillPackage {
  id: string;
  publisher_id: string;
  publisher_address: string;
  name: string;
  slug: string;
  description: string;
  package_type: string;
  github_url: string | null;
  npm_package: string | null;
  install_command: string | null;
  version: string;
  tags: string[];
  category: string | null;
  content: string | null;
  source_bundle_id: number | null;
  status: string;
  install_count: number;
  rating_count: number;
  rating_avg: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SkillReview {
  id: string;
  skill_id: string;
  reviewer_id: string;
  reviewer_name?: string;
  rating: number;
  review: string | null;
  created_at: string;
}

/* ---------- Helpers ---------- */

async function gatewayJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await gatewayFetch(path, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json() as Promise<T>;
}

/* ---------- List / search ---------- */

export function useSkillRegistryList(
  q = "",
  category = "",
  packageType = "",
  sort = "trending",
  page = 0,
  pageSize = 20,
) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  if (packageType) params.set("package_type", packageType);
  if (sort) params.set("sort", sort);
  params.set("limit", String(pageSize));
  params.set("offset", String(page * pageSize));

  const result = useGatewayQuery<{ skills: SkillPackage[]; total: number }>(
    ["skill-registry", q, category, packageType, sort, String(page)],
    `/v1/skills/registry?${params}`,
    { staleTime: 60_000 },
  );

  return {
    skills: result.data?.skills ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
  };
}

/* ---------- Trending ---------- */

export function useSkillRegistryTrending(limit = 6) {
  const result = useGatewayQuery<{ skills: SkillPackage[] }>(
    ["skill-registry-trending", String(limit)],
    `/v1/skills/registry/trending?limit=${limit}`,
    { staleTime: 60_000 },
  );

  return {
    skills: result.data?.skills ?? [],
    isLoading: result.isLoading,
  };
}

/* ---------- Detail by ID ---------- */

export function useSkillRegistryDetail(id: string | undefined) {
  const result = useGatewayQuery<SkillPackage>(
    ["skill-registry-detail", id ?? ""],
    `/v1/skills/registry/${id}`,
    { enabled: !!id, staleTime: 30_000 },
  );

  return {
    skill: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/* ---------- Detail by slug ---------- */

export function useSkillRegistryBySlug(slug: string | undefined) {
  const result = useGatewayQuery<SkillPackage>(
    ["skill-registry-slug", slug ?? ""],
    `/v1/skills/registry/by-slug/${slug}`,
    { enabled: !!slug, staleTime: 30_000 },
  );

  return {
    skill: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/* ---------- Reviews ---------- */

export function useSkillRegistryReviews(
  skillId: string | undefined,
  limit = 20,
  offset = 0,
) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const result = useGatewayQuery<{ reviews: SkillReview[]; total: number }>(
    ["skill-registry-reviews", skillId ?? "", String(limit), String(offset)],
    `/v1/skills/registry/${skillId}/reviews?${params}`,
    { enabled: !!skillId, staleTime: 30_000 },
  );

  return {
    reviews: result.data?.reviews ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
  };
}

/* ---------- Publish skill (mutation) ---------- */

export function usePublishSkill() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      packageType: string;
      githubUrl?: string;
      npmPackage?: string;
      installCommand?: string;
      version?: string;
      tags?: string[];
      category?: string;
      content?: string;
      sourceBundleId?: number;
      metadata?: Record<string, unknown>;
    }) => gatewayJson<SkillPackage>("POST", "/v1/skills/registry", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skill-registry"] });
      qc.invalidateQueries({ queryKey: ["skill-registry-trending"] });
    },
  });

  return {
    publishSkill: mutation.mutate,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    error: mutation.error,
  };
}

/* ---------- Review skill (mutation) ---------- */

export function useReviewSkill(skillId: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: { rating: number; review?: string }) =>
      gatewayJson<SkillReview>("POST", `/v1/skills/registry/${skillId}/review`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skill-registry-reviews", skillId] });
      qc.invalidateQueries({ queryKey: ["skill-registry-detail", skillId] });
    },
  });

  return {
    reviewSkill: mutation.mutate,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    error: mutation.error,
  };
}

/* ---------- Install skill (mutation) ---------- */

export function useInstallSkill(skillId: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      gatewayJson<{ success: boolean }>("POST", `/v1/skills/registry/${skillId}/install`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skill-registry-detail", skillId] });
      qc.invalidateQueries({ queryKey: ["skill-registry-trending"] });
    },
  });

  return {
    installSkill: mutation.mutate,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    error: mutation.error,
  };
}
