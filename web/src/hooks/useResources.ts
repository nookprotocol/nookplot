/**
 * Knowledge resource data fetching hooks.
 *
 * @module hooks/useResources
 */

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import type {
  ResourcesPaginatedResponse,
  ResourceStats,
  MostCitedResponse,
  Resource,
  SubmitResourceResponse,
  FacultyCount,
  FacultyBundle,
  ResourceCitationsResponse,
} from "@/lib/resourceTypes";

/** Browse knowledge resources with pagination + filters. */
export function useResources(
  page = 1,
  limit = 20,
  sourceType?: string,
  minQuality?: number,
  sort?: string,
  search?: string,
  faculty?: string,
) {
  const result = useQuery<ResourcesPaginatedResponse>({
    queryKey: ["resources", String(page), String(limit), sourceType ?? "", String(minQuality ?? 0), sort ?? "", search ?? "", faculty ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (sourceType) params.set("sourceType", sourceType);
      if (minQuality && minQuality > 0) params.set("minQuality", String(minQuality));
      if (sort) params.set("sort", sort);
      if (search) params.set("search", search);
      if (faculty) params.set("faculty", faculty);
      const res = await gatewayFetch(`/v1/resources?${params}`);
      return res.json();
    },
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });

  return {
    resources: result.data?.resources ?? [],
    pagination: result.data?.pagination ?? { page: 1, limit, total: 0, totalPages: 0 },
    isLoading: result.isLoading,
  };
}

/** Fetch resource stats. */
export function useResourceStats() {
  const result = useQuery<ResourceStats>({
    queryKey: ["resource-stats"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/resources/stats");
      return res.json();
    },
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });

  return {
    stats: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/** Fetch most-cited resources. */
export function useMostCitedResources(limit = 20, sourceType?: string) {
  const result = useQuery<MostCitedResponse>({
    queryKey: ["resources-most-cited", String(limit), sourceType ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (sourceType) params.set("sourceType", sourceType);
      const res = await gatewayFetch(`/v1/resources/most-cited?${params}`);
      return res.json();
    },
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });

  return {
    resources: result.data?.resources ?? [],
    isLoading: result.isLoading,
  };
}

/** Fetch a single resource by ID. */
export function useResourceDetail(id: string | undefined) {
  const result = useQuery<Resource>({
    queryKey: ["resource-detail", id ?? ""],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/resources/${id}`);
      return res.json();
    },
    enabled: !!id,
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });

  return {
    resource: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/** Fetch citations for a resource. */
export function useResourceCitations(id: string | undefined, page = 1, limit = 20) {
  const result = useQuery<ResourceCitationsResponse>({
    queryKey: ["resource-citations", id ?? "", String(page), String(limit)],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      const res = await gatewayFetch(`/v1/resources/${id}/citations?${params}`);
      return res.json();
    },
    enabled: !!id,
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });

  return {
    citations: result.data?.citations ?? [],
    pagination: result.data?.pagination ?? { page: 1, limit, total: 0, totalPages: 0 },
    isLoading: result.isLoading,
  };
}

/** Submit a new knowledge resource. */
export function useSubmitResource() {
  const queryClient = useQueryClient();

  return useMutation<SubmitResourceResponse, Error, { sourceType: string; identifier: string }>({
    mutationFn: async ({ sourceType, identifier }) => {
      const res = await gatewayFetch("/v1/resources/submit", {
        method: "POST",
        body: JSON.stringify({ sourceType, identifier }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Failed to submit resource");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      queryClient.invalidateQueries({ queryKey: ["resource-stats"] });
    },
  });
}

/** Fetch faculty taxonomy with counts. */
export function useFaculties() {
  const result = useQuery<{ faculties: FacultyCount[]; count: number }>({
    queryKey: ["faculties"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/resources/faculties");
      return res.json();
    },
    staleTime: 600_000,
    placeholderData: keepPreviousData,
  });

  return {
    faculties: result.data?.faculties ?? [],
    isLoading: result.isLoading,
  };
}

/** Fetch all auto-curated faculty bundles. */
export function useFacultyBundles() {
  const result = useQuery<{ bundles: FacultyBundle[]; count: number }>({
    queryKey: ["faculty-bundles"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/resources/faculty-bundles");
      return res.json();
    },
    staleTime: 600_000,
    placeholderData: keepPreviousData,
  });

  return {
    bundles: result.data?.bundles ?? [],
    isLoading: result.isLoading,
  };
}

/** Fetch a single faculty bundle detail. */
export function useFacultyBundle(faculty: string | undefined) {
  const result = useQuery<FacultyBundle>({
    queryKey: ["faculty-bundle", faculty ?? ""],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/resources/faculty-bundles/${faculty}`);
      return res.json();
    },
    enabled: !!faculty,
    staleTime: 600_000,
    placeholderData: keepPreviousData,
  });

  return {
    bundle: result.data ?? null,
    isLoading: result.isLoading,
  };
}
