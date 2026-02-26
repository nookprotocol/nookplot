import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";

// ============================================================
//  Types
// ============================================================

export interface AgentDomain {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export interface VerificationInstructions {
  type: string;
  record: string;
  value: string;
  ttl: number;
}

// ============================================================
//  Hooks
// ============================================================

/**
 * Fetch and manage agent custom domains.
 */
export function useAgentDomains(apiKey: string | null) {
  const [domains, setDomains] = useState<AgentDomain[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    setIsLoading(true);
    try {
      const data = await gatewayFetch<{ domains: AgentDomain[] }>(
        "/v1/agents/me/domains",
        apiKey,
      );
      setDomains(data.domains);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { domains, isLoading, refresh };
}

/**
 * Register a new custom domain.
 */
export function useRegisterDomain(apiKey: string | null) {
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = useCallback(
    async (domain: string) => {
      if (!apiKey) return null;
      setIsRegistering(true);
      setError(null);
      try {
        const data = await gatewayFetch<{
          domain: AgentDomain;
          verificationInstructions: VerificationInstructions;
        }>("/v1/agents/me/domains", apiKey, {
          method: "POST",
          body: JSON.stringify({ domain }),
        });
        return data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return null;
      } finally {
        setIsRegistering(false);
      }
    },
    [apiKey],
  );

  return { register, isRegistering, error };
}

/**
 * Delete a domain registration.
 */
export function useDeleteDomain(apiKey: string | null) {
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteDomain = useCallback(
    async (domainId: string) => {
      if (!apiKey) return false;
      setIsDeleting(true);
      try {
        await gatewayFetch<{ deleted: boolean }>(
          `/v1/agents/me/domains/${domainId}`,
          apiKey,
          { method: "DELETE" },
        );
        return true;
      } catch {
        return false;
      } finally {
        setIsDeleting(false);
      }
    },
    [apiKey],
  );

  return { deleteDomain, isDeleting };
}

/**
 * Verify domain ownership via DNS TXT.
 */
export function useVerifyDomain(apiKey: string | null) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(
    async (domainId: string) => {
      if (!apiKey) return null;
      setIsVerifying(true);
      setError(null);
      try {
        const data = await gatewayFetch<{
          verified: boolean;
          domain?: string;
          error?: string;
          expected?: { host: string; value: string };
        }>(`/v1/agents/me/domains/${domainId}/verify`, apiKey, {
          method: "POST",
        });
        return data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return null;
      } finally {
        setIsVerifying(false);
      }
    },
    [apiKey],
  );

  return { verify, isVerifying, error };
}
