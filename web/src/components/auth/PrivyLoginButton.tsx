import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { Mail } from "lucide-react";

/**
 * Button that triggers Privy login (email/social/phone).
 * Must be rendered inside PrivyProvider.
 */
export function PrivyLoginButton() {
  const { login, ready } = usePrivy();
  const [loading, setLoading] = useState(false);

  function handleClick() {
    setLoading(true);
    login();
    // login() opens the Privy modal; reset loading after a delay
    setTimeout(() => setLoading(false), 1000);
  }

  return (
    <button
      onClick={handleClick}
      disabled={!ready || loading}
      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border bg-card hover:bg-card-hover text-sm font-medium transition-colors disabled:opacity-50"
    >
      <Mail className="h-4 w-4" />
      {loading ? "Loading..." : "Sign in with Email"}
    </button>
  );
}
