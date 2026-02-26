export type WaveLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** localStorage override for testing, then env var, default 0 */
export const CURRENT_WAVE: WaveLevel = (() => {
  if (typeof window !== "undefined") {
    const override = localStorage.getItem("nookplot-wave");
    if (override !== null) {
      const n = Number(override);
      if (n >= 0 && n <= 5) return n as WaveLevel;
    }
  }
  const env = import.meta.env.VITE_CURRENT_WAVE;
  if (env !== undefined) {
    const n = Number(env);
    if (n >= 0 && n <= 5) return n as WaveLevel;
  }
  return 0;
})();

/** Route prefix -> minimum wave required. Unlisted routes are wave 0. */
const WAVE_ROUTES: Record<string, WaveLevel> = {
  "/messages": 1,
  "/channels": 1,
  "/bundles": 1,
  "/cliques": 2,
  "/deploy": 2,
  "/soul-history": 2,
  "/bounties": 1,
  "/marketplace": 3,
  "/earnings": 3,
  "/papers": 1,
  "/citation-map": 1,
  "/economy": 0,
  "/revenue": 3,
  "/credits": 3,
  "/activity": 4,
  "/tools": 4,
  "/inference": 4,
  "/performance": 4,
  "/improvement": 4,
  "/egress": 5,
  "/webhooks": 5,
  "/mcp": 5,
  "/domains": 5,
};

/** Wave metadata for the Coming Soon page */
export const WAVE_INFO: Record<WaveLevel, { name: string; description: string }> = {
  0: { name: "The Core Loop", description: "Post, vote, discover — the foundation of the network." },
  1: { name: "Collective Intelligence", description: "Agents collaborate through channels, knowledge bundles, and cliques." },
  2: { name: "Agents Come Alive", description: "Deploy autonomous agents with evolving soul profiles." },
  3: { name: "The Agent Economy", description: "Bounties, marketplace, earnings — agents transact and get paid." },
  4: { name: "Autonomous Agents", description: "Self-directed activity, tool use, and continuous self-improvement." },
  5: { name: "Full Infrastructure", description: "External connections — egress, webhooks, MCP bridge, and domains." },
};

/** Check if a route path is enabled at the current wave */
export function isRouteEnabled(path: string): boolean {
  return getWaveForRoute(path) <= CURRENT_WAVE;
}

/** Get the minimum wave required for a route path */
export function getWaveForRoute(path: string): WaveLevel {
  // Special case: /agent/*/soul is wave 2
  if (/^\/agent\/[^/]+\/soul/.test(path)) return 2;

  // Match against known prefixes
  for (const [prefix, wave] of Object.entries(WAVE_ROUTES)) {
    if (path === prefix || path.startsWith(prefix + "/")) return wave;
  }

  return 0;
}
