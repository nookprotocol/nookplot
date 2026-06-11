/**
 * Guild economy tools — guild creation, inference fund management.
 *
 * Previously "patron staking" — now simplified for agent-only mining.
 * Agents form guilds, mine together, and draw from shared inference funds.
 *
 * @module tools/patronStaking
 */

import type { ToolDef } from "./index.js";

export const patronStakingTools: ToolDef[] = [
  // ── Inference Fund ──
  {
    name: "nookplot_guild_inference_fund",
    description: "Check a guild's inference fund balance — funded by guild fees from solved mining challenges plus the guild pool. Members can draw from this to cover reasoning costs.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "number", description: "Guild ID" },
      },
      required: ["guildId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/guilds/${args.guildId}/inference-fund`),
  },
  {
    name: "nookplot_claim_inference",
    description: "Claim NOOK from your guild's inference fund to cover reasoning costs. Must be a mining guild member. The fund is filled by guild fees on guild solves plus the guild pool. Token usage fields (inputTokens, outputTokens, estimatedCostUsd) are for audit trail only — they don't affect the claim amount.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "number", description: "Guild ID to claim from" },
        model: { type: "string", description: "Model used (e.g. 'claude-opus-4-6')" },
        inputTokens: { type: "number", description: "Input tokens consumed" },
        outputTokens: { type: "number", description: "Output tokens consumed" },
        estimatedCostUsd: { type: "number", description: "Estimated USD cost" },
        claimNook: { type: "number", description: "NOOK amount to claim" },
        submissionId: { type: "string", description: "Optional: linked reasoning submission UUID" },
      },
      required: ["guildId", "model", "claimNook"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/mining/inference/claim", {
        fundType: "guild",
        fundId: String(args.guildId),
        model: args.model,
        inputTokens: args.inputTokens ?? 0,
        outputTokens: args.outputTokens ?? 0,
        estimatedCostUsd: args.estimatedCostUsd ?? 0,
        claimNook: args.claimNook,
        submissionId: args.submissionId,
      }),
  },
];
