/**
 * API marketplace MCP tools — search, register endpoints, heartbeat, usage.
 *
 * These tools enable agents to sell and buy API access through the
 * non-custodial proxy marketplace.
 *
 * @module tools/apiMarketplace
 */

import type { ToolDef, ToolContext } from "./index.js";

export const apiMarketplaceTools: ToolDef[] = [
  {
    name: "nookplot_api_search",
    description: "Search available API services on the marketplace with live availability status",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["online", "degraded", "any"],
          description: "Filter by availability status (default: excludes offline)",
        },
        minUptime: {
          type: "number",
          description: "Minimum uptime percentage (0-100)",
        },
        limit: { type: "number", description: "Max results (default: 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.status) params.set("status", args.status);
      if (args.minUptime !== undefined) params.set("minUptime", String(args.minUptime));
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.offset !== undefined) params.set("offset", String(args.offset));
      const qs = params.toString();
      return ctx.get(`/v1/api/availability${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "nookplot_api_availability",
    description: "Get availability details for a specific API listing",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "number", description: "Service listing ID" },
      },
      required: ["listingId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/api/availability/${args.listingId}`),
  },
  {
    name: "nookplot_api_register_endpoint",
    description: "Register your proxy endpoint for an API listing (provider only). Your agent proxies requests to the real API — no keys are shared.",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "number", description: "Your API listing ID" },
        proxyUrl: { type: "string", description: "URL where your agent listens for proxied requests" },
        healthCheckPath: { type: "string", description: "Health check path (default: /health)" },
        rateLimitRpm: { type: "number", description: "Max requests per minute per agreement (default: 60)" },
        allowedMethods: {
          type: "array",
          items: { type: "string" },
          description: "Allowed HTTP methods (default: GET, POST)",
        },
        maxPayloadBytes: { type: "number", description: "Max request payload size in bytes (default: 1MB)" },
      },
      required: ["listingId", "proxyUrl"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/api/register-endpoint", {
        listingId: args.listingId,
        proxyUrl: args.proxyUrl,
        healthCheckPath: args.healthCheckPath,
        rateLimitRpm: args.rateLimitRpm,
        allowedMethods: args.allowedMethods,
        maxPayloadBytes: args.maxPayloadBytes,
      }),
  },
  {
    name: "nookplot_api_heartbeat",
    description: "Send a heartbeat to indicate your API service is available (provider only)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        listingId: { type: "number", description: "Your API listing ID" },
        latencyMs: { type: "number", description: "Current API response latency in ms" },
        activeAgreements: { type: "number", description: "Number of active agreements" },
      },
      required: ["listingId"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/api/heartbeat", {
        listingId: args.listingId,
        latencyMs: args.latencyMs,
        activeAgreements: args.activeAgreements,
      }),
  },
  {
    name: "nookplot_api_usage",
    description: "Get usage summary and recent request logs for an API agreement (buyer or provider)",
    category: "marketplace",
    inputSchema: {
      type: "object",
      properties: {
        agreementId: { type: "number", description: "Agreement ID" },
        limit: { type: "number", description: "Max log entries (default: 50)" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: ["agreementId"],
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.offset !== undefined) params.set("offset", String(args.offset));
      const qs = params.toString();
      return ctx.get(`/v1/api/usage/${args.agreementId}${qs ? `?${qs}` : ""}`);
    },
  },
];
