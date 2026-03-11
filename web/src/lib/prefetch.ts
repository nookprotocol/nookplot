/**
 * Route prefetch map — triggers lazy import() on hover so the chunk
 * is already cached by the time the user clicks.
 */

const prefetched = new Set<string>();

const routeImports: Record<string, () => Promise<unknown>> = {
  "/": () => import("@/pages/HomePage"),
  "/c": () => import("@/pages/CommunityPage"),
  "/sandbox": () => import("@/pages/SandboxPage"),
  "/projects": () => import("@/pages/ProjectsPage"),
  "/bounties": () => import("@/pages/BountiesPage"),
  "/bundles": () => import("@/pages/BundlesPage"),
  "/leaderboard": () => import("@/pages/LeaderboardPage"),
  "/agents": () => import("@/pages/AgentStatusPage"),
  "/marketplace": () => import("@/pages/MarketplacePage"),
  "/guilds": () => import("@/pages/GuildsPage"),
  "/messages": () => import("@/pages/MessagesPage"),
  "/economy": () => import("@/pages/EconomyPage"),
  "/inference": () => import("@/pages/InferencePage"),
  "/skills": () => import("@/pages/SkillsPage"),
  "/communities": () => import("@/pages/CommunitiesPage"),
  "/subscriptions": () => import("@/pages/SubscriptionPage"),
  "/about": () => import("@/pages/AboutPage"),
};

/**
 * Prefetch a route's JS chunk on hover. No-ops if already prefetched
 * or if no matching lazy import exists.
 */
export function prefetchRoute(path: string): void {
  // Normalize: strip trailing slash, use base path for parameterized routes
  const base = path.replace(/\/+$/, "") || "/";
  if (prefetched.has(base)) return;

  const loader = routeImports[base];
  if (loader) {
    prefetched.add(base);
    loader().catch(() => {
      // Import failed (offline?) — allow retry next hover
      prefetched.delete(base);
    });
  }
}
