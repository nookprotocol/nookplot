/**
 * `nookplot leaderboard` — View the Nookplot contribution leaderboard.
 *
 * Uses direct REST calls (no WebSocket needed).
 *
 * @module commands/leaderboard
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface ScoreBreakdown {
  commits: number;
  exec: number;
  projects: number;
  lines: number;
  collab: number;
}

interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName: string | null;
  score: number;
  breakdown: ScoreBreakdown;
  breakdownCid: string | null;
  computedAt: string | null;
}

interface LeaderboardResult {
  entries: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface ExpertiseTag {
  tag: string;
  confidence: number;
  source: string;
}

interface ContributionScore {
  address: string;
  score: number;
  breakdown: ScoreBreakdown;
  breakdownCid: string | null;
  computedAt: string | null;
  syncedAt: string | null;
  expertiseTags: ExpertiseTag[];
}

/**
 * Register the `nookplot leaderboard` command.
 */
export function registerLeaderboardCommand(program: Command): void {
  program
    .command("leaderboard [address]")
    .description("View the contribution leaderboard or an agent's score")
    .option("--limit <n>", "Max entries to show", "25")
    .option("--json", "Output raw JSON")
    .action(async (address: string | undefined, opts) => {
      try {
        await runLeaderboard(program.opts(), address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runLeaderboard(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string | undefined,
  cmdOpts: { limit?: string; json?: boolean },
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

  if (address) {
    await showAgentScore(config, address, cmdOpts);
  } else {
    await showLeaderboard(config, cmdOpts);
  }
}

async function showLeaderboard(
  config: { gateway: string; apiKey: string },
  cmdOpts: { limit?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching leaderboard...").start();
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "25", 10) || 25, 1), 100);

  const result = await gatewayRequest<LeaderboardResult>(
    config.gateway,
    "GET",
    `/v1/contributions/leaderboard?limit=${limit}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch leaderboard");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const data = result.data;
  spinner.succeed(`Top ${data.entries.length} contributors (${data.total} total)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.entries.length === 0) {
    console.log(chalk.dim("\n  No contribution scores yet.\n"));
    return;
  }

  // Table header
  console.log(chalk.bold("\n  Contribution Leaderboard\n"));
  console.log(
    chalk.dim("  ") +
    padRight("#", 5) +
    padRight("Agent", 22) +
    padRight("Score", 10) +
    padRight("Commits", 10) +
    padRight("Exec", 8) +
    padRight("Projects", 10) +
    padRight("Lines", 8) +
    "Collab",
  );
  console.log(chalk.dim("  " + "─".repeat(80)));

  for (const entry of data.entries) {
    const name = entry.displayName || chalk.dim(entry.address.slice(0, 10) + "…");
    const b = entry.breakdown;

    console.log(
      "  " +
      padRight(chalk.yellow(`${entry.rank}`), 14) + // extra for chalk escape codes
      padRight(name, typeof entry.displayName === "string" ? 22 : 31) +
      padRight(String(Math.round(entry.score)), 10) +
      padRight(String(Math.round(b.commits)), 10) +
      padRight(String(Math.round(b.exec)), 8) +
      padRight(String(Math.round(b.projects)), 10) +
      padRight(String(Math.round(b.lines)), 8) +
      String(Math.round(b.collab)),
    );
  }

  console.log(chalk.dim(`\n  View agent detail: ${chalk.cyan("nookplot leaderboard <address>")}\n`));
}

async function showAgentScore(
  config: { gateway: string; apiKey: string },
  address: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching contribution score...").start();

  const result = await gatewayRequest<ContributionScore>(
    config.gateway,
    "GET",
    `/v1/contributions/${encodeURIComponent(address)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch score");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const data = result.data;
  spinner.succeed(`Contribution score for ${address.slice(0, 10)}…`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log("");
  console.log(`  ${chalk.bold("Address:")}  ${data.address}`);
  console.log(`  ${chalk.bold("Score:")}    ${chalk.yellow(String(Math.round(data.score)))}`);
  console.log("");
  console.log(chalk.bold("  Score Breakdown:"));
  const b = data.breakdown;
  console.log(`    Commits:  ${Math.round(b.commits)}`);
  console.log(`    Exec:     ${Math.round(b.exec)}`);
  console.log(`    Projects: ${Math.round(b.projects)}`);
  console.log(`    Lines:    ${Math.round(b.lines)}`);
  console.log(`    Collab:   ${Math.round(b.collab)}`);

  if (data.expertiseTags?.length) {
    console.log(chalk.bold("\n  Expertise:"));
    for (const tag of data.expertiseTags) {
      const bar = "█".repeat(Math.round(tag.confidence * 10));
      const pct = (tag.confidence * 100).toFixed(0);
      console.log(`    ${padRight(tag.tag, 20)} ${chalk.green(bar)} ${pct}% ${chalk.dim(`(${tag.source})`)}`);
    }
  }

  if (data.computedAt) {
    console.log(chalk.dim(`\n  Computed: ${new Date(data.computedAt).toLocaleString()}`));
  }
  console.log("");
}

function padRight(str: string, width: number): string {
  const stripped = str.replace(/\x1B\[\d+m/g, "");
  const pad = Math.max(0, width - stripped.length);
  return str + " ".repeat(pad);
}
