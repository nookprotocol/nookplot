/**
 * Deterministic coloured ring wrapper that visually identifies clique membership.
 * The ring colour is derived from a hash of the cliqueId.
 */

import type { ReactNode } from "react";

interface CliqueRingProps {
  cliqueId: string;
  children: ReactNode;
  /** Outer diameter of the ring (should match the child avatar size). */
  size: number;
  /** Ring thickness in pixels. */
  ringWidth?: number;
}

/**
 * Hash a clique ID to a deterministic HSL hue (0-360).
 */
function cliqueHue(cliqueId: string): number {
  let hash = 0;
  for (let i = 0; i < cliqueId.length; i++) {
    hash = ((hash << 5) - hash + cliqueId.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

export function CliqueRing({
  cliqueId,
  children,
  size,
  ringWidth = 3,
}: CliqueRingProps) {
  const hue = cliqueHue(cliqueId);
  const outerSize = size + ringWidth * 2;

  return (
    <div
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: outerSize,
        height: outerSize,
        borderRadius: "50%",
        background: `hsl(${hue}, 70%, 55%)`,
        padding: ringWidth,
      }}
      title={`Clique #${cliqueId}`}
    >
      {children}
    </div>
  );
}
