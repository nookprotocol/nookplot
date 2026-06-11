/**
 * Unified mining loop for the Nookplot Agent Runtime SDK.
 *
 * Surfaces a single `np.mining.start()` API that handles the full
 * "discover → rank → solve → submit" cycle across all enabled tracks
 * (knowledge, embedding, RLM). Per-track solver dispatch is private
 * here — solver implementations call out to the gateway via
 * `connection.request()` and the user's existing inference setup
 * (BYOK / local Ollama / gateway-credit-based inference).
 *
 * Usage from the CLI's `nookplot mine` command:
 *   const session = await runtime.mining.start({
 *     tracks: ["knowledge", "embedding", "rlm"],
 *     maxCredits: 5000,
 *     once: false,
 *   });
 *   await session.until(() => process.signals.interrupted);
 *   await session.stop();
 *
 * Same surface from the `mining_opportunity` autonomous handler:
 *   await runtime.mining.runOnce({ tracks: ["knowledge"] });
 *
 * @module mining
 */

import type { ConnectionManager } from "./connection.js";
import type { EconomyManager } from "./economy.js";

export type MiningTrack = "knowledge" | "embedding" | "rlm" | "gradient";

/**
 * Options shared by every mining entry point — the per-tick concerns that
 * apply to both single-shot (`runOnce`) and long-running (`start`) modes.
 */
export interface MiningTickOptions {
  /** Tracks to mine. `'auto'` queries the gateway for tracks with open challenges. */
  tracks?: MiningTrack[] | "auto";
  /** Optional guild to attribute submissions to (for guild-tier reward boost). */
  guildId?: string;
  /** Log decisions but don't submit. Default false. */
  dryRun?: boolean;
  /** Print scoring math for each ranked challenge. Default false. */
  explain?: boolean;
  /**
   * User-supplied embedding generator. Required for the embedding track —
   * the runtime intentionally does not bundle an Ollama client because that
   * is a CLI concern. If absent, the embedding track is skipped with a clear
   * "no embedding generator provided" status.
   */
  generateEmbeddings?: (prompts: string[], dimensions: number) => Promise<number[][]>;
  /**
   * Override the default knowledge solver. Receives the challenge object,
   * returns the trace text. Defaults to a single inference call seeded with
   * the challenge title + description.
   */
  solveKnowledge?: (challenge: ChallengeSummary, economy: EconomyManager) => Promise<string>;
  /**
   * Override the default RLM solver. Default is a no-op stub that records
   * "deferred" — full RLM autosolve is gated on a future phase. Custom
   * solvers can drive the REPL via `runtime.connection.request()`.
   */
  solveRlm?: (challenge: ChallengeSummary, economy: EconomyManager) => Promise<TrackResult>;
  /** Optional verbose logger. Defaults to no-op. */
  log?: (msg: string) => void;
}

/**
 * Options for the long-running loop mode (`start`). Adds budget caps and
 * tick scheduling that don't apply to single-shot dispatch.
 */
export interface MiningStartOptions extends MiningTickOptions {
  /** Total credit budget for this session across all RLM sub-calls. Defaults to 5000. */
  maxCredits?: number;
  /** Solve all currently-open challenges, then exit. Default false. */
  once?: boolean;
  /** Tick interval in milliseconds. Default 60_000. */
  tickIntervalMs?: number;
}

export interface ChallengeSummary {
  id: string;
  track: MiningTrack;
  title: string;
  description?: string;
  difficulty: "easy" | "medium" | "hard" | "expert";
  estimatedRewardNook: number;
  domainTags: string[];
  sourceType: string;
  closesAt: string;
  /** Filled after rank() with the challenge's composite score. */
  rankScore?: number;
}

export interface TrackResult {
  track: MiningTrack;
  challengeId: string;
  status: "submitted" | "skipped" | "error";
  reason?: string;
  submissionId?: string;
  estimatedRewardNook?: number;
}

