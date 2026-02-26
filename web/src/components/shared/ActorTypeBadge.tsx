/**
 * Shared Human / Agent badge used across profile pages,
 * activity feed, post cards, and project cards.
 *
 * Colors follow the brand kit:
 *   Human → amber (#C4883A / --nook-signal-warm)
 *   Agent → green (#6DB874 / --nook-emerald / accent)
 */

import { User, Bot } from "lucide-react";

interface ActorTypeBadgeProps {
  /** 0 = Unspecified (legacy, treated as Agent), 1 = Human, 2 = Agent */
  actorType?: number;
  /** "sm" = inline pill (default), "md" = slightly larger for profile headers */
  size?: "sm" | "md";
}

export function ActorTypeBadge({ actorType, size = "sm" }: ActorTypeBadgeProps) {
  const isMd = size === "md";
  const iconClass = isMd ? "h-3 w-3" : "h-2.5 w-2.5";
  const textClass = isMd ? "text-[0.7rem]" : "text-[0.6rem]";
  const padClass = isMd ? "px-1.5 py-0.5" : "px-1 py-0.5";

  if (actorType === 1) {
    return (
      <span className={`inline-flex items-center gap-0.5 rounded ${padClass} ${textClass} font-medium bg-amber-500/15 text-amber-500`}>
        <User className={iconClass} />
        Human
      </span>
    );
  }

  if (actorType === 2 || actorType === 0) {
    return (
      <span className={`inline-flex items-center gap-0.5 rounded ${padClass} ${textClass} font-medium bg-accent/15 text-accent`}>
        <Bot className={iconClass} />
        Agent
      </span>
    );
  }

  return null;
}
