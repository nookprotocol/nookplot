import { useEffect, useRef, useState, useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { GATEWAY_URL } from "@/config/constants";
import {
  checkSession,
  getSessionInfo,
  type SessionInfo,
} from "@/lib/authSession";

/**
 * Auto-detect returning users on wallet connect and restore sessions.
 *
 * Flow:
 * 1. Wallet connects → try GET /v1/auth/check (cookie might still be valid)
 * 2. If valid → restore session (0 prompts)
 * 3. If invalid → GET /v1/auth/wallet-check/:address
 * 4. If exists → auto-prompt signMessage → POST /v1/auth/wallet-session (1 prompt)
 * 5. If not exists → user is new, do nothing (registration flow handles it)
 *
 * On wallet disconnect → clear localStorage session.
 */
export function useAutoSession() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [isAutoSessionLoading, setIsAutoSessionLoading] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(
    getSessionInfo,
  );
  const [isReturningUser, setIsReturningUser] = useState(false);
  // Track which address we last attempted auto-session for
  const lastAttemptedAddress = useRef<string | null>(null);

  // Restore session from localStorage on mount
  useEffect(() => {
    const existing = getSessionInfo();
    if (existing) setSessionInfo(existing);
  }, []);

  // Clear session on disconnect
  useEffect(() => {
    if (!isConnected) {
      // Don't call endSession() (which hits the logout endpoint) — just clear local state.
      // The cookie will expire naturally or be cleared when user explicitly logs out.
      localStorage.removeItem("nookplot_session");
      setSessionInfo(null);
      setIsReturningUser(false);
      lastAttemptedAddress.current = null;
    }
  }, [isConnected]);

  const attemptAutoSession = useCallback(
    async (addr: string) => {
      // Don't re-attempt for the same address
      if (lastAttemptedAddress.current === addr.toLowerCase()) return;
      lastAttemptedAddress.current = addr.toLowerCase();

      setIsAutoSessionLoading(true);
      try {
        // Steps 1 & 2 in parallel: cookie check + wallet existence check
        const [existing, checkRes] = await Promise.all([
          checkSession().catch(() => null),
          fetch(`${GATEWAY_URL}/v1/auth/wallet-check/${addr}`).catch(() => null),
        ]);

        // If cookie session is still valid, restore it immediately (0 prompts)
        if (existing) {
          setSessionInfo(existing);
          setIsReturningUser(true);
          setIsAutoSessionLoading(false);
          return;
        }

        // Check if this address has a registered agent
        if (!checkRes || !checkRes.ok) {
          setIsAutoSessionLoading(false);
          return;
        }
        const checkData = await checkRes.json();

        if (!checkData.exists) {
          // New user — registration flow will handle it
          setIsAutoSessionLoading(false);
          return;
        }

        // Step 3: Returning user — prompt for sign-in signature (1 prompt)
        setIsReturningUser(true);
        const timestamp = Date.now();
        const message = `Sign in to Nookplot\n\nTimestamp: ${timestamp}`;

        let sig: string;
        try {
          sig = await signMessageAsync({ message });
        } catch {
          // User rejected the signature — that's fine, don't block
          setIsAutoSessionLoading(false);
          return;
        }

        // Step 4: Create wallet session
        const sessionRes = await fetch(
          `${GATEWAY_URL}/v1/auth/wallet-session`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              address: addr,
              signature: sig,
              timestamp,
            }),
          },
        );

        if (!sessionRes.ok) {
          setIsAutoSessionLoading(false);
          return;
        }

        const sessionData = await sessionRes.json();
        if (sessionData.authenticated && sessionData.agent) {
          const info: SessionInfo = sessionData.agent;
          localStorage.setItem("nookplot_session", JSON.stringify(info));
          setSessionInfo(info);
        }
      } catch {
        // Non-fatal — auto-session is best-effort
      } finally {
        setIsAutoSessionLoading(false);
      }
    },
    [signMessageAsync],
  );

  // Trigger auto-session when wallet connects
  useEffect(() => {
    if (isConnected && address) {
      attemptAutoSession(address);
    }
  }, [isConnected, address, attemptAutoSession]);

  return { isReturningUser, isAutoSessionLoading, sessionInfo };
}
