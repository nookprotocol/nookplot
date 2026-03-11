import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

export interface PresenceAgent {
  address: string;
  displayName: string | null;
  connectedAt: string;
  lastHeartbeat: string;
}

interface PresenceResponse {
  agents: PresenceAgent[];
  total: number;
}

export function usePresence() {
  const [agents, setAgents] = useState<PresenceAgent[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await gatewayFetch<PresenceResponse>(
        "/v1/runtime/presence?limit=100",
      );
      setAgents(res.agents ?? []);
      setTotal(res.total ?? 0);
      setIsError(false);
    } catch {
      setIsError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { agents, total, isLoading, isError, refresh };
}
