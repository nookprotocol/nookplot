/**
 * Ecosystem tools — read-only queries against Nookplot's partner-protocol
 * indexer. Today this covers BOTCOIN (DACR mining on Base); future partners
 * will be added to SUPPORTED_PROTOCOLS as they're wired.
 *
 * These tools let external agents discover partner-protocol activity through
 * Nookplot's indexer without needing Nookplot-specific knowledge of receipt
 * tables, event types, or on-chain contracts.
 *
 * @module tools/ecosystem
 */

import type { ToolDef } from "./index.js";
import { isGatewayError } from "../gateway.js";

/**
 * Registered partner protocols. Append here as new partners are wired in.
 * The gateway's `/v1/index/work-receipts/*` endpoints key on the
 * lowercase `id` field.
 */
const SUPPORTED_PROTOCOLS = [
  {
    id: "botcoin",
    name: "BOTCOIN",
    description: "DACR-based proof-of-cognition mining on Base",
    contract: "0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea",
    token: "0xA601877977340862Ca67f816eb079958E5bd0BA3",
    hubUrl: "https://nookplot.com/botcoin",
    // Agent-facing SKILL.md — how an autonomous agent should install
    // tooling, authenticate, and run the mining flow end-to-end.
    skillUrl: "https://agentmoney.net/skill.md",
    homeUrl: "https://agentmoney.net",
  },
] as const;

const SUPPORTED_IDS = new Set(SUPPORTED_PROTOCOLS.map((p) => p.id));
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function assertProtocol(protocol: unknown): string {
  if (typeof protocol !== "string" || !SUPPORTED_IDS.has(protocol.toLowerCase() as any)) {
    const supported = SUPPORTED_PROTOCOLS.map((p) => p.id).join(", ");
    throw new Error(
      `Unknown protocol "${String(protocol)}". Supported: ${supported}. ` +
        `Call nookplot_ecosystem_protocols for the current list.`,
    );
  }
  return protocol.toLowerCase();
}

function assertAddress(address: unknown): string {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    throw new Error(
      `Invalid address "${String(address)}". Expected 0x-prefixed 40-char hex.`,
    );
  }
  return address.toLowerCase();
}

interface AgentWorkReceiptsResponse {
  receipts?: Array<{
    id?: number | string;
    protocol?: string;
    event_type?: string;
    epoch_id?: number | string | null;
    solve_index?: number | string | null;
    receipt_hash?: string | null;
    challenge_id?: string | null;
    domain?: string | null;
    credits_earned?: number | string | null;
    amount?: string | null;
    tx_hash?: string | null;
    _block_number?: number | string;
    _timestamp?: number | string | null;
  }>;
  summaries?: Array<Record<string, unknown>>;
}

interface WorkReceiptStatsResponse {
  protocol: string;
  totalMiners: number;
  totalSolves: number;
  totalCredits: number;
  totalRewards: string;
  nookplotMiners: number;
}

interface WorkReceiptLeaderboardResponse {
  protocol: string;
  leaderboard: Array<{
    miner: string;
    total_credits: number | string | null;
    total_solves: number | string | null;
    total_rewards: string | null;
    total_staked: string | null;
    first_seen_at?: string | null;
    last_active_at?: string | null;
    is_nookplot_agent?: boolean;
  }>;
}

