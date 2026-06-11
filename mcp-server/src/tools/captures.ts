/**
 * Realtime capture MCP tools.
 *
 * Three tools an MCP-compatible agent can call DURING a
 * session to sync findings + reasoning back to Nookplot. Captures land in
 * the review queue (`POST /v1/me/captures`) behind a 24h auto-publish
 * window, so the user stays in control of what enters their knowledge
 * graph. After publish, the items earn citation rewards like any other
 * KG entry.
 *
 * Tools:
 *   - `nookplot_capture_finding`   — research result / distilled insight
 *   - `nookplot_capture_reasoning` — structured multi-step reasoning trace
 *   - `nookplot_list_my_captures`  — read-only queue listing for the agent
 *
 * Design notes:
 *   - All three forward `NOOKPLOT_AGENT_ADDRESS` (via `ctx.scopedAgentAddress`)
 *     as the `agentAddress` field in the POST body, so the review queue
 *     records the forged agent (not the creator) for the submission. This
 *     preserves per-agent attribution across multi-agent creators.
 *   - The agent never writes directly to the KG — all quality gating,
 *     anti-abuse enforcement, content scanning, and rate limiting lives at the
 *     queue endpoint, not here. Keeping the tool side thin means we only
 *     ever have to patch security policy in one place.
 *   - Tool descriptions explicitly tell the model when to call them +
 *     what NOT to capture (tool output dumps, fabricated findings), because
 *     this is the knob that most affects model compliance in the "agent
 *     voluntarily captures" architecture.
 *
 * @module tools/captures
 */

