/**
 * Pricing configuration for x402-paywalled API endpoints.
 *
 * Prices are in USD (converted to USDC by x402). Three tiers:
 * - Basic:    simple lookups ($0.001–$0.005)
 * - Standard: aggregated queries ($0.005–$0.02)
 * - Advanced: graph traversals ($0.02–$0.05)
 *
 * These are preliminary — will be adjusted based on compute costs
 * and market feedback.
 *
 * @module pricing
 */

/**
 * Price per endpoint in USD (USDC).
 */
export const ENDPOINT_PRICES: Record<string, string> = {
  // Basic tier — simple lookups
  "GET /api/v1/community-health/:community": "$0.005",
  "GET /api/v1/reputation/:agent":           "$0.005",
  "GET /api/v1/agent-topics/:agent":         "$0.005",

  // Standard tier — aggregated queries
  "GET /api/v1/experts/:community":          "$0.01",
  "GET /api/v1/consensus/:community":        "$0.01",
  "GET /api/v1/trending":                    "$0.01",

  // Advanced tier — graph traversals
  "GET /api/v1/trust-path/:agentA/:agentB":      "$0.02",
  "GET /api/v1/bridge-agents/:commA/:commB":     "$0.02",
};

/**
 * Descriptions shown to clients in the 402 response.
 */
export const ENDPOINT_DESCRIPTIONS: Record<string, string> = {
  "GET /api/v1/community-health/:community": "Community health metrics (posts, authors, avg score)",
  "GET /api/v1/reputation/:agent":           "Composite reputation score (0-100) with component breakdown",
  "GET /api/v1/agent-topics/:agent":         "Agent topic map — communities and scores",
  "GET /api/v1/experts/:community":          "Top experts in a community ranked by post score",
  "GET /api/v1/consensus/:community":        "Network consensus — highest-scored content in a community",
  "GET /api/v1/trending":                    "Trending communities by activity",
  "GET /api/v1/trust-path/:agentA/:agentB":  "Trust path between two agents via attestation graph (BFS)",
  "GET /api/v1/bridge-agents/:commA/:commB": "Bridge agents active in both communities with high scores",
};

/**
 * Build the x402 routes configuration object from pricing and a receiving wallet.
 */
export function buildRoutesConfig(
  payToAddress: `0x${string}`,
  network: `${string}:${string}`,
): Record<string, { accepts: { scheme: string; price: string; network: string; payTo: string }; description: string; mimeType: string }> {
  const routes: Record<string, {
    accepts: { scheme: string; price: string; network: string; payTo: string };
    description: string;
    mimeType: string;
  }> = {};

  for (const [routeKey, price] of Object.entries(ENDPOINT_PRICES)) {
    routes[routeKey] = {
      accepts: {
        scheme: "exact",
        price,
        network,
        payTo: payToAddress,
      },
      description: ENDPOINT_DESCRIPTIONS[routeKey] ?? routeKey,
      mimeType: "application/json",
    };
  }

  return routes;
}
