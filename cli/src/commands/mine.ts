/**
 * `nookplot mine` — Unified mining loop across all enabled tracks.
 *
 * Auto-detects local capabilities (env vars / Ollama / Python / GPU), shows an
 * earnings-preview banner per track, then runs `np.mining.start()` until
 * Ctrl+C / once-mode completion / budget exhaustion.
 *
 * Examples:
 *   nookplot mine                       # auto-detect + run
 *   nookplot mine --tracks knowledge,rlm
 *   nookplot mine --once                # solve open queue, then exit
 *   nookplot mine --max-credits 5000
 *   nookplot mine --guild <guildId>
 *   nookplot mine --dry-run             # log decisions, no submissions
 *   nookplot mine --explain             # print scoring math
 *
 * @module commands/mine
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { NookplotRuntime, type MiningTrack } from "@nookplot/runtime";

import { loadConfig, validateConfig } from "../config.js";
import {
  CAPABILITY_REFRESH_INTERVAL_MS,
  detectCapabilities,
  enabledTracks,
  type MiningCapability,
} from "../utils/miningCapabilities.js";

const VALID_TRACKS: readonly MiningTrack[] = ["knowledge", "embedding", "rlm", "gradient"];

interface MineCommandOptions {
  tracks?: string;
  once?: boolean;
  maxCredits?: string;
  guild?: string;
  dryRun?: boolean;
  explain?: boolean;
  tickInterval?: string;
}

/** Register `nookplot mine` on the commander program. */
export function registerMineCommand(program: Command): void {
  program
    .command("mine")
    .description("Run a unified mining loop across all enabled tracks")
    .option("--tracks <list>", "Comma-separated subset of tracks to mine (default: auto-detect)")
    .option("--once", "Solve all currently-open challenges, then exit")
    .option("--max-credits <n>", "Total credit budget for this session (default: 5000)")
    .option("--guild <id>", "Submit through a guild for tier boost")
    .option("--dry-run", "Show what would happen without submitting")
    .option("--explain", "Print scoring math for ranked challenges")
    .option("--tick-interval <ms>", "Loop tick interval in ms (default: 60000)")
    .action(async (opts: MineCommandOptions) => {
      try {
        await runMine(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nMine failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runMine(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: MineCommandOptions,
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  // ── 1. Detect capabilities ─────────────────────────────────────────
  const detectSpinner = ora("Detecting mining capabilities...").start();
  let caps = await detectCapabilities();
  detectSpinner.stop();

  // ── 2. Filter to user-requested tracks (if any) ───────────────────
  let tracks: MiningTrack[];
  if (opts.tracks) {
    const requested = opts.tracks
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is MiningTrack => (VALID_TRACKS as readonly string[]).includes(s));
    if (requested.length === 0) {
      console.error(chalk.red(`  ✗ No valid tracks in --tracks. Allowed: ${VALID_TRACKS.join(", ")}`));
      process.exit(1);
    }
    tracks = enabledTracks(caps).filter((t) => requested.includes(t));
    if (tracks.length === 0) {
      console.error(chalk.red(`  ✗ None of the requested tracks (${requested.join(", ")}) are enabled locally.`));
      printCapabilityBanner(caps);
      process.exit(1);
    }
  } else {
    tracks = enabledTracks(caps);
  }

  if (tracks.length === 0) {
    console.error(chalk.red("  ✗ No mining tracks are enabled. Set up at least one of:"));
    printCapabilityBanner(caps);
    process.exit(1);
  }

  // ── 3. Show earnings preview banner ────────────────────────────────
  const runtime = new NookplotRuntime({
    gatewayUrl: config.gateway,
    apiKey: config.apiKey,
    privateKey: config.privateKey || undefined,
  });

  const previewSpinner = ora("Fetching earnings preview...").start();
  let preview: Array<{ track: MiningTrack; openCount: number; estNookPerHour: number; successRate: number }> = [];
  try {
    const res = await runtime.connection.request<{
      tracks: Array<{ track: MiningTrack; openCount: number; estNookPerHour: number; successRate: number }>;
      totalEstNookPerHour: number;
    }>("GET", `/v1/mining/earnings-preview?capabilities=${tracks.join(",")}`);
    preview = res.tracks;
    previewSpinner.stop();
  } catch (err) {
    previewSpinner.warn("Earnings preview unavailable — proceeding without estimates");
  }

  printCapabilityBanner(caps, preview);

  // ── 4. Build and start the mining session ─────────────────────────
  await runtime.connect().catch((err) => {
    console.error(chalk.red(`  ✗ Connect failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });

  const maxCredits = opts.maxCredits ? parseInt(opts.maxCredits, 10) : 5000;
  const tickIntervalMs = opts.tickInterval ? parseInt(opts.tickInterval, 10) : 60_000;
  const guildId = opts.guild;
  // Always surface error-tagged lines; `--explain` opts in to all loop chatter.
  // Runtime mining loop uses `[mining][error] ...` for failures and other
  // `[mining] ...` / `[mining][rank] ...` tags for trace-level info.
  const log = (msg: string): void => {
    if (opts.explain || msg.startsWith("[mining][error]")) console.log(chalk.dim(msg));
  };

  const generateEmbeddings = makeOllamaEmbedder();

  console.log(chalk.green(`\n  Starting mining loop... press Ctrl+C to stop.\n`));

  const session = await runtime.mining.start({
    tracks,
    maxCredits,
    guildId,
    once: opts.once,
    dryRun: opts.dryRun,
    explain: opts.explain,
    tickIntervalMs,
    generateEmbeddings,
    log,
  });

  // ── 5. Schedule periodic capability re-detect (1h cadence) + SIGHUP refresh
  const refreshTimer = setInterval(async () => {
    caps = await detectCapabilities();
    if (opts.explain) {
      console.log(chalk.dim(`[mine] capabilities refreshed — ${caps.filter((c) => c.enabled).map((c) => c.track).join(", ")}`));
    }
  }, CAPABILITY_REFRESH_INTERVAL_MS);

  process.on("SIGHUP", async () => {
    caps = await detectCapabilities();
    console.log(chalk.dim(`[mine] SIGHUP — capabilities re-detected: ${caps.filter((c) => c.enabled).map((c) => c.track).join(", ")}`));
  });

  // ── 6. Graceful shutdown on SIGINT ─────────────────────────────────
  const shutdown = async (): Promise<void> => {
    clearInterval(refreshTimer);
    await session.stop();
    const stats = session.stats();
    const dryRunNote = stats.dryRun > 0 ? ` Dry-run ${stats.dryRun}.` : "";
    console.log(chalk.dim(
      `\n  Mined ${stats.submitted} submissions in ${stats.ticks} ticks.`
      + ` Skipped ${stats.skipped}.${dryRunNote} Errors ${stats.errors}.`
      + ` Spent ${stats.creditsSpent} credits (estimate).`,
    ));
    await runtime.disconnect().catch(() => undefined);
  };
  process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });

  await session.done;
  await shutdown();
}

// ─── Capability banner ─────────────────────────────────────────────────

function printCapabilityBanner(
  caps: MiningCapability[],
  preview?: Array<{ track: MiningTrack; openCount: number; estNookPerHour: number; successRate: number }>,
): void {
  const lookup = new Map(preview?.map((p) => [p.track, p]));
  let total = 0;
  for (const c of caps) {
    const mark = c.enabled ? chalk.green("✓") : chalk.red("✗");
    const provider = c.provider ? chalk.dim(`  ${c.provider}`) : "";
    const reason = c.reason ? chalk.dim(`  ${c.reason}`) : "";
    const trackLabel = c.track.padEnd(11);
    const p = lookup.get(c.track);
    const estStr = p && c.enabled
      ? chalk.cyan(`  ~${p.estNookPerHour.toLocaleString()} NOOK/hr (${p.openCount} open, ${(p.successRate * 100).toFixed(0)}% success)`)
      : "";
    console.log(`  ${mark} ${trackLabel}${provider || reason}${estStr}`);
    if (c.enabled && p) total += p.estNookPerHour;
  }
  if (total > 0) {
    console.log(chalk.bold(`  Total expected: ~${total.toLocaleString()} NOOK/hr`));
  }
}

// ─── Embedding callback (local Ollama) ─────────────────────────────────

/**
 * Native dimension of the only Ollama model the CLI knows how to call. The
 * embedding track will skip any challenge with a different `dimensions` ask
 * — no silent vector-count mismatch, no fallback to a similar-but-wrong
 * embedder. Future work: route to a different model when the challenge
 * specifies one.
 */
const OLLAMA_NOMIC_DIM = 768;

function makeOllamaEmbedder(): (prompts: string[], dimensions: number) => Promise<number[][]> {
  return async (prompts, dimensions) => {
    if (dimensions !== OLLAMA_NOMIC_DIM) {
      throw new Error(
        `Ollama embedder only supports nomic-embed-text (${OLLAMA_NOMIC_DIM}-d), `
        + `but challenge requested ${dimensions}-d vectors`,
      );
    }
    const out: number[][] = [];
    for (const prompt of prompts) {
      try {
        const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "nomic-embed-text", prompt }),
        });
        if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
        const data = (await res.json()) as { embedding?: number[] };
        if (!data.embedding || data.embedding.length !== OLLAMA_NOMIC_DIM) {
          throw new Error(
            `ollama returned ${data.embedding?.length ?? 0}-d embedding, expected ${OLLAMA_NOMIC_DIM}-d`,
          );
        }
        out.push(data.embedding);
      } catch (err) {
        throw new Error(`Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  };
}
