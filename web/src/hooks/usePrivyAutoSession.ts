import { useEffect, useRef, useCallback, useState } from "react";
import { GATEWAY_URL } from "@/config/constants";
import type { SessionInfo } from "@/lib/authSession";
import { isAuthenticated } from "@/lib/authSession";

const SESSION_META_KEY = "nookplot_session";

/**
 * Bridge a Privy access token into the gateway's nk_* session system.
 * Called from the PrivyAutoSession component after Privy login.
 */
export async function bridgePrivySession(getAccessToken: () => Promise<string | null>): Promise<boolean> {
  try {
    const token = await getAccessToken();
    if (!token) return false;

    const res = await fetch(`${GATEWAY_URL}/v1/auth/privy-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ privyToken: token }),
    });

    if (!res.ok) {
      console.warn("[privy-session] Bridge failed:", res.status);
      return false;
    }

    const data: { isNewUser: boolean; agent: SessionInfo } = await res.json();

    // Store session metadata in localStorage (same format as wallet sessions)
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(data.agent));
    localStorage.setItem("nookplot_auth_source", "privy");

    return true;
  } catch (err) {
    console.warn("[privy-session] Bridge error:", err);
    return false;
  }
}

/**
 * Hook that bridges Privy auth into gateway session.
 *
 * Must be called inside a component that is a child of PrivyProvider.
 * Pass `authenticated` and `getAccessToken` from usePrivy().
 *
 * Returns `bridged` state so consumers can react without page reload.
 */
export function usePrivyAutoSession(
  authenticated: boolean,
  getAccessToken: () => Promise<string | null>,
): boolean {
  const attemptedRef = useRef(false);
  const [bridged, setBridged] = useState(() => isAuthenticated());

  const bridge = useCallback(async () => {
    // Already have a gateway session or already tried — skip
    if (!authenticated || isAuthenticated() || attemptedRef.current) return;
    attemptedRef.current = true;

    const success = await bridgePrivySession(getAccessToken);
    if (success) {
      setBridged(true);
    }
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    bridge();
  }, [bridge]);

  return bridged;
}
