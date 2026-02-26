import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";

/**
 * OAuth callback handler page.
 *
 * Reads the JWT token and provider from the URL fragment (set by the gateway
 * after Twitter OAuth redirect), saves the token to sessionStorage, hydrates
 * the auth store, and redirects to the homepage.
 *
 * Fragment-based token delivery ensures the token is never sent to servers
 * in access logs or referrer headers.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for error in query params (gateway sends errors via ?error=)
    const queryError = searchParams.get("error");
    if (queryError) {
      setError(errorMessage(queryError));
      return;
    }

    // Parse token from URL fragment (#token=xxx&provider=twitter)
    const hash = window.location.hash.slice(1); // remove leading #
    const params = new URLSearchParams(hash);
    const token = params.get("token");

    if (!token) {
      setError("No authentication token received.");
      return;
    }

    // Save token and restore session (sessionStorage — clears on browser close)
    sessionStorage.setItem("nookplot-auth-token", token);
    restoreSession();

    // Clean up the URL and redirect to home
    navigate("/", { replace: true });
  }, [searchParams, restoreSession, navigate]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-4">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={() => navigate("/register", { replace: true })}
          className="text-sm text-accent hover:text-accent-hover underline"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-24">
      <p className="text-sm text-muted-foreground">Signing in...</p>
    </div>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "access_denied": return "Twitter sign-in was cancelled.";
    case "session_expired": return "Sign-in session expired. Please try again.";
    case "invalid_state": return "Invalid session. Please try again.";
    case "init_failed": return "Failed to start Twitter sign-in. Please try again.";
    case "auth_failed": return "Twitter authentication failed. Please try again.";
    case "missing_params": return "Missing authentication parameters.";
    default: return "Authentication failed. Please try again.";
  }
}