export const ecosystemTools: ToolDef[] = [
  {
    name: "nookplot_ecosystem_protocols",
    description:
      "List partner protocols integrated with Nookplot's indexer. Returns id, name, description, contract address, token address, hub URL, skillUrl (agent-readable SKILL.md with the partner's full integration flow), and homeUrl for each supported protocol (e.g. BOTCOIN). Agents that want to actually perform work on a partner protocol should fetch and follow the skillUrl.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      return { protocols: SUPPORTED_PROTOCOLS.map((p) => ({ ...p })) };
    },
  },

  {
    name: "nookplot_ecosystem_stake",
    description:
      "Fetch a single agent's partner-protocol work-receipt history (e.g. BOTCOIN mining activity) from Nookplot's indexer. Returns raw receipts plus an aggregated summary (totalReceipts, totalCredits, domains).",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description:
            'Partner protocol id (e.g. "botcoin"). Call nookplot_ecosystem_protocols for the full list.',
        },
        address: {
          type: "string",
          description: "Agent wallet address (0x + 40 hex chars).",
        },
      },
      required: ["protocol", "address"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const address = assertAddress(args.address);

      const raw = (await ctx.get(
        `/v1/index/agents/${encodeURIComponent(address)}/work-receipts?protocol=${encodeURIComponent(protocol)}&limit=200`,
      )) as AgentWorkReceiptsResponse;

      const receipts = Array.isArray(raw?.receipts) ? raw.receipts : [];
      const summaries = Array.isArray(raw?.summaries) ? raw.summaries : [];

      const domains = new Set<string>();
      let totalCredits = 0;
      for (const r of receipts) {
        if (r.domain) domains.add(String(r.domain));
        const c = Number(r.credits_earned ?? 0);
        if (Number.isFinite(c)) totalCredits += c;
      }

      return {
        protocol,
        address,
        receipts,
        summaries,
        summary: {
          totalReceipts: receipts.length,
          totalCredits,
          domains: Array.from(domains).sort(),
        },
      };
    },
  },

  {
    name: "nookplot_ecosystem_stats",
    description:
      "Fetch aggregate network-wide stats for a partner protocol (total miners, total solves, total credits awarded, total token rewards, and how many miners are Nookplot-registered agents).",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description:
            'Partner protocol id (e.g. "botcoin"). Call nookplot_ecosystem_protocols for the full list.',
        },
      },
      required: ["protocol"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const res = (await ctx.get(
        `/v1/index/work-receipts/stats?protocol=${encodeURIComponent(protocol)}`,
      )) as WorkReceiptStatsResponse;
      // Endpoint already includes `protocol`, but we re-assert for callers
      // that pass a pre-validated value (e.g. mixed-case "BOTCOIN").
      return { ...res, protocol };
    },
  },

  {
    name: "nookplot_ecosystem_leaderboard",
    description:
      "Fetch the top miners for a partner protocol, sorted by credits earned or receipt count. Returns rank, miner address, totals, and whether each miner is a registered Nookplot agent.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description:
            'Partner protocol id (e.g. "botcoin"). Call nookplot_ecosystem_protocols for the full list.',
        },
        sort: {
          type: "string",
          enum: ["credits", "receipts"],
          description: 'Sort key — "credits" (default) or "receipts".',
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 10, max 50).",
        },
      },
      required: ["protocol"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const sortInput = typeof args.sort === "string" ? args.sort : "credits";
      const sort: "credits" | "receipts" =
        sortInput === "receipts" ? "receipts" : "credits";
      const rawLimit = Number(args.limit);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 50)
          : 10;

      // The gateway leaderboard endpoint supports sort=credits|rewards natively,
      // but not sort=receipts — so we always fetch a slightly wider sample and
      // re-sort client-side when the caller asks for "receipts".
      // We cap the upstream fetch at 50 (the leaderboard endpoint honors up to
      // 200, but 50 is enough for the exposed max limit).
      const upstreamSort = sort === "credits" ? "credits" : "credits";
      const fetchLimit = 50;

      const res = (await ctx.get(
        `/v1/index/work-receipts/leaderboard?protocol=${encodeURIComponent(protocol)}&sort=${encodeURIComponent(upstreamSort)}&limit=${fetchLimit}`,
      )) as WorkReceiptLeaderboardResponse;

      const rows = Array.isArray(res?.leaderboard) ? res.leaderboard.slice() : [];
      if (sort === "receipts") {
        rows.sort((a, b) => Number(b.total_solves ?? 0) - Number(a.total_solves ?? 0));
      }

      const sliced = rows.slice(0, limit).map((r, idx) => ({
        rank: idx + 1,
        miner: r.miner,
        totalCredits: Number(r.total_credits ?? 0),
        totalSolves: Number(r.total_solves ?? 0),
        totalRewards: r.total_rewards ?? "0",
        totalStaked: r.total_staked ?? "0",
        firstSeenAt: r.first_seen_at ?? null,
        lastActiveAt: r.last_active_at ?? null,
        isNookplotAgent: Boolean(r.is_nookplot_agent),
      }));

      return {
        protocol,
        sort,
        limit,
        leaderboard: sliced,
      };
    },
  },

  {
    name: "nookplot_ecosystem_stake_tokens",
    description:
      "Stake tokens into a partner-protocol staking contract (e.g. BOTCOIN mining). Builds the approve + stake transactions, signs them with the agent's wallet, and submits them on-chain. Agent pays gas in ETH on Base. If allowance is already sufficient, only the stake tx is sent. Returns txHashes + { protocol, amount, alreadyApproved }.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description:
            'Partner protocol id (e.g. "botcoin"). Call nookplot_ecosystem_protocols for the full list.',
        },
        amount: {
          type: "string",
          description:
            'Human-readable token amount to stake (e.g. "1000" for 1000 tokens). Decimals are handled server-side based on the protocol\'s token.',
        },
      },
      required: ["protocol", "amount"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const amount = typeof args.amount === "string" ? args.amount : String(args.amount ?? "");
      if (!amount) throw new Error("amount is required");

      const result = await ctx.prepareSignSend(
        "/v1/prepare/ecosystem/stake-tokens",
        { protocol, amount },
      );
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    },
  },

  // ── Protocol hub milestones (maintainer-managed) ──

  {
    name: "nookplot_protocol_milestones_list",
    description:
      "List the curated milestones shown on a partner protocol's hub page (e.g. /botcoin). Public — no auth required. Returns ordered milestones with id, headline, body, icon, category ('bonus' | 'milestone' | 'solve' | 'epoch'), milestoneDate (YYYY-MM-DD), isHighlight, sortOrder.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description:
            'Partner protocol id (e.g. "botcoin"). Call nookplot_ecosystem_protocols for the full list.',
        },
      },
      required: ["protocol"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const data = (await ctx.get(
        `/v1/protocols/${encodeURIComponent(protocol)}/milestones`,
      )) as { protocol: string; milestones: unknown[] };
      return data;
    },
  },

  {
    name: "nookplot_protocol_milestone_create",
    description:
      "Create a new milestone on a partner protocol's hub page. Caller must be a maintainer of that protocol (registered in protocol_maintainers — same role that gates Updates/Pin). Returns the created milestone row.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description: 'Partner protocol id (e.g. "botcoin").',
        },
        headline: {
          type: "string",
          description: "Short title shown bolded in the milestone row (max 200 chars).",
        },
        body: {
          type: "string",
          description: "Optional supporting detail text shown beneath the headline (max 1000 chars).",
        },
        icon: {
          type: "string",
          description:
            "Optional unicode glyph (max 8 chars, e.g. ◆ ★ ⚖ ↗). Omit/null to use the default for the chosen category.",
        },
        category: {
          type: "string",
          enum: ["bonus", "milestone", "solve", "epoch"],
          description:
            "Visual style class — drives the icon background color: bonus (gold), milestone (gold), solve (green), epoch (gold).",
        },
        milestoneDate: {
          type: "string",
          description: "Date the milestone occurred, formatted as YYYY-MM-DD.",
        },
        isHighlight: {
          type: "boolean",
          description: "If true, the row gets the 'highlight' style (gold tint + bold colored headline).",
        },
        sortOrder: {
          type: "number",
          description:
            "Higher values float to the top of the list (default 0). Use this to reorder beyond date sort.",
        },
      },
      required: ["protocol", "headline", "category", "milestoneDate"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const body: Record<string, unknown> = {
        headline: args.headline,
        category: args.category,
        milestoneDate: args.milestoneDate,
      };
      if (typeof args.body === "string") body.body = args.body;
      if (typeof args.icon === "string" || args.icon === null) body.icon = args.icon;
      if (typeof args.isHighlight === "boolean") body.isHighlight = args.isHighlight;
      if (typeof args.sortOrder === "number") body.sortOrder = args.sortOrder;

      return ctx.post(`/v1/protocols/${encodeURIComponent(protocol)}/milestones`, body);
    },
  },

  {
    name: "nookplot_protocol_milestone_update",
    description:
      "Update an existing milestone (partial — only the fields you supply are changed). Caller must be a maintainer of the protocol. Returns the updated row.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description: 'Partner protocol id (e.g. "botcoin").',
        },
        id: {
          type: "number",
          description: "Numeric id of the milestone to update (from nookplot_protocol_milestones_list).",
        },
        headline: { type: "string", description: "Optional new headline (max 200 chars)." },
        body: { type: "string", description: "Optional new body text (max 1000 chars)." },
        icon: {
          type: "string",
          description: "Optional new icon glyph (max 8 chars). Pass null to clear.",
        },
        category: {
          type: "string",
          enum: ["bonus", "milestone", "solve", "epoch"],
          description: "Optional new category.",
        },
        milestoneDate: {
          type: "string",
          description: "Optional new date (YYYY-MM-DD).",
        },
        isHighlight: { type: "boolean", description: "Optional new highlight flag." },
        sortOrder: { type: "number", description: "Optional new sort order." },
      },
      required: ["protocol", "id"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("id must be a positive integer.");
      }
      const body: Record<string, unknown> = {};
      if (typeof args.headline === "string") body.headline = args.headline;
      if (typeof args.body === "string") body.body = args.body;
      if (typeof args.icon === "string" || args.icon === null) body.icon = args.icon;
      if (typeof args.category === "string") body.category = args.category;
      if (typeof args.milestoneDate === "string") body.milestoneDate = args.milestoneDate;
      if (typeof args.isHighlight === "boolean") body.isHighlight = args.isHighlight;
      if (typeof args.sortOrder === "number") body.sortOrder = args.sortOrder;

      if (Object.keys(body).length === 0) {
        throw new Error("Supply at least one field to update.");
      }

      return ctx.patch(`/v1/protocols/${encodeURIComponent(protocol)}/milestones/${id}`, body);
    },
  },

  {
    name: "nookplot_protocol_milestone_delete",
    description:
      "Delete a milestone from a partner protocol's hub page. Caller must be a maintainer. Hard delete — there is no recycle bin.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description: 'Partner protocol id (e.g. "botcoin").',
        },
        id: {
          type: "number",
          description: "Numeric id of the milestone to delete.",
        },
      },
      required: ["protocol", "id"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("id must be a positive integer.");
      }
      return ctx.delete(`/v1/protocols/${encodeURIComponent(protocol)}/milestones/${id}`);
    },
  },

  {
    name: "nookplot_ecosystem_claim_rewards",
    description:
      "Claim finalized mining rewards from a partner-protocol staking contract (e.g. BOTCOIN). If epochIds is omitted, the gateway auto-detects finalized + unclaimed epochs with nonzero credits for this agent. Returns txHashes + { protocol, claimableEpochs }. If nothing is claimable, returns an empty txHashes array with an explanatory message.",
    category: "economy",
    inputSchema: {
      type: "object",
      properties: {
        protocol: {
          type: "string",
          description:
            'Partner protocol id (e.g. "botcoin"). Call nookplot_ecosystem_protocols for the full list.',
        },
        epochIds: {
          type: "array",
          items: { type: "number" },
          description:
            "Optional — specific epoch IDs to claim. If omitted, the gateway scans recent epochs and claims all finalized+unclaimed ones.",
        },
      },
      required: ["protocol"],
    },
    handler: async (args, ctx) => {
      const protocol = assertProtocol(args.protocol);
      const body: Record<string, unknown> = { protocol };
      if (Array.isArray(args.epochIds)) body.epochIds = args.epochIds;

      const result = await ctx.prepareSignSend(
        "/v1/prepare/ecosystem/claim-rewards",
        body,
      );
      if (isGatewayError(result)) throw new Error(result.error);
      return result.data;
    },
  },
];
