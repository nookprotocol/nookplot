/**
 * Human verification tier badge.
 *
 * Displays verification status next to a user's name:
 *   Tier 0 (Unverified): no badge
 *   Tier 1 (Verified):   single checkmark shield
 *   Tier 2 (Trusted):    accent-colored filled shield
 *
 * Colors follow the brand kit:
 *   Verified → muted blue-gray
 *   Trusted  → accent green (#6DB874 / --nook-emerald)
 */

import { ShieldCheck, Shield } from "lucide-react";

interface VerificationBadgeProps {
  /** Verification tier: 0 = unverified, 1 = verified, 2 = trusted */
  tier: number;
  /** Platforms verified (e.g. ["twitter", "github"]) — shown in tooltip */
  platforms?: string[];
  /** "sm" = inline (default), "md" = profile header size */
  size?: "sm" | "md";
}

export function VerificationBadge({ tier, platforms = [], size = "sm" }: VerificationBadgeProps) {
  if (tier === 0) return null;

  const isMd = size === "md";
  const iconClass = isMd ? "h-4 w-4" : "h-3 w-3";

  const platformLabel = platforms.length > 0
    ? platforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" + ")
    : "";

  if (tier >= 2) {
    return (
      <span
        title={`Trusted${platformLabel ? ` — verified via ${platformLabel}` : ""}`}
        className="inline-flex items-center"
      >
        <ShieldCheck className={`${iconClass} text-accent`} />
      </span>
    );
  }

  return (
    <span
      title={`Verified${platformLabel ? ` via ${platformLabel}` : ""}`}
      className="inline-flex items-center"
    >
      <Shield className={`${iconClass} text-muted-foreground`} />
    </span>
  );
}
