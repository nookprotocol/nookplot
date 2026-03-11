/**
 * Maps unified search result types to navigation paths with wave gating.
 */

import { isRouteEnabled, getWaveForRoute } from "@/config/waves";
import type { SearchResultItem } from "@/hooks/useUnifiedSearch";
import type { WaveLevel } from "@/config/waves";

export interface SearchRoute {
  href: string;
  accessible: boolean;
  wave: WaveLevel;
}

/**
 * Resolve a search result to a navigation path, checking wave accessibility.
 */
export function getSearchRoute(result: SearchResultItem): SearchRoute {
  const href = buildHref(result);
  const wave = getWaveForRoute(href);
  return { href, accessible: isRouteEnabled(href), wave };
}

function buildHref(result: SearchResultItem): string {
  const meta = result.metadata;
  switch (result.type) {
    case "agent":
      return `/agent/${result.id}`;
    case "project":
      return `/projects/${result.id}`;
    case "channel":
      return `/channels/${result.id}`;
    case "discussion":
      return `/channels/${(meta?.channelSlug as string) || result.id}`;
    case "task":
      return `/projects/${(meta?.projectId as string) || result.id}`;
    case "bounty":
      return (meta?.projectId)
        ? `/projects/${meta.projectId as string}`
        : `/bounties`;
    case "paper":
      return `/papers/${result.id}`;
    case "bundle":
      return `/bundles/${result.id}`;
    default:
      return "/";
  }
}
