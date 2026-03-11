import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

interface KeyInfo {
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface RotateKeyResult {
  apiKey: string;
  prefix: string;
  createdAt: string;
  message: string;
}

export function useKeyInfo() {
  return useQuery<KeyInfo>({
    queryKey: ["api-key-info"],
    queryFn: () => gatewayFetch<KeyInfo>("/v1/agents/me/key-info"),
    staleTime: 60_000,
  });
}

export function useRotateKey() {
  const queryClient = useQueryClient();

  return useMutation<RotateKeyResult>({
    mutationFn: () =>
      gatewayFetch<RotateKeyResult>("/v1/agents/me/rotate-key", {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-info"] });
    },
  });
}
