import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { querySubgraph } from "@/lib/subgraph";

export function useSubgraphQuery<T>(
  key: string[],
  query: string,
  variables?: Record<string, unknown>,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">,
) {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => querySubgraph<T>(query, variables),
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    ...options,
  });
}
