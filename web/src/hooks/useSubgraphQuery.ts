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
    ...options,
  });
}