export interface MiningStats {
  ticks: number;
  attempted: number;
  submitted: number;
  /** Solver chose not to submit (no prompts, trace too short, no callback, etc.). */
  skipped: number;
  /** Suppressed submissions because of `dryRun: true`. Counted separately so
   * the end-of-session banner can distinguish a dry-run from real skips. */
  dryRun: number;
  errors: number;
  creditsSpent: number;
  byTrack: Record<MiningTrack, { attempted: number; submitted: number; errors: number }>;
}

export interface MiningSession {
  /** Resolves when the session has stopped (either via `stop()` or `once: true` completion). */
  done: Promise<void>;
  /** Request graceful shutdown. Idempotent. */
  stop(): Promise<void>;
  /** Snapshot of running stats. */
  stats(): MiningStats;
}

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_MAX_CREDITS = 5000;

/**
 * Local credit cost estimates per submitted solve, used only for client-side
 * budget enforcement (the gateway is the authoritative deductor). Values track
 * the gateway's per-route rate-limit credit costs — bump these
 * when the gateway costs change. Keep in sync with the Python runtime's
 * mining `_BUDGET_COST_*` constants.
 */
const BUDGET_COST_KNOWLEDGE_SUBMIT = 50;
const BUDGET_COST_EMBEDDING_SUBMIT = 5;

const DIFFICULTY_RANK: Record<string, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 4,
};

// ─── Track classification ───────────────────────────────────────────────

export function trackOf(sourceType: string): MiningTrack {
  if (sourceType === "embedding_generation") return "embedding";
  if (sourceType === "rlm_trajectory" || sourceType === "rlm_audit") return "rlm";
  return "knowledge";
}

// ─── MiningManager ──────────────────────────────────────────────────────

export class MiningManager {
  private readonly connection: ConnectionManager;
  private readonly economy: EconomyManager;
  private activeSession: MiningSession | null = null;

  constructor(connection: ConnectionManager, economy: EconomyManager) {
    this.connection = connection;
    this.economy = economy;
  }

  /**
   * Start a long-running mining session. Returns immediately; the loop runs
   * in the background until `session.stop()` or `once: true` completion.
   */
  async start(opts: MiningStartOptions = {}): Promise<MiningSession> {
    if (this.activeSession) {
      throw new Error("MiningManager: a session is already active. Call stop() first.");
    }
    const session = this.makeSession(opts);
    this.activeSession = session;
    return session;
  }

  /**
   * Run one tick (discover → rank → solve top → submit) and return the
   * results. Suitable for `mining_opportunity` autonomous-handler dispatch.
   * Loop-only options (`maxCredits`, `tickIntervalMs`, `once`) are not
   * accepted here — they're meaningless for a single-shot call.
   */
  async runOnce(opts: MiningTickOptions = {}): Promise<TrackResult[]> {
    return this.tick(opts, { creditsSpent: 0 });
  }

  /** Snapshot stats from the active session, if any. */
  stats(): MiningStats | null {
    return this.activeSession?.stats() ?? null;
  }

  // ─── Internal: session bookkeeping ────────────────────────────────────

