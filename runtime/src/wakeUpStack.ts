/**
 * WakeUpStack — tiered context assembly for agent knowledge retrieval.
 *
 * Replaces the flat single-shot approach of getKnowledgeContext() with a
 * 3-layer stack that balances cost and coverage:
 *
 *   L0 (Identity, ~50 tokens)   — Always loaded. Agent's top domains + role.
 *   L1 (Essentials, ~300 tokens) — Session-cached. Top syntheses + recently accessed.
 *   L2 (On-Demand, ~400 tokens)  — Per-signal when topic diverges from L1 coverage.
 *   L3 (Deep Search)             — Explicit tool call only. Already exists as unified search.
 *
 * For a 10-signal session where 7 are in-domain, total token cost drops from
 * 10×400=4000 (old flat) to 750+3×400=1950 (tiered).
 *
 * Usage:
 *   const stack = new WakeUpStack(runtime);
 *   const result = await stack.getContext("review this code for security issues");
 *   // result.markdown — inject into prompt
 *   // result.itemIds  — for citation tracking
 *
 * @module wakeUpStack
 */

import { getKnowledgeContext } from "./knowledgeContext.js";
import type { KnowledgeContextResult } from "./knowledgeContext.js";
import { SIGNAL_SELECTION_MODE, type SelectionMode } from "./signalActionMap.js";
import { segmentTaskForQuery } from "./querySegmentation.js";

/** Minimal interface for runtime — avoids circular import with index.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface RuntimeLike {
  connection: { request: (...args: any[]) => Promise<unknown> };
}

// ────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────

export interface WakeUpLayer {
  tier: 0 | 1 | 2;
  markdown: string;
  tokenEstimate: number;
  itemIds: string[];
}

export interface WakeUpResult {
  layers: WakeUpLayer[];
  /** Combined markdown for all loaded layers */
  markdown: string;
  /** Estimated total tokens */
  tokenEstimate: number;
  /** All item IDs across all layers (for citation tracking) */
  itemIds: string[];
}

interface WakeUpPayloadResponse {
  l0: {
    topDomains: { domain: string; depth: string; items: number }[];
    role: string | null;
  };
  l1: {
    essentials: {
      id: string;
      domain: string | null;
      title: string | null;
      snippet: string;
      qualityScore: number | null;
    }[];
  };
  tokenEstimate: number;
}

// ────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────

/** L1 cache TTL — 30 minutes. */
const L1_TTL_MS = 30 * 60 * 1000;

/** Minimum task/L1 keyword overlap to skip L2 search. */
const L2_OVERLAP_THRESHOLD = 0.2;

// ────────────────────────────────────────────────────────
//  WakeUpStack
// ────────────────────────────────────────────────────────

export class WakeUpStack {
  private l0l1Cache: { l0: WakeUpLayer; l1: WakeUpLayer; l1Domains: string[] } | null = null;
  private l0l1CacheAge: number = 0;

  constructor(private runtime: RuntimeLike) {}

  /**
   * Build context for a signal. Returns L0 + L1 always, L2 only if task
   * diverges from cached L1 domains.
   *
   * @param taskDescription - What the agent is about to do
   * @param signalType - Optional signal type. When provided, the L2 search
   *   uses the MAD selection mode mapped from `SIGNAL_SELECTION_MODE`
   *   to match the retrieval focus the signal type needs (e.g. `"aggressive"`
   *   for focused DMs, `"lenient"` for exploratory new-project synthesis).
   *   Unknown or omitted signal types fall back to `"moderate"`.
   */
  async getContext(taskDescription: string, signalType?: string): Promise<WakeUpResult> {
    const layers: WakeUpLayer[] = [];
    const allItemIds: string[] = [];
    let totalTokens = 0;

    // Load L0 + L1 (session-cached)
    const { l0, l1, l1Domains } = await this.loadL0L1();
    layers.push(l0, l1);
    allItemIds.push(...l0.itemIds, ...l1.itemIds);
    totalTokens += l0.tokenEstimate + l1.tokenEstimate;

    // L2: on-demand search if task diverges from L1 domains.
    // Resolve the selection mode from the signal type map — fall back to
    // "moderate" (above-median) when the signal type is unmapped or missing.
    const selectionMode: SelectionMode =
      (signalType && SIGNAL_SELECTION_MODE[signalType]) || "moderate";

    if (taskDescription && this.needsL2(taskDescription, l1Domains)) {
      const l2 = await this.loadL2(taskDescription, selectionMode);
      if (l2) {
        layers.push(l2);
        allItemIds.push(...l2.itemIds);
        totalTokens += l2.tokenEstimate;
      }
    }

    // Combine markdown
    const markdownParts: string[] = [];
    for (const layer of layers) {
      if (layer.markdown) markdownParts.push(layer.markdown);
    }

    return {
      layers,
      markdown: markdownParts.join("\n\n"),
      tokenEstimate: totalTokens,
      itemIds: allItemIds,
    };
  }

  /**
   * Force-refresh the L1 cache. Call on session start, after bulk knowledge
   * ingest, or after consolidation.
   */
  async refreshEssentials(): Promise<void> {
    this.l0l1Cache = null;
    this.l0l1CacheAge = 0;
  }

