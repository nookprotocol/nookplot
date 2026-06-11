/**
 * Knowledge Context — auto-retrieves relevant compiled knowledge for task augmentation.
 *
 * Before an agent processes a task, call `getKnowledgeContext(taskDescription)` to
 * fetch the top relevant items from the agent's compiled knowledge graph. The result
 * is a compact markdown string (~400 tokens) ready for injection into the agent's
 * system message or task context.
 *
 * Usage:
 *   const context = await getKnowledgeContext(runtime, "review this code for security issues");
 *   // Prepend to agent prompt: context.markdown
 *   // Track which items were used: context.itemIds
 *
 * @module knowledgeContext
 */

import type { SelectionMode } from "./signalActionMap.js";

/** Minimal interface for runtime — avoids circular import with index.ts. */
interface RuntimeLike {
  connection: { request: (method: string, path: string) => Promise<unknown> };
}

// ────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────

export interface KnowledgeContextItem {
  id: string;
  title: string;
  snippet: string;
  domain: string | null;
  score: number;
  qualityScore: number | null;
}

export interface KnowledgeContextResult {
  /** Compact markdown string for prompt injection (~400 tokens max) */
  markdown: string;
  /** Item IDs for citation tracking */
  itemIds: string[];
  /** Number of items retrieved */
  count: number;
  /** Whether context was retrieved (false if search failed or returned nothing relevant) */
  available: boolean;
}

// ────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────

/** Max items to inject — each ~80 tokens, 5 × 80 = ~400 tokens */
const MAX_ITEMS = 5;

/** Minimum relevance score to include (filters noise) */
const MIN_SCORE = 0.6;

/** Minimum quality score to include (no low-quality context) */
const MIN_QUALITY = 50;

/** Max snippet length per item */
const MAX_SNIPPET = 120;

// ────────────────────────────────────────────────────────
//  Main function
// ────────────────────────────────────────────────────────

/**
 * Retrieve relevant compiled knowledge for a task description.
 * Returns a compact markdown context + item IDs for tracking.
 *
 * @deprecated Use {@link WakeUpStack} from `./wakeUpStack.ts` instead.
 * WakeUpStack provides tiered retrieval (L0 identity, L1 essentials cached
 * per-session, L2 on-demand) which reduces token cost for in-domain signals
 * from ~4000 to ~1950 tokens over a 10-signal session.
 *
 * This function is preserved for backward compatibility and is used internally
 * by WakeUpStack as the L2 on-demand search layer.
 *
 * @param runtime - Active NookplotRuntime instance
 * @param taskDescription - What the agent is about to do (used as search query)
 * @param opts - Optional overrides for max items, min score, etc.
 */
export async function getKnowledgeContext(
  runtime: RuntimeLike,
  taskDescription: string | string[],
  opts?: {
    maxItems?: number;
    minScore?: number;
    minQuality?: number;
    /**
     * MAD selection mode forwarded to the gateway as `selection_mode` query
     * param.
     */
    selectionMode?: SelectionMode;
  },
): Promise<KnowledgeContextResult> {
  const empty: KnowledgeContextResult = { markdown: "", itemIds: [], count: 0, available: false };

  // Normalize to array form (multi-query support). When passed a
  // single string this collapses to `[taskDescription]` and the URL is built
  // with a single `q=` param — identical to the legacy single-query path.
  const rawQueries = Array.isArray(taskDescription) ? taskDescription : [taskDescription];
  // Validate + trim: each query ≥ 3 chars (matches the legacy single-query
  // check). Cap at 4 query vectors (hard cap; gateway enforces the same).
  const queries = rawQueries
    .filter((q) => q && q.trim().length >= 3)
    .slice(0, 4);
  if (queries.length === 0) return empty;

  const maxItems = opts?.maxItems ?? MAX_ITEMS;
  const minScore = opts?.minScore ?? MIN_SCORE;
  const minQuality = opts?.minQuality ?? MIN_QUALITY;
  const selectionMode = opts?.selectionMode;

  try {
    // Search the agent's compiled KG (free, no credits). Multi-query callers
    // emit repeated `&q=` params — Express parses repeated keys as string[].
    const selectionParam = selectionMode ? `&selection_mode=${selectionMode}` : "";
    const qParams = queries
      .map((q) => `q=${encodeURIComponent(q.slice(0, 200))}`)
      .join("&");
    const response = await runtime.connection.request(
      "GET",
      `/v1/agents/me/knowledge?${qParams}&limit=${maxItems * 2}&include_public=false${selectionParam}`,
    ) as { results?: Array<{
      item: { id: string; title: string | null; contentText: string; domain: string | null; qualityScore: number | null };
      score: number;
    }> };

    const results = response?.results;
    if (!results || results.length === 0) return empty;

    // Filter by relevance + quality
    const filtered = results.filter(r =>
      r.score >= minScore &&
      (r.item.qualityScore === null || r.item.qualityScore >= minQuality),
    ).slice(0, maxItems);

    if (filtered.length === 0) return empty;

    // Build compact markdown context
    const lines: string[] = ["## Your compiled knowledge (auto-retrieved)", ""];
    const itemIds: string[] = [];

    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      const title = r.item.title || r.item.contentText.slice(0, 60);
      const domain = r.item.domain ? `[${r.item.domain}] ` : "";
      const snippet = r.item.contentText
        .slice(0, MAX_SNIPPET)
        .replace(/\n/g, " ")
        .trim();
      lines.push(`${i + 1}. ${domain}**${title}** — ${snippet}`);
      itemIds.push(r.item.id);
    }

    return {
      markdown: lines.join("\n"),
      itemIds,
      count: filtered.length,
      available: true,
    };
  } catch (err) {
    // Knowledge search failed — non-fatal, agent proceeds without context
    // Log for debugging (don't throw — context injection is advisory)
    if (typeof console !== "undefined") {
      console.warn("[knowledge-context] Failed to retrieve context:", err instanceof Error ? err.message : String(err));
    }
    return empty;
  }
}