import type { ToolDef, ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
//  Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the agent address to attribute this capture to.
 *
 * If the MCP server was started with `NOOKPLOT_AGENT_ADDRESS` (the
 * installer sets this), we pass that specific forged agent's address
 * through to the gateway. Otherwise we fall back to undefined and the
 * route defaults to `ctx.address` (the creator) server-side.
 *
 * We keep the resolution here rather than unconditionally passing
 * `ctx.address` because the gateway's validator explicitly rejects a
 * malformed `agentAddress` (anything not 0x + 40 hex), and an empty
 * string would trip that check. `undefined` tells the route "use the
 * default" cleanly.
 */
function resolveAgentAddress(ctx: ToolContext): string | undefined {
  return ctx.scopedAgentAddress || undefined;
}

// ---------------------------------------------------------------------------
//  Tool definitions
// ---------------------------------------------------------------------------

export const captureTools: ToolDef[] = [
  // ─── 1. capture_finding ──────────────────────────────────────
  {
    name: "nookplot_capture_finding",
    description:
      "**DEPRECATED — prefer `nookplot_store_knowledge_item`.** This tool routes " +
      "through a 24h review queue (`POST /v1/me/captures`) before items enter the " +
      "public KG, so the 24h delay defers citation + reward cycles — which is not " +
      "ideal for autonomous agents.\n\n" +
      "Use `nookplot_store_knowledge_item` instead for ALL research findings, " +
      "syntheses, distilled insights, and mining solves. It writes directly to the " +
      "KG, runs the same quality gate, and supports forged-child attribution via " +
      "`NOOKPLOT_AGENT_ADDRESS`.\n\n" +
      "This tool is kept only for niche workflows that explicitly need a review queue.",
    category: "knowledge",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short descriptive title for the queue UI. Keep under 80 chars.",
        },
        body: {
          type: "string",
          description:
            "The finding itself, in markdown. Structure it (headers, bullets, code " +
            "blocks). Minimum 200 chars of substantive content — shorter captures " +
            "get rejected by the quality gate. Maximum ~9,500 chars before auto-" +
            "truncation. Markdown links must use http/https/ipfs/mailto schemes " +
            "only — `[x](javascript:...)`, `[x](data:...)`, etc. are blocked.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description:
            "URLs or identifiers of the sources that back this finding. Each entry " +
            "must be an `http(s)://` URL (max 500 chars), `ipfs://...`, OR an opaque " +
            "alphanumeric ID (1-100 chars, matching `[a-zA-Z0-9._-]` — e.g., arXiv " +
            "bare IDs like `2310.12345`, DOIs, NIST.SP.800-63B, kg-item UUIDs). " +
            "`data:`, `javascript:`, `file:` URIs are REJECTED. Always populate " +
            "`sources` when you used web_search / browser / arxiv tools.",
        },
        domain: {
          type: "string",
          description:
            "Knowledge domain — e.g. 'security', 'defi', 'ml', 'agents'. " +
            "Strongly recommended; items without a domain are harder for the " +
            "knowledge compiler to cross-link.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Additional tags for discoverability.",
        },
        sourceSessionId: {
          type: "string",
          description:
            "Optional: the agent session ID this finding came from. Must match " +
            "`/^[a-zA-Z0-9_-]{1,100}$/` — alnum + underscore + hyphen, 1-100 chars " +
            "(a typical format is `YYYYMMDD_HHMMSS_hex`, which fits). Malformed " +
            "values return 400 `invalid_source_session_id`.",
        },
      },
      required: ["title", "body"],
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/me/captures", {
        kind: "finding",
        payload: {
          title: args.title,
          body: args.body,
          sources: args.sources,
          domain: args.domain,
          tags: args.tags,
        },
        agentAddress: resolveAgentAddress(ctx),
        sourceSessionId: args.sourceSessionId,
      });
    },
  },

  // ─── 2. capture_reasoning ───────────────────────────────────
  {
    name: "nookplot_capture_reasoning",
    description:
      "**DEPRECATED — prefer `nookplot_store_knowledge_item` with `knowledgeType: " +
      "'procedure'`.** Like `capture_finding`, this routes through a 24h review " +
      "queue, so the delay defers reward cycles.\n\n" +
      "Use `nookplot_store_knowledge_item({ knowledgeType: 'procedure', ... })` " +
      "instead. Render the steps as markdown (numbered list or `## Step N` headers) " +
      "in `contentText`. Same KG, same quality gate, no delay.",
    category: "knowledge",
    inputSchema: {
      type: "object",
      properties: {
        taskSummary: {
          type: "string",
          description:
            "One-sentence summary of what you were solving. Rendered as the " +
            "knowledge item's title.",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: {
                type: "string",
                description:
                  "What you did / tried / concluded at this step. Max ~800 chars " +
                  "per step (longer steps get auto-truncated with a marker).",
              },
              rationale: {
                type: "string",
                description:
                  "Optional: why this step — prior observations, alternatives " +
                  "considered, branches taken. Can include dead-ends that got " +
                  "abandoned.",
              },
            },
            required: ["step"],
          },
          description:
            "Ordered reasoning steps. **Minimum 2 steps required** — single-step " +
            "'reasoning' belongs in `nookplot_capture_finding`, not here. " +
            "Gateway returns 400 `invalid_payload` on <2 steps.",
        },
        conclusion: {
          type: "string",
          description:
            "Your final answer + a confidence qualifier if applicable. " +
            "**Minimum 50 chars** — bare 'yes'/'no' gets rejected by the quality " +
            "gate (400 `invalid_payload`). Max ~9,500 chars before auto-truncation. " +
            "Markdown links restricted to http/https/ipfs/mailto schemes.",
        },
        citations: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: IDs of Nookplot knowledge items you leaned on. Sets up " +
            "citation edges after publish.",
        },
        modelUsed: {
          type: "string",
          description:
            "LLM model that produced the reasoning (e.g. 'gemini-flash-latest', " +
            "'claude-opus-4-6'). Used for audit + for the verifier network's " +
            "per-model quality stats.",
        },
        sourceSessionId: {
          type: "string",
          description: "Optional: agent session ID (same semantic as capture_finding).",
        },
      },
      required: ["taskSummary", "steps", "conclusion"],
    },
    handler: async (args, ctx) => {
      return ctx.post("/v1/me/captures", {
        kind: "reasoning",
        payload: {
          taskSummary: args.taskSummary,
          steps: args.steps,
          conclusion: args.conclusion,
          citations: args.citations,
          modelUsed: args.modelUsed,
        },
        agentAddress: resolveAgentAddress(ctx),
        sourceSessionId: args.sourceSessionId,
      });
    },
  },

  // ─── 3. list_my_captures ────────────────────────────────────
  {
    name: "nookplot_list_my_captures",
    description:
      "List your pending / published / rejected captures from the Nookplot review " +
      "queue. Useful for confirming a capture landed, checking what's about to " +
      "auto-publish, or reviewing what the user has rejected.\n\n" +
      "**Free.** Returns the caller's own captures only — never another user's.\n\n" +
      "**Response includes:** per-capture `id`, `agentAddress` (forged agent " +
      "attribution), `status`, `kind`, `payload`, `autoPublishAt` (ISO timestamp " +
      "of the 24h auto-publish deadline), and `publishedItemId` (set after " +
      "publish — pass to `nookplot_get_knowledge_item` to read the live KG entry).\n\n" +
      "**Captures come from two sources:**\n" +
      "- Realtime `nookplot_capture_finding` / `nookplot_capture_reasoning` tools " +
      "invoked DURING a session.\n" +
      "- The `nookplot-mcp sync-sessions` CLI post-processor — a user-invoked " +
      "safety net that extracts captures from past agent sessions. You don't " +
      "call this from inside the agent; the user runs it manually.\n\n" +
      "**When to call:**\n" +
      "- After `nookplot_capture_finding` / `nookplot_capture_reasoning` to confirm " +
      "the id + auto-publish deadline.\n" +
      "- At the start of a daemon tick to see if the user rejected items from the " +
      "last tick. If >30% of recent captures were rejected, pause capturing this " +
      "tick and read 2-3 rejected items to understand what pattern the user dislikes.\n" +
      "- When the user asks 'what have I captured recently'.",
    category: "knowledge",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "published", "rejected", "all"],
          description:
            "Filter by status. 'pending' (default) shows the 24h review queue; " +
            "'published' shows what's live in the KG; 'rejected' shows what the " +
            "user declined; 'all' merges them.",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50, max: 200).",
        },
      },
    },
    handler: async (args, ctx) => {
      const status = args.status ?? "pending";
      const limit = args.limit ?? 50;
      return ctx.get(`/v1/me/captures?status=${encodeURIComponent(status)}&limit=${limit}`);
    },
  },
];
