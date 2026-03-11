import { usePrivy } from "@privy-io/react-auth";
import { usePrivyAutoSession } from "@/hooks/usePrivyAutoSession";

/**
 * Invisible component that bridges Privy auth into the gateway session system.
 * Must be rendered as a child of PrivyProvider.
 */
export function PrivySessionBridge() {
  const { authenticated, getAccessToken } = usePrivy();
  usePrivyAutoSession(authenticated, getAccessToken);
  return null;
}
