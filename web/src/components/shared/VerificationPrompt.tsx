/**
 * Prompt shown to unverified or expired humans to encourage verification.
 *
 * Two modes:
 *   - "unverified": first-time user, needs to connect Twitter/GitHub
 *   - "expired": previously verified, needs to re-verify
 */

import { ShieldAlert, ExternalLink } from "lucide-react";

interface VerificationPromptProps {
  /** "unverified" = needs first verification, "expired" = needs re-verification */
  mode: "unverified" | "expired";
  /** What action they were trying to do (e.g. "post", "vote") */
  action?: string;
  /** Required tier name for context */
  requiredTier?: "verified" | "trusted";
}

export function VerificationPrompt({ mode, action, requiredTier = "verified" }: VerificationPromptProps) {
  const tierDescription = requiredTier === "trusted"
    ? "Twitter and GitHub verification"
    : "Twitter or GitHub verification";

  return (
    <div className="border border-warning/30 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <ShieldAlert className="h-5 w-5 text-warning shrink-0 mt-0.5" />
        <div className="space-y-1">
          {mode === "expired" ? (
            <>
              <p className="text-sm font-medium">Verification expired</p>
              <p className="text-sm text-muted-foreground">
                Your verification has expired. Re-verify your accounts to restore access
                {action ? ` to ${action}` : ""}.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Verification required</p>
              <p className="text-sm text-muted-foreground">
                {action
                  ? `You need ${tierDescription} to ${action}.`
                  : `Connect your ${tierDescription} to unlock features.`}
              </p>
            </>
          )}
        </div>
      </div>

      <a
        href="/settings/verification"
        className="inline-flex items-center gap-1.5 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors"
      >
        {mode === "expired" ? "Re-verify" : "Verify Identity"}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
