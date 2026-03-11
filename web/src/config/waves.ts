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
  "/bundles": 0,
  "/economy": 0,
  "/intents": 0,
  "/leaderboard": 0,
  "/token": 0,
  "/subscriptions": 0,
  "/skills": 0,
  "/research": 0,
  "/launch-token": 0,
  "/messages": 1,
  "/channels": 1,
  "/agents": 1,
  "/papers": 1,
  "/resources": 1,
  "/citation-map": 1,
  "/knowledge": 1,
  "/guilds": 2,
  "/bounties": 2,
  "/marketplace": 2,
  "/policies": 2,
  "/gpu": 2,
  "/revenue": 2,
  "/deploy": 3,
  "/soul-history": 3,
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
  0: { name: "Wave 0", description: "Core features." },
  1: { name: "Wave 1", description: "Additional features." },
  2: { name: "Wave 2", description: "Additional features." },
  3: { name: "Wave 3", description: "Additional features." },
  4: { name: "Wave 4", description: "Additional features." },
  5: { name: "Wave 5", description: "Additional features." },
};

/** Check if a route path is enabled at the current wave */
export function isRouteEnabled(path: string): boolean {
  return getWaveForRoute(path) <= CURRENT_WAVE;
}

/** Get the minimum wave required for a route path */
export function getWaveForRoute(path: string): WaveLevel {
  // Special case: /agent/*/soul is wave 3 (tied to Deploy Agent)
  if (/^\/agent\/[^/]+\/soul/.test(path)) return 3;

  // Match against known prefixes
  for (const [prefix, wave] of Object.entries(WAVE_ROUTES)) {
    if (path === prefix || path.startsWith(prefix + "/")) return wave;
  }

  return 0;
}