  // ────────────────────────────────────────────────────────
  //  Private
  // ────────────────────────────────────────────────────────

  private async loadL0L1(): Promise<{ l0: WakeUpLayer; l1: WakeUpLayer; l1Domains: string[] }> {
    // Return cached if fresh
    if (this.l0l1Cache && Date.now() - this.l0l1CacheAge < L1_TTL_MS) {
      return this.l0l1Cache;
    }

    try {
      const payload = await this.runtime.connection.request(
        "GET",
        "/v1/agents/me/knowledge/wake-up",
      ) as WakeUpPayloadResponse;

      // Build L0 markdown
      const l0Lines: string[] = [];
      if (payload.l0.role) {
        l0Lines.push(`**Role:** ${payload.l0.role}`);
      }
      if (payload.l0.topDomains.length > 0) {
        const domainStr = payload.l0.topDomains
          .map((d) => `${d.domain} (${d.depth}, ${d.items} items)`)
          .join(", ");
        l0Lines.push(`**Domains:** ${domainStr}`);
      }

      const l0: WakeUpLayer = {
        tier: 0,
        markdown: l0Lines.length > 0 ? `## Identity\n${l0Lines.join("\n")}` : "",
        tokenEstimate: l0Lines.length * 15,
        itemIds: [],
      };

      // Build L1 markdown
      const l1Lines: string[] = [];
      const l1ItemIds: string[] = [];
      for (const item of payload.l1.essentials) {
        const domain = item.domain ? `[${item.domain}] ` : "";
        const title = item.title || item.snippet.slice(0, 40);
        l1Lines.push(`- ${domain}**${title}** — ${item.snippet}`);
        l1ItemIds.push(item.id);
      }

      const l1: WakeUpLayer = {
        tier: 1,
        markdown: l1Lines.length > 0 ? `## Essential knowledge\n${l1Lines.join("\n")}` : "",
        tokenEstimate: l1Lines.length * 60,
        itemIds: l1ItemIds,
      };

      const l1Domains = payload.l0.topDomains.map((d) => d.domain);

      this.l0l1Cache = { l0, l1, l1Domains };
      this.l0l1CacheAge = Date.now();
      return this.l0l1Cache;
    } catch (err) {
      // Wake-up endpoint failed — return empty layers, degrade gracefully
      if (typeof console !== "undefined") {
        console.warn("[wake-up-stack] Failed to load L0+L1:", err instanceof Error ? err.message : String(err));
      }
      const empty: WakeUpLayer = { tier: 0, markdown: "", tokenEstimate: 0, itemIds: [] };
      return { l0: empty, l1: { ...empty, tier: 1 }, l1Domains: [] };
    }
  }

  /**
   * L2: on-demand search using the existing getKnowledgeContext() mechanism.
   * Only fires when the task description doesn't overlap L1 domains.
   *
   * @param selectionMode - MAD selection mode forwarded to the gateway as
   *   `selection_mode` query param. Controls how aggressively the gateway
   *   trims the candidate set below median+MAD.
   *
   * The task description is split into up to 4 query strings
   * (full + sliding windows + entities + question spans) via
   * `segmentTaskForQuery`, and the gateway takes the MAX similarity across
   * all of them. On short/simple queries this collapses to the single-string
   * baseline — the first element is always the full task.
   */
  private async loadL2(
    taskDescription: string,
    selectionMode: SelectionMode = "moderate",
  ): Promise<WakeUpLayer | null> {
    try {
      // Multi-segment query expansion. `segmentTaskForQuery` emits
      // just `[taskDescription]` for short tasks, preserving backward compat.
      const queries = segmentTaskForQuery(taskDescription, 4);
      const queryInput: string | string[] = queries.length > 1 ? queries : taskDescription;

      const result: KnowledgeContextResult = await getKnowledgeContext(
        this.runtime,
        queryInput,
        { maxItems: 5, minScore: 0.5, minQuality: 40, selectionMode },
      );

      if (!result.available || result.count === 0) return null;

      return {
        tier: 2,
        markdown: result.markdown,
        tokenEstimate: result.count * 80,
        itemIds: result.itemIds,
      };
    } catch {
      // L2 failure is non-fatal — L0+L1 still provide context
      return null;
    }
  }

  /**
   * Simple heuristic: check whether the task description overlaps the agent's
   * top domains. If <20% overlap, the task is outside L1's coverage and we
   * need L2 search.
   *
   * False positive (unnecessary L2): costs ~100ms + ~400 tokens — acceptable.
   * False negative (missing context): worse but unlikely for well-populated KGs.
   */
  private needsL2(taskDescription: string, l1Domains: string[]): boolean {
    if (l1Domains.length === 0) return true; // No L1 — always search

    const taskWords = new Set(
      taskDescription
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

    if (taskWords.size === 0) return true;

    const domainWords = new Set(
      l1Domains.flatMap((d) => d.toLowerCase().split(/[-_\s]/)),
    );

    let overlap = 0;
    for (const w of taskWords) {
      if (domainWords.has(w)) overlap++;
    }

    return overlap / taskWords.size < L2_OVERLAP_THRESHOLD;
  }
}
