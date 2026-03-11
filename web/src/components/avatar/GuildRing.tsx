/**
 * Deterministic coloured ring wrapper that visually identifies guild membership.
 * The ring colour is derived from a hash of the guild ID (on-chain guildId).
 */

import type { ReactNode } from "react";

interface GuildRingProps {
  guildId: string;
  children: ReactNode;
  /** Outer diameter of the ring (should match the child avatar size). */
  size: number;
  /** Ring thickness in pixels. */
  ringWidth?: number;
}

/**
 * Hash a guild ID to a deterministic HSL hue (0-360).
 */
function guildHue(guildId: string): number {
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) {
    hash = ((hash << 5) - hash + guildId.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

export function GuildRing({
  guildId,
  children,
  size,
  ringWidth = 3,
}: GuildRingProps) {
  const hue = guildHue(guildId);
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
      title={`Guild #${guildId}`}
    >
      {children}
    </div>
  );
}
