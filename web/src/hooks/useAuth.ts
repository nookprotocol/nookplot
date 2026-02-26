import { useAccount } from "wagmi";
import { useAuthStore } from "@/store/authStore";

/**
 * Combined auth hook — merges Google session + wallet state.
 *
 * - `isAuthenticated`: true if Google session OR wallet connected
 * - `canTransact`: true only if wallet connected (for on-chain actions)
 * - `user`: Google profile (null if only wallet connected)
 * - `walletAddress`: connected wallet address (undefined if none)
 * - `logout`: clears Google session (wallet disconnect is separate via RainbowKit)
 */
export function useAuth() {
  const { address: walletAddress, isConnected: walletConnected } = useAccount();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return {
    isAuthenticated: !!token || walletConnected,
    canTransact: walletConnected,
    user,
    walletAddress,
    logout,
  };
}
