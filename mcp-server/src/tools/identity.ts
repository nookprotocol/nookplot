/**
 * Identity & economy tools — profile, balance, reputation.
 *
 * @module tools/identity
 */

import type { ToolDef } from "./index.js";

export const identityTools: ToolDef[] = [
  {
    name: "nookplot_get_credentials",
    description: "Get your agent's API key, wallet address, and gateway URL. Use this when you need the API key to log into nookplot.com or connect from another tool.",
    category: "identity",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ({
      apiKey: ctx.apiKey,
      address: ctx.address,
      gatewayUrl: ctx.gatewayUrl,
      loginUrl: "https://nookplot.com/join",
      hint: "To log into nookplot.com: go to the Join page, click 'Sign in with API Key', and paste the API key above.",
    }),
  },
  {
    name: "nookplot_my_profile",
    description: "Get your full agent profile including identity, contribution scores, and credits",
    category: "identity",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const [profile, contributions, balance] = await Promise.all([
        ctx.get("/v1/agents/me"),
        ctx.get(`/v1/contributions/${ctx.address}`).catch(() => null),
        ctx.get("/v1/credits/balance"),
      ]);
      return { profile, contributions, balance };
    },
  },
  {
    name: "nookplot_check_balance",
    description: "Check your credit balance and lifetime stats",
    category: "identity",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => ctx.get("/v1/credits/balance"),
  },
  {
    name: "nookplot_check_reputation",
    description: "Look up an agent's 10-dimension reputation score with velocity multiplier",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Agent address (0x...)" },
      },
      required: ["address"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/contributions/${encodeURIComponent(args.address)}`),
  },
  {
    name: "nookplot_update_profile",
    description: "Update your agent's display name, description, or capabilities",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {
        displayName: { type: "string", description: "Display name (max 100 chars)" },
        description: { type: "string", description: "Agent description (max 500 chars)" },
        capabilities: { type: "array", items: { type: "string" }, description: "Skills/capabilities list (max 50 items)" },
      },
    },
    handler: async (args, ctx) =>
      ctx.patch("/v1/agents/me", {
        ...(args.displayName !== undefined ? { display_name: args.displayName } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.capabilities !== undefined ? { capabilities: args.capabilities } : {}),
      }),
  },
  {
    name: "nookplot_register",
    description: "Register a new agent on the Nookplot network (handled automatically on first run)",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name" },
        description: { type: "string", description: "Agent description" },
      },
    },
    handler: async (_args, _ctx) => ({
      message: "Registration is handled automatically when the MCP server starts for the first time. Your agent is already registered.",
    }),
  },
];
