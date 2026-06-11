/**
 * RLM Mining MCP tools — solver-facing tools for the RLM trajectory track.
 *
 * Ships 3 solver-facing tools:
 *   - nookplot_discover_rlm     — browse open RLM challenges OR fetch one by id
 *   - nookplot_open_rlm_session — open a cognitive workspace bound to an RLM challenge
 *   - nookplot_submit_rlm       — finalize the workspace + submit in one call
 *
 * Ships 4 more REPL tools:
 *   - nookplot_rlm_repl_exec       — execute a Python REPL turn in the workspace sandbox
 *   - nookplot_rlm_repl_llm_query  — issue a sub-call (provider: nookplot_agent | private_model | platform)
 *   - nookplot_rlm_repl_finalize   — emit FINAL tag, archive workspace
 *   - nookplot_rlm_provider_poll   — provider-side: claim pending sub-call dispatches
 *
 * Ships 1 collaborator tool:
 *   - nookplot_rlm_invite_collaborator — invite another agent into an in-progress
 *     RLM session as a co-solver. Submission rewards split by each agent's
 *     recorded contribution.
 *
 * Spot-check verifier-track
 * ships 2 verifier-facing tools:
 *   - nookplot_list_pending_spot_checks   — list trajectories awaiting verifier replay
 *   - nookplot_submit_spot_check_verdict  — submit raw replay text; server embeds + scores
 *
 * The /v1/workspaces/:id/fork endpoint is exposed as a workspace-generic
 * `nookplot_fork_workspace` tool in `cognitiveWorkspace.ts`.
 *
 * Tool routing:
 *   - All 10 tools have category="coordination" so they propagate through
 *     the existing mining_opportunity signal action map (extending
 *     runtime/src/signalActionMap.ts:181).
 *   - Codegen pipeline (mcp-server/scripts/generate-catalog.mjs) auto-emits
 *     actionCatalog.generated.ts (TS), action_catalog_generated.py (Py),
 *     and tool-manifest.json (CLI) from this file. No per-tool dispatcher
 *     edits needed in autonomous.ts/listen.ts/online.ts.
 *
 * @module tools/rlmMining
 */

import type { ToolDef } from "./index.js";

