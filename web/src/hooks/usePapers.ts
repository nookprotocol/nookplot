/**
 * Paper and citation data fetching hooks.
 *
 * @module hooks/usePapers
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import type {
  PaperDetail,
  PapersPaginatedResponse,
  MostCitedResponse,
  IngestionStatus,
  CitationTreeResponse,
  CitationDetail,
  GlobalCitationGraphResponse,
  GlobalCitationNode,
  GlobalCitationEdge,
} from "@/lib/paperTypes";
import { extractGenre, genreColor } from "@/lib/genreColors";

/** Browse ingested papers with pagination + filters. */
export function usePapers(
  page = 1,
  limit = 20,
  category?: string,
  minQuality?: number,
  sort?: string,
) {
  const result = useQuery<PapersPaginatedResponse>({
    queryKey: ["papers", String(page), String(limit), category ?? "", String(minQuality ?? 0), sort ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (category) params.set("category", category);
      if (minQuality && minQuality > 0) params.set("minQuality", String(minQuality));
      if (sort) params.set("sort", sort);
      const res = await gatewayFetch(`/v1/ingestion/papers?${params}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  return {
    papers: result.data?.papers ?? [],
    pagination: result.data?.pagination ?? { page: 1, limit, total: 0, totalPages: 0 },
    isLoading: result.isLoading,
  };
}

/** Fetch a single paper by arXiv ID. */
export function usePaperDetail(arxivId: string | undefined) {
  const result = useQuery<PaperDetail>({
    queryKey: ["paper-detail", arxivId ?? ""],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/ingestion/papers/${encodeURIComponent(arxivId!)}`);
      return res.json();
    },
    enabled: !!arxivId,
    staleTime: 60_000,
  });

  return {
    paper: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/** Fetch most-cited papers. */
export function useMostCited(limit = 20, community?: string) {
  const result = useQuery<MostCitedResponse>({
    queryKey: ["most-cited", String(limit), community ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (community) params.set("community", community);
      const res = await gatewayFetch(`/v1/citations/most-cited?${params}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  return {
    papers: result.data?.papers ?? [],
    isLoading: result.isLoading,
  };
}

/** Fetch ingestion status overview. */
export function useIngestionStatus() {
  const result = useQuery<IngestionStatus>({
    queryKey: ["ingestion-status"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/ingestion/status");
      return res.json();
    },
    staleTime: 60_000,
  });

  return {
    status: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/** Fetch citation tree for a content CID. */
export function useCitationTree(
  cid: string | undefined | null,
  depth = 3,
  direction: "outbound" | "inbound" | "both" = "both",
) {
  const result = useQuery<CitationTreeResponse>({
    queryKey: ["citation-tree", cid ?? "", String(depth), direction],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("depth", String(depth));
      params.set("direction", direction);
      const res = await gatewayFetch(`/v1/citations/${encodeURIComponent(cid!)}/tree?${params}`);
      return res.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });

  return {
    tree: result.data?.tree ?? null,
    isLoading: result.isLoading,
  };
}

/** Fetch citation detail (inbound + outbound) for a content CID. */
export function useCitationDetail(cid: string | undefined | null) {
  const result = useQuery<CitationDetail>({
    queryKey: ["citation-detail", cid ?? ""],
    queryFn: async () => {
      const res = await gatewayFetch(`/v1/citations/${encodeURIComponent(cid!)}`);
      return res.json();
    },
    enabled: !!cid,
    staleTime: 60_000,
  });

  return {
    citations: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/** Fetch global citation graph (all papers + all resolved citation edges). */
export function useGlobalCitationGraph() {
  const result = useQuery<GlobalCitationGraphResponse>({
    queryKey: ["global-citation-graph"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/citations/graph");
      return res.json();
    },
    staleTime: 120_000,
  });

  const nodes: GlobalCitationNode[] = useMemo(() => {
    if (!result.data?.nodes) return [];
    return result.data.nodes.map((n) => {
      const genre = extractGenre(n.categories);
      return {
        ...n,
        genre,
        color: genreColor(genre),
        radius: Math.max(4, Math.log2((n.citationCount || 0) + 1) * 2.5),
      };
    });
  }, [result.data]);

  const edges: GlobalCitationEdge[] = useMemo(
    () => result.data?.edges ?? [],
    [result.data],
  );

  return {
    nodes,
    edges,
    meta: result.data?.meta ?? null,
    isLoading: result.isLoading,
  };
}

/** Format authors for display — first 3 + "et al." */
export function formatAuthors(authors: string[]): string {
  if (!authors || authors.length === 0) return "Unknown";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

/** Extract year from published_date. */
export function extractYear(dateStr: string | null): string {
  if (!dateStr) return "—";
  const year = new Date(dateStr).getFullYear();
  return isNaN(year) ? "—" : String(year);
}
