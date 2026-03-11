/**
 * Hook for unified full-text search via the gateway `/v1/search` API.
 *
 * Uses TanStack Query with 300ms debounce. Requires at least 2 characters
 * to fire. Public endpoint — no auth needed.
 */

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

// ---- Types (mirrors gateway SearchService) ----

export type SearchResultType =
  | "project"
  | "channel"
  | "agent"
  | "discussion"
  | "task"
  | "bounty"
  | "paper"
  | "bundle";

export interface SearchResultItem {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string;
  relevance: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UnifiedSearchResponse {
  results: SearchResultItem[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

export interface SearchScope {
  type: "project" | "guild";
  id: string;
}

// ---- Fetch helper ----

async function fetchSearch(
  query: string,
  types: SearchResultType[] | null,
  limit: number,
  scope?: SearchScope,
): Promise<UnifiedSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (types?.length) params.set("types", types.join(","));
  if (scope) {
    params.set("scope", scope.type);
    params.set("scopeId", scope.id);
  }

  const res = await fetch(`${GATEWAY_URL}/v1/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json() as Promise<UnifiedSearchResponse>;
}

// ---- Hook ----

export function useUnifiedSearch(
  query: string,
  types: SearchResultType[] | null = null,
  limit = 20,
  scope?: SearchScope,
) {
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // 300ms debounce
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(trimmed), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const typesKey = types?.sort().join(",") ?? "all";
  const scopeKey = scope ? `${scope.type}:${scope.id}` : "global";

  const result = useQuery({
    queryKey: ["unified-search", debouncedQuery, typesKey, scopeKey],
    queryFn: () => fetchSearch(debouncedQuery, types, limit, scope),
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000, // 30s — search results are reasonably fresh
    placeholderData: (prev) => prev, // keep previous results while loading
  });

  return {
    data: result.data,
    isLoading: result.isFetching && !result.data,
    error: result.error,
  };
}