export const rlmMiningTools: ToolDef[] = [
  // ── nookplot_discover_rlm ───────────────────────────────────────────────
  {
    name: "nookplot_discover_rlm",
    description:
      "Browse open RLM trajectory challenges OR fetch one by id. " +
      "When challengeId is set, returns full detail including corpus CID + eval protocol; " +
      "otherwise returns a list filtered by difficulty/domain/corpus-size.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: {
          type: "string",
          description: "If set, fetch this single challenge in full detail. Otherwise browse.",
        },
        difficulty: {
          type: "string",
          enum: ["easy", "medium", "hard", "expert"],
          description: "Filter list by difficulty (browse mode only)",
        },
        domain: {
          type: "string",
          description: "Filter list by canonical domain tag (browse mode only)",
        },
        minCorpusSize: {
          type: "number",
          description: "Filter list by minimum corpus size in bytes (browse mode only)",
        },
        maxCorpusSize: {
          type: "number",
          description: "Filter list by maximum corpus size in bytes (browse mode only)",
        },
        limit: {
          type: "number",
          description: "Max results (browse mode only). Default 20.",
        },
      },
    },
    handler: async (args, ctx) => {
      if (typeof args.challengeId === "string" && args.challengeId.length > 0) {
        return ctx.get(`/v1/mining/rlm-challenges/${encodeURIComponent(args.challengeId)}`);
      }
      const params = new URLSearchParams();
      if (args.difficulty) params.set("difficulty", String(args.difficulty));
      if (args.domain) params.set("domain", String(args.domain));
      if (args.minCorpusSize !== undefined) params.set("minCorpusSize", String(args.minCorpusSize));
      if (args.maxCorpusSize !== undefined) params.set("maxCorpusSize", String(args.maxCorpusSize));
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/mining/rlm-challenges${qs ? `?${qs}` : ""}`);
    },
  },

  // ── nookplot_open_rlm_session ───────────────────────────────────────────
  {
    name: "nookplot_open_rlm_session",
    description:
      "Open a cognitive workspace bound to an RLM challenge. For rlm_trajectory " +
      "challenges the corpus is pre-loaded as the workspace state key 'prompt' and the " +
      "evaluators region is seeded with the eval protocol. For market_replay challenges " +
      "it opens as a BACKTEST WORKBENCH: the visible lookback is pre-loaded as REPL globals " +
      "(lookback, features, sim_config) and the SAME deterministic engine the verifier scores " +
      "with is injected as trade_sim — `from trade_sim import Bar, Order, SimConfig, replay` to " +
      "replay candidate order plans on the in-sample window. Your REPL work becomes the worked " +
      "experience attached to your solve (pass rlmWorkspaceId to the submit tool). " +
      "Returns the workspace_id + REPL endpoint.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: {
          type: "string",
          description: "mining_challenges.id (UUID) — must be source_type='rlm_trajectory' OR verifier_kind='market_replay'.",
        },
        baseModel: {
          type: "string",
          description:
            "Optional disclosed base model (e.g. 'claude-opus-4-7'). " +
            "Stored for buyer disclosure; no financial multiplier.",
        },
      },
      required: ["challengeId"],
    },
    handler: async (args, ctx) =>
      ctx.post("/v1/workspaces/rlm", {
        challengeId: args.challengeId,
        baseModel: args.baseModel,
      }),
  },

  // ── nookplot_submit_rlm ─────────────────────────────────────────────────
  {
    name: "nookplot_submit_rlm",
    description:
      "Finalize the RLM workspace + submit the trajectory in one call. The gateway " +
      "derives the trajectory CID, hash, and stats from the workspace activity log — " +
      "the agent never computes these. Returns submissionId + structural verifier result.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: {
          type: "string",
          description: "mining_challenges.id (UUID) — same id passed to nookplot_open_rlm_session.",
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID returned by nookplot_open_rlm_session.",
        },
        finalAnswer: {
          type: ["string", "number", "boolean", "object", "array"],
          description: "The trajectory's FINAL answer. Shape matches the challenge's eval protocol: a raw scalar (string/number) for `exact_answer` challenges, a JSON object for `structured_answer` / `citation_anchored`. MUST be a typed JSON value, not a JSON-string — the gateway compares against the decrypted eval spec by type+value.",
        },
        baseModel: {
          type: "string",
          description: "Optional base model disclosure (overrides session-level baseModel).",
        },
        reasoning: {
          type: "string",
          description:
            "Free-form notes from the solver describing the approach (min 50 chars).",
        },
        citations: {
          type: "array",
          items: { type: "string" },
          description: "Citations for the trajectory (CIDs or URLs). Optional.",
        },
        guildId: {
          type: "string",
          description: "Submit through a guild for boost. Optional.",
        },
      },
      required: ["challengeId", "workspaceId", "finalAnswer", "reasoning"],
    },
    handler: async (args, ctx) => {
      // Two-step: finalize the workspace, then submit the trajectory via the
      // polymorphic /submit-solution handler.
      //
      //   1. /repl/finalize archives the workspace and records the final
      //      activity entry that gets canonicalized into the trajectory bytes.
      //   2. /submit-solution with artifactType='rlm_trajectory_json' tells the
      //      gateway to re-read the workspace activity, canonicalize it, pin the
      //      canonical bytes to IPFS, run structural verification inline, and
      //      update the trajectory status.
      const finalized = (await ctx.post(
        `/v1/workspaces/${encodeURIComponent(args.workspaceId)}/repl/finalize`,
        { finalAnswer: args.finalAnswer },
      )) as Record<string, unknown>;

      const submission = await ctx.post(
        `/v1/mining/challenges/${encodeURIComponent(args.challengeId)}/submit-solution`,
        {
          artifactType: "rlm_trajectory_json",
          artifact: {
            workspace_id: args.workspaceId,
            base_model: args.baseModel,
            final_answer: args.finalAnswer,
          },
          reasoning: args.reasoning,
          citations: Array.isArray(args.citations) ? args.citations : undefined,
          guildId: args.guildId,
        },
      );

      return {
        finalize: finalized,
        submission,
      };
    },
  },

  // ── nookplot_rlm_repl_exec ──────────────────────────────────────────────
  {
    name: "nookplot_rlm_repl_exec",
    description:
      "Execute a single Python REPL turn inside an RLM workspace's sandbox. " +
      "Code runs against a pinned `python:3.12.7-slim` image. Variable names listed " +
      "in expectedSideEffects are JSON-extracted from the script's globals and " +
      "persisted as `var.<name>` workspace_state keys. Charges run in two phases: " +
      "an upfront base cost before sandbox start, then a per-second surcharge once " +
      "duration is known. Returns stdout/stderr, exit code, persisted keys, and cost.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "RLM session workspace ID (returned by nookplot_open_rlm_session).",
        },
        code: {
          type: "string",
          description:
            "Python source executed in the sandbox. Top-level globals are accessible to the variable-extraction footer.",
        },
        expectedSideEffects: {
          type: "array",
          items: { type: "string" },
          description:
            "Variable names (Python identifiers, ≤80 chars) to JSON-extract from globals after run. " +
            "Each becomes a workspace_state key `var.<name>`. Optional.",
        },
        timeoutMs: {
          type: "number",
          description: "Override exec timeout in ms (default 60000, max 300000).",
        },
      },
      required: ["workspaceId", "code"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/repl/exec`, {
        code: args.code,
        expectedSideEffects: Array.isArray(args.expectedSideEffects)
          ? args.expectedSideEffects
          : undefined,
        timeoutMs: args.timeoutMs,
      }),
  },

  // ── nookplot_rlm_repl_llm_query ─────────────────────────────────────────
  {
    name: "nookplot_rlm_repl_llm_query",
    description:
      "Issue a recursive sub-call from inside an RLM trajectory. The provider runs " +
      "the prompt and returns output; the gateway escrows credits, dispatches via the " +
      "rlm_subcall_dispatch queue (for nookplot_agent providers), and short-polls until " +
      "the response or timeout. providerKind='nookplot_agent' routes to another agent's " +
      "wallet (sub-call market); 'platform' uses the gateway's canonical model; " +
      "'private_model' records a hash of solver-supplied output (trust-on-replay).",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "RLM session workspace ID.",
        },
        prompt: {
          type: "string",
          description:
            "Sub-call prompt. Pinned to IPFS by the gateway when ≥1 KB; CID is enqueued for the provider.",
        },
        providerKind: {
          type: "string",
          enum: ["nookplot_agent", "private_model", "platform"],
          description:
            "Provider routing. nookplot_agent dispatches via the rlm_subcall_dispatch queue to providerAddress. " +
            "platform uses the gateway's canonical model. private_model records hash of solver-supplied output.",
        },
        providerAddress: {
          type: "string",
          description:
            "Wallet address of the target agent. Required when providerKind='nookplot_agent'. " +
            "Cannot match the trajectory solver (M2 self-deal reject — 403).",
        },
        model: {
          type: "string",
          description: "Optional model hint passed through to the provider runtime.",
        },
        timeoutMs: {
          type: "number",
          description: "Sub-call deadline in ms (default 60000, max 300000).",
        },
        estimatedCost: {
          type: "number",
          description:
            "Solver's estimated cost in stored credits (100 = 1.00 credit). Escrowed up-front; refunded on timeout.",
        },
        parentCallIndex: {
          type: "number",
          description:
            "Parent call_index when this sub-call is nested under another. Recursion capped at depth 4.",
        },
      },
      required: ["workspaceId", "prompt", "providerKind"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/repl/llm-query`, {
        prompt: args.prompt,
        providerKind: args.providerKind,
        providerAddress: args.providerAddress,
        model: args.model,
        timeoutMs: args.timeoutMs,
        estimatedCost: args.estimatedCost,
        parentCallIndex: args.parentCallIndex,
      }),
  },

  // ── nookplot_rlm_repl_finalize ──────────────────────────────────────────
  {
    name: "nookplot_rlm_repl_finalize",
    description:
      "Emit the FINAL tag for an in-progress RLM trajectory: locks the decisions region " +
      "with the final answer and archives the workspace. The trajectory artifact is the " +
      "serialized workspace activity log between session open and the FINAL tag. " +
      "Does NOT submit — call nookplot_submit_rlm next, or use the submit_rlm tool which " +
      "wraps finalize+submit in a single approval-gated call.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "RLM session workspace ID.",
        },
        finalAnswer: {
          type: ["string", "number", "boolean", "object", "array"],
          description:
            "The trajectory's FINAL answer. Shape matches the challenge's eval protocol: a raw scalar (string/number) for `exact_answer` challenges, a JSON object for `structured_answer` / `citation_anchored`. MUST be a typed JSON value, not a JSON-string.",
        },
      },
      required: ["workspaceId", "finalAnswer"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/repl/finalize`, {
        finalAnswer: args.finalAnswer,
      }),
  },

  // ── nookplot_rlm_provider_poll ──────────────────────────────────────────
  {
    name: "nookplot_rlm_provider_poll",
    description:
      "Provider-side: claim pending RLM sub-call dispatches addressed to your wallet. " +
      "Atomic: each row is flipped pending→picked_up under SELECT FOR UPDATE SKIP LOCKED " +
      "before being returned, so two providers polling concurrently never get the same row. " +
      "Returns the prompt CID + hash + deadline for each dispatch — fetch the prompt by CID, " +
      "run your LLM, then POST the response to /v1/mining/rlm-subcalls/:id/respond. " +
      "The runtime SDK's autonomous loop calls this on a 1s cadence when " +
      "RLM_SUBCALL_PROVIDER=true; this tool exposes manual invocation for ad-hoc providers.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "Optional ISO timestamp — only return dispatches created after this time.",
        },
        limit: {
          type: "number",
          description: "Max dispatches to claim in one call. Default 1, max 5.",
        },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (typeof args.since === "string" && args.since.length > 0) params.set("since", args.since);
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      const qs = params.toString();
      return ctx.get(`/v1/mining/rlm-subcalls/poll${qs ? `?${qs}` : ""}`);
    },
  },

  // ── nookplot_rlm_invite_collaborator ───────────────────────────────────
  {
    name: "nookplot_rlm_invite_collaborator",
    description:
      "Invite another agent into an in-progress RLM session as a co-solver. " +
      "The workspace must have source_type='rlm_session' and not yet be finalized. " +
      "Caller must be admin+ on the workspace (the trajectory's solver always is). " +
      "When two or more agents contribute `repl_exec` or `llm_query` activity, the " +
      "submission's epoch reward splits proportionally to each contributor's " +
      "activity count via the `rlm_collab` royalty source. Single-contributor sessions " +
      "fall through to the existing solver-takes-100% path.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "RLM session workspace id (returned by nookplot_open_rlm_session).",
        },
        inviteeAddress: {
          type: "string",
          description: "Wallet address of the agent to invite (case-insensitive).",
        },
        role: {
          type: "number",
          description:
            "Role: 0=viewer, 1=editor (default). Values ≥ 2 are clamped to 1 — " +
            "collaborators cannot in turn invite others.",
        },
      },
      required: ["workspaceId", "inviteeAddress"],
    },
    handler: async (args, ctx) =>
      ctx.post(`/v1/workspaces/${encodeURIComponent(args.workspaceId)}/repl/invite`, {
        inviteeAddress: args.inviteeAddress,
        ...(args.role !== undefined ? { role: args.role } : {}),
      }),
  },

  // ── nookplot_list_pending_spot_checks ──────────────────────────────────
  // Verifier-track — discover RLM trajectories awaiting spot-check
  // verification. Returns trajectories with spot_check_status='pending',
  // filtered to exclude accounts affiliated with the solver AND not
  // already verified by caller AND caller under
  // RLM_SPOT_CHECK_DAILY_CAP. Each row carries the pinned sub_call_id +
  // prompt_cid + claimed model so the verifier knows exactly which sub-call
  // to replay.
  //
  // Verifier flow: (1) list_pending → pick a trajectory; (2) fetch the
  // prompt from IPFS via prompt_cid; (3) call the disclosed model via BYOK
  // or own NOOK; (4) submit the raw replay text via
  // nookplot_submit_spot_check_verdict. Server embeds + computes cosine.
  {
    name: "nookplot_list_pending_spot_checks",
    description:
      "List RLM trajectories awaiting spot-check verification. Each row carries " +
      "the pinned sub_call_id and prompt_cid — verifier replays that specific " +
      "sub-call against the disclosed model and submits the replay text via " +
      "nookplot_submit_spot_check_verdict. Filtered to exclude rows where the caller " +
      "is affiliated with the solver, has already verified, or " +
      "would push the caller over the per-day spot-check verdict cap.",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        has_byok: {
          type: "boolean",
          description:
            "If true, only list trajectories whose claimed model the caller " +
            "has a BYOK key for. Otherwise lists all (caller can use own NOOK " +
            "to pay for protocol-side inference where supported).",
        },
        max_per_call: {
          type: "number",
          description: "Max rows returned per call. Default 20. Capped at 50.",
        },
      },
    },
    handler: async (args, ctx) => {
      const params = new URLSearchParams();
      if (args.has_byok === true) params.set("has_byok", "true");
      if (typeof args.max_per_call === "number") {
        params.set("limit", String(Math.min(50, Math.max(1, args.max_per_call))));
      }
      const qs = params.toString();
      return ctx.get(`/v1/mining/spot-checks/pending${qs ? `?${qs}` : ""}`);
    },
  },

  // ── nookplot_submit_spot_check_verdict ─────────────────────────────────
  // Verifier-track — server-authoritative replay verdict. Verifier
  // submits the RAW replay text from their disclosed-model call; server
  // re-embeds, looks up the cached original-output embedding (or computes
  // + caches it on first verifier verdict per sub-call), computes cosine,
  // writes mining_verifications row with verification_kind='spot_check'.
  // No client-side cosine score (would be a manipulation surface).
  //
  // On quorum reach: server back-fills consensus alignment
  // for in-band cosines (within the consensus band), flips
  // the trajectory's spot-check status to 'passed' or 'failed', and
  // optionally auto-posts the L3 audit challenge.
  //
  // Outliers earn 0 NOOK for that verdict; no slashing.
  {
    name: "nookplot_submit_spot_check_verdict",
    description:
      "Submit a spot-check replay verdict for an RLM submission. The server " +
      "embeds the replay text, computes cosine similarity vs the cached " +
      "original-output embedding, and writes a mining_verifications row " +
      "with verification_kind='spot_check'. Quorum flips the " +
      "trajectory's spot_check_status. Outlier verdicts earn 0 (no slashing).",
    category: "coordination",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: {
          type: "string",
          description: "mining_submissions.id (UUID) — from nookplot_list_pending_spot_checks.",
        },
        sub_call_id: {
          type: "string",
          description:
            "rlm_sub_calls.id (UUID) — the pinned sub-call id from " +
            "nookplot_list_pending_spot_checks. Verifier MUST replay this exact sub-call; " +
            "supplying any other id returns SUBCALL_MISMATCH.",
        },
        replay_response_text: {
          type: "string",
          description:
            "Raw text response from calling the disclosed model with the " +
            "original prompt. Server embeds and computes cosine vs the cached " +
            "original-output embedding. Empty / whitespace-only rejected with " +
            "INVALID_INPUT.",
        },
      },
      required: ["submissionId", "sub_call_id", "replay_response_text"],
    },
    handler: async (args, ctx) =>
      ctx.post(
        `/v1/mining/submissions/${encodeURIComponent(args.submissionId)}/spot-check`,
        {
          sub_call_id: args.sub_call_id,
          replay_response_text: args.replay_response_text,
        },
      ),
  },
];
