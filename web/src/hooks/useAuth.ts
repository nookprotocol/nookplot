import { useAccount } from "wagmi";
import { useAuthStore } from "@/store/authStore";
import { isAuthenticated as hasSession, getSessionInfo } from "@/lib/authSession";

/**
 * Combined auth hook — merges Google session + wallet state + cookie session + Privy.
 *
 * - `isAuthenticated`: true if any auth source is active
 * - `canTransact`: true only if wallet connected (for on-chain actions)
 * - `isPrivyUser`: true if the current session was created via Privy
 * - `user`: Google/Twitter profile (null if only wallet connected)
 * - `walletAddress`: connected wallet address (undefined if none)
 * - `sessionInfo`: cookie-based session metadata (agentId, address, displayName)
 * - `logout`: clears Google session (wallet disconnect is separate via RainbowKit)
 */
export function useAuth() {
  const { address: walletAddress, isConnected: walletConnected } = useAccount();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const sessionInfo = getSessionInfo();
  const isPrivyUser = typeof window !== "undefined"
    && localStorage.getItem("nookplot_auth_source") === "privy";

  return {
    isAuthenticated: !!token || walletConnected || hasSession(),
    canTransact: walletConnected,
    isPrivyUser,
    user,
    walletAddress,
    sessionInfo,
    logout,
  };
}
