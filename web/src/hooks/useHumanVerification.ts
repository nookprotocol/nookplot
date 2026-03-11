import { useState, useCallback } from "react";
import { useSignMessage } from "wagmi";
import { GATEWAY_URL } from "@/config/constants";

/** Must match VERIFICATION_AUTH_MESSAGE in gateway/src/routes/humanVerification.ts */
const VERIFICATION_AUTH_MESSAGE = "Nookplot identity verification";

/** Session token storage key */
const SESSION_KEY = "nookplot-verify-session";
const CLAIM_KEY = "nookplot-verify-claim";

interface VerifyGitHubInitResponse {
  claimId: string;
  redirectUrl: string;
  sessionToken: string;
}

interface VerifyCompleteResponse {
  verified: boolean;
  claim: {
    id: string;
    platform: string;
    externalId: string;
    status: string;
  };
  tier: {
    tier: number;
    tierName: string;
    verifiedPlatforms: string[];
    expiresAt: string | null;
    daysUntilExpiry: number | null;
  };
}

export interface VerificationClaim {
  id: string;
  platform: string;
  externalId: string;
  status: string;
  verifiedAt: string | null;
  expiresAt: string | null;
  isExpired: boolean;
}

export function useHumanVerification() {
  const { signMessageAsync } = useSignMessage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Start GitHub verification: sign wallet message, create claim, redirect to GitHub OAuth.
   */
  const initiateGitHub = useCallback(
    async (address: string, githubUsername: string) => {
      setIsLoading(true);
      setError(null);

      try {
        // Sign authentication message
        const signature = await signMessageAsync({ message: VERIFICATION_AUTH_MESSAGE });

        // Call gateway to create claim and get OAuth URL
        const res = await fetch(`${GATEWAY_URL}/v1/verify/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, signature, githubUsername }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(body.error || `Failed: ${res.status}`);
        }

        const data: VerifyGitHubInitResponse = await res.json();

        // Store session token and claim ID for callback
        sessionStorage.setItem(SESSION_KEY, data.sessionToken);
        sessionStorage.setItem(CLAIM_KEY, data.claimId);

        // Validate redirect target before navigation (open redirect protection)
        const url = new URL(data.redirectUrl, window.location.origin);
        if (!["github.com", "www.github.com", "twitter.com", "api.twitter.com", "x.com"].includes(url.hostname) && url.origin !== window.location.origin) {
          throw new Error("Unexpected redirect target");
        }
        window.location.href = data.redirectUrl;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setIsLoading(false);
      }
    },
    [signMessageAsync],
  );

  /**
   * Complete GitHub verification after OAuth redirect.
   * Reads the session token from storage and sends the OAuth code.
   */
  const completeGitHub = useCallback(async (code: string): Promise<VerifyCompleteResponse | null> => {
    setIsLoading(true);
    setError(null);

    try {
      const sessionToken = sessionStorage.getItem(SESSION_KEY);
      if (!sessionToken) {
        throw new Error("Verification session expired. Please start again.");
      }

      const res = await fetch(`${GATEWAY_URL}/v1/verify/github/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken, code }),
      });

      // Clean up stored session
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(CLAIM_KEY);

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(body.error || `Failed: ${res.status}`);
      }

      const data: VerifyCompleteResponse = await res.json();
      setIsLoading(false);
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setIsLoading(false);
      return null;
    }
  }, []);

  /**
   * Check if we're returning from a GitHub OAuth redirect (code in URL params).
   */
  const getPendingOAuthCode = useCallback((): string | null => {
    const params = new URLSearchParams(window.location.search);
    return params.get("code");
  }, []);

  /**
   * Check if there's a stored session (mid-OAuth flow).
   */
  const hasPendingSession = useCallback((): boolean => {
    return !!sessionStorage.getItem(SESSION_KEY);
  }, []);

  /**
   * Fetch verified claims for an address.
   */
  const fetchClaims = useCallback(async (address: string): Promise<VerificationClaim[]> => {
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/verify/claims/${address}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.claims ?? [];
    } catch {
      return [];
    }
  }, []);

  return {
    initiateGitHub,
    completeGitHub,
    getPendingOAuthCode,
    hasPendingSession,
    fetchClaims,
    isLoading,
    error,
    clearError: () => setError(null),
  };
}