  private makeSession(opts: MiningStartOptions): MiningSession {
    const log = opts.log ?? (() => undefined);
    const tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    const maxCredits = opts.maxCredits ?? DEFAULT_MAX_CREDITS;
    const stats: MiningStats = {
      ticks: 0,
      attempted: 0,
      submitted: 0,
      skipped: 0,
      dryRun: 0,
      errors: 0,
      creditsSpent: 0,
      byTrack: {
        knowledge: { attempted: 0, submitted: 0, errors: 0 },
        embedding: { attempted: 0, submitted: 0, errors: 0 },
        rlm:       { attempted: 0, submitted: 0, errors: 0 },
        gradient:  { attempted: 0, submitted: 0, errors: 0 },
      },
    };
    const budget = { creditsSpent: 0 };
    let stopped = false;
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });

    const runLoop = async (): Promise<void> => {
      while (!stopped) {
        stats.ticks++;
        try {
          if (budget.creditsSpent >= maxCredits) {
            log(`[mining] budget exhausted (${budget.creditsSpent}/${maxCredits} credits) — stopping`);
            break;
          }
          const results = await this.tick(opts, budget);
          for (const r of results) {
            stats.attempted++;
            stats.byTrack[r.track].attempted++;
            if (r.status === "submitted") {
              stats.submitted++;
              stats.byTrack[r.track].submitted++;
            } else if (r.status === "skipped") {
              if (r.reason === "dry-run") stats.dryRun++;
              else stats.skipped++;
            } else {
              stats.errors++;
              stats.byTrack[r.track].errors++;
            }
          }
          stats.creditsSpent = budget.creditsSpent;
          if (opts.once && results.length === 0) {
            log("[mining] no challenges remaining — once mode complete");
            break;
          }
          if (opts.once) {
            // In `once` mode, do not sleep — the next tick happens immediately
            // and exits when the queue drains.
            continue;
          }
        } catch (err) {
          log(`[mining][error] tick failed: ${err instanceof Error ? err.message : String(err)}`);
          stats.errors++;
        }
        if (stopped) break;
        await sleep(tickMs);
      }
      resolveDone();
    };

    void runLoop();

    return {
      done,
      stop: async () => {
        stopped = true;
        await done;
        this.activeSession = null;
      },
      stats: () => ({ ...stats, byTrack: { ...stats.byTrack } }),
    };
  }

  // ─── Internal: one tick ───────────────────────────────────────────────

  private async tick(opts: MiningTickOptions, budget: { creditsSpent: number }): Promise<TrackResult[]> {
    const log = opts.log ?? (() => undefined);
    const tracks = await this.resolveTracks(opts.tracks);
    if (tracks.length === 0) {
      log("[mining] no eligible tracks — exiting tick");
      return [];
    }

    // 1. Discover open challenges across all enabled tracks.
    const challenges = await this.discoverAcross(tracks);
    if (challenges.length === 0) {
      log("[mining] no open challenges across enabled tracks");
      return [];
    }

    // 2. Rank by (reward × difficulty) / 1.0 — successRate is unknown locally,
    // so the loop uses a difficulty-weighted estimate. The earnings-preview
    // endpoint surfaces successRate to the user up-front via the CLI banner.
    const ranked = challenges
      .map((c) => ({ ...c, rankScore: c.estimatedRewardNook * (DIFFICULTY_RANK[c.difficulty] ?? 1) }))
      .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));

    if (opts.explain) {
      for (const c of ranked.slice(0, 5)) {
        log(`[mining][rank] ${c.track}/${c.id} reward=${c.estimatedRewardNook} difficulty=${c.difficulty} score=${c.rankScore}`);
      }
    }

    // 3. Solve top challenge. `once` mode keeps draining on subsequent ticks.
    const top = ranked[0];
    const result = await this.solveOne(top, opts, budget);
    return [result];
  }

  // ─── Internal: track resolution ───────────────────────────────────────

  private async resolveTracks(input: MiningStartOptions["tracks"]): Promise<MiningTrack[]> {
    if (Array.isArray(input)) return input;
    // 'auto' or undefined: ask the gateway which tracks have open challenges.
    try {
      const res = await this.connection.request<{
        tracks: Array<{ track: MiningTrack; openCount: number }>;
      }>("GET", "/v1/mining/earnings-preview?capabilities=knowledge,embedding,rlm");
      return res.tracks.filter((t) => t.openCount > 0).map((t) => t.track);
    } catch {
      // Fallback: try all three solver tracks.
      return ["knowledge", "embedding", "rlm"];
    }
  }

  // ─── Internal: discovery ──────────────────────────────────────────────

  private async discoverAcross(tracks: MiningTrack[]): Promise<ChallengeSummary[]> {
    const results: ChallengeSummary[] = [];
    for (const track of tracks) {
      try {
        if (track === "embedding") {
          results.push(...await this.discoverEmbedding());
        } else if (track === "rlm") {
          results.push(...await this.discoverRlm());
        } else if (track === "knowledge") {
          results.push(...await this.discoverKnowledge());
        }
      } catch {
        // Per-track failure isolation — a single track's discovery error must
        // not poison the others.
      }
    }
    return results;
  }

  private async discoverKnowledge(): Promise<ChallengeSummary[]> {
    const data = await this.connection.request<{ challenges: Array<{
      id: string; title: string; description?: string; difficulty: string;
      estimatedRewardNook: number; domainTags?: string[]; sourceType: string; closesAt: string;
    }> }>("GET", "/v1/mining/challenges?status=open&limit=20");
    return (data.challenges ?? [])
      // Knowledge bucket = anything not embedding / RLM.
      .filter((c) => trackOf(c.sourceType) === "knowledge")
      .map((c) => this.toSummary(c, "knowledge"));
  }

  private async discoverEmbedding(): Promise<ChallengeSummary[]> {
    const data = await this.connection.request<{ challenges: Array<{
      id: string; title: string; description?: string; difficulty?: string;
      estimatedRewardNook?: number; domainTags?: string[]; sourceType?: string; closesAt: string;
    }> }>("GET", "/v1/mining/embedding-challenges?status=open&limit=20");
    return (data.challenges ?? []).map((c) => this.toSummary({
      ...c,
      difficulty: c.difficulty ?? "medium",
      estimatedRewardNook: c.estimatedRewardNook ?? 0,
      sourceType: c.sourceType ?? "embedding_generation",
    }, "embedding"));
  }

  private async discoverRlm(): Promise<ChallengeSummary[]> {
    const data = await this.connection.request<{ challenges: Array<{
      id: string; title: string; description?: string; difficulty: string;
      estimatedRewardNook: number; domainTags?: string[]; sourceType: string; closesAt: string;
    }> }>("GET", "/v1/mining/challenges?status=open&sourceType=rlm_trajectory&limit=20");
    return (data.challenges ?? []).map((c) => this.toSummary(c, "rlm"));
  }

  private toSummary(c: {
    id: string; title: string; description?: string; difficulty: string;
    estimatedRewardNook: number; domainTags?: string[]; sourceType: string; closesAt: string;
  }, track: MiningTrack): ChallengeSummary {
    return {
      id: c.id,
      track,
      title: c.title,
      description: c.description,
      difficulty: (c.difficulty as ChallengeSummary["difficulty"]) ?? "medium",
      estimatedRewardNook: c.estimatedRewardNook ?? 0,
      domainTags: c.domainTags ?? [],
      sourceType: c.sourceType,
      closesAt: c.closesAt,
    };
  }

  // ─── Internal: per-track solvers ──────────────────────────────────────

  private async solveOne(
    challenge: ChallengeSummary,
    opts: MiningTickOptions,
    budget: { creditsSpent: number },
  ): Promise<TrackResult> {
    const log = opts.log ?? (() => undefined);
    if (opts.dryRun) {
      log(`[mining][dry-run] would solve ${challenge.track}/${challenge.id} (${challenge.title.slice(0, 60)})`);
      return { track: challenge.track, challengeId: challenge.id, status: "skipped", reason: "dry-run", estimatedRewardNook: challenge.estimatedRewardNook };
    }
    try {
      if (challenge.track === "knowledge") {
        return await this.solveKnowledgeChallenge(challenge, opts, budget);
      }
      if (challenge.track === "embedding") {
        return await this.solveEmbeddingChallenge(challenge, opts, budget);
      }
      if (challenge.track === "rlm") {
        return await this.solveRlmChallenge(challenge, opts, budget);
      }
      return { track: challenge.track, challengeId: challenge.id, status: "skipped", reason: "no solver for track" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[mining][error] solver ${challenge.track}/${challenge.id}: ${msg}`);
      return { track: challenge.track, challengeId: challenge.id, status: "error", reason: msg };
    }
  }

  private async solveKnowledgeChallenge(
    challenge: ChallengeSummary,
    opts: MiningTickOptions,
    budget: { creditsSpent: number },
  ): Promise<TrackResult> {
    const trace = opts.solveKnowledge
      ? await opts.solveKnowledge(challenge, this.economy)
      : await this.defaultKnowledgeSolver(challenge);
    if (!trace || trace.length < 50) {
      return { track: "knowledge", challengeId: challenge.id, status: "skipped", reason: "trace too short" };
    }
    const submission = await this.connection.request<{ submissionId: string }>(
      "POST",
      `/v1/mining/submissions/${encodeURIComponent(challenge.id)}`,
      { traceContent: trace, guildId: opts.guildId },
    );
    // Gateway is the authoritative deductor; this estimate exists only so the
    // local --max-credits cap trips before sending too many submissions.
    budget.creditsSpent += BUDGET_COST_KNOWLEDGE_SUBMIT;
    return {
      track: "knowledge",
      challengeId: challenge.id,
      status: "submitted",
      submissionId: submission.submissionId,
      estimatedRewardNook: challenge.estimatedRewardNook,
    };
  }

  private async defaultKnowledgeSolver(challenge: ChallengeSummary): Promise<string> {
    const prompt = [
      `Solve the following reasoning challenge. Show your full reasoning trace.`,
      ``,
      `Title: ${challenge.title}`,
      challenge.description ? `Description: ${challenge.description}` : ``,
      ``,
      `Domains: ${challenge.domainTags.join(", ") || "general"}`,
      `Difficulty: ${challenge.difficulty}`,
    ].join("\n");
    const result = await this.economy.inference([{ role: "user", content: prompt }], { temperature: 0.4 });
    return (result.content ?? "").trim();
  }

  private async solveEmbeddingChallenge(
    challenge: ChallengeSummary,
    opts: MiningTickOptions,
    budget: { creditsSpent: number },
  ): Promise<TrackResult> {
    if (!opts.generateEmbeddings) {
      return { track: "embedding", challengeId: challenge.id, status: "skipped", reason: "no generateEmbeddings callback provided" };
    }
    const detail = await this.connection.request<{
      prompts?: string[]; dimensions?: number;
    }>("GET", `/v1/mining/embedding-challenges/${encodeURIComponent(challenge.id)}`);
    const prompts = detail.prompts ?? [];
    const dimensions = detail.dimensions ?? 768;
    if (prompts.length === 0) {
      return { track: "embedding", challengeId: challenge.id, status: "skipped", reason: "challenge has no prompts" };
    }
    const vectors = await opts.generateEmbeddings(prompts, dimensions);
    if (vectors.length !== prompts.length) {
      return { track: "embedding", challengeId: challenge.id, status: "error", reason: `vector count mismatch (got ${vectors.length}, expected ${prompts.length})` };
    }
    const submission = await this.connection.request<{ submissionId: string }>(
      "POST",
      `/v1/mining/embedding-challenges/${encodeURIComponent(challenge.id)}/submit`,
      { vectors, guildId: opts.guildId },
    );
    budget.creditsSpent += BUDGET_COST_EMBEDDING_SUBMIT;
    return {
      track: "embedding",
      challengeId: challenge.id,
      status: "submitted",
      submissionId: submission.submissionId,
      estimatedRewardNook: challenge.estimatedRewardNook,
    };
  }

  private async solveRlmChallenge(
    challenge: ChallengeSummary,
    opts: MiningStartOptions,
    _budget: { creditsSpent: number },
  ): Promise<TrackResult> {
    if (opts.solveRlm) return opts.solveRlm(challenge, this.economy);
    // Default behaviour: skip with a clear "deferred" reason. Full RLM
    // autosolve requires an LLM that can plan REPL steps — a future phase
    // ships that. CLI users with a custom solver can pass `solveRlm` here.
    return {
      track: "rlm",
      challengeId: challenge.id,
      status: "skipped",
      reason: "RLM autosolve deferred — pass `solveRlm` to mine the RLM track",
      estimatedRewardNook: challenge.estimatedRewardNook,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
