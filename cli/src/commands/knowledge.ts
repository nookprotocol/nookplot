/**
 * `nookplot knowledge` — Semantic knowledge search and earnings.
 *
 * Usage:
 *   nookplot knowledge query <text>   — Search all knowledge
 *   nookplot knowledge earnings       — View attribution revenue
 *   nookplot knowledge topics         — View inferred topic map
 *
 * @module commands/knowledge
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface QueryResultItem {
  contentType: string;
  contentId: string;
  title: string;
  snippet: string;
  compositeScore: number;
  semanticScore: number;
  ftsScore: number;
  creatorAddress: string | null;
  creatorName: string | null;
  createdAt: string;
}

interface QueryResponse {
  results: QueryResultItem[];
  query: string;
  totalResults: number;
  costCredits: number;
  durationMs: number;
  mode: "hybrid" | "fts_only";
}

interface EarningsResponse {
  totalEarned: number;
  attributionCount: number;
  topContent: Array<{
    contentType: string;
    contentId: string;
    totalEarned: number;
    queryCount: number;
  }>;
}

interface TopicItem {
  topic: string;
  queryCount: number;
  lastQueried: string;
}

export function registerKnowledgeCommand(program: Command): void {
  const cmd = program
    .command("knowledge")
    .description("Semantic knowledge search and earnings");

  // ---- nookplot knowledge query <text> ----
  cmd
    .command("query <text...>")
    .description("Search all published knowledge")
    .option("--types <types>", "Filter by content types (comma-separated: bundle,project,paper,bounty,task,resource,teaching)")
    .option("--limit <n>", "Max results (1-20)", "10")
    .option("--min-quality <n>", "Minimum quality score (0-100)")
    .option("--json", "Output raw JSON")
    .action(async (textParts: string[], opts) => {
      const config = loadConfig();
      const errors = validateConfig(config);
      if (errors.length > 0) {
        console.error(chalk.red("Configuration errors:"));
        errors.forEach((e) => console.error(`  - ${e}`));
        process.exit(1);
      }

      const query = textParts.join(" ");
      const spinner = ora(`Searching: "${query}"`).start();

      const body: Record<string, unknown> = {
        query,
        limit: parseInt(opts.limit, 10),
      };
      if (opts.types) {
        body.types = opts.types.split(",").map((t: string) => t.trim());
      }
      if (opts.minQuality) {
        body.minQuality = parseInt(opts.minQuality, 10);
      }

      const res = await gatewayRequest<QueryResponse>(
        config.gateway,
        "POST",
        "/v1/knowledge/query",
        { body, apiKey: config.apiKey },
      );

      if (isGatewayError(res)) {
        spinner.fail(`Query failed: ${res.error}`);
        process.exit(1);
      }

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      const data = res.data;
      console.log(chalk.bold(`\n  Knowledge Query Results (${data.mode})`));
      console.log(chalk.dim(`  ${data.totalResults} results in ${data.durationMs}ms — cost: ${data.costCredits} credits\n`));

      if (data.results.length === 0) {
        console.log(chalk.yellow("  No results found.\n"));
        return;
      }

      for (let i = 0; i < data.results.length; i++) {
        const r = data.results[i];
        const typeLabel = chalk.cyan(`[${r.contentType}]`);
        const score = chalk.dim(`score: ${r.compositeScore.toFixed(3)}`);
        const creator = r.creatorName
          ? chalk.green(r.creatorName) + chalk.dim(` ${r.creatorAddress?.slice(0, 6) ?? ""}`)
          : chalk.dim(r.creatorAddress?.slice(0, 10) ?? "unknown");

        console.log(`  ${chalk.bold(`${i + 1}.`)} ${typeLabel} ${chalk.white(r.title)} ${score}`);
        console.log(`     ${chalk.dim(r.snippet.slice(0, 120))}`);
        console.log(`     by ${creator}`);
        console.log();
      }
    });

  // ---- nookplot knowledge earnings ----
  cmd
    .command("earnings")
    .description("View your attribution revenue from knowledge queries")
    .option("--days <n>", "Lookback period in days", "30")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const config = loadConfig();
      const errors = validateConfig(config);
      if (errors.length > 0) {
        console.error(chalk.red("Configuration errors:"));
        errors.forEach((e) => console.error(`  - ${e}`));
        process.exit(1);
      }

      const spinner = ora("Fetching earnings...").start();

      const res = await gatewayRequest<EarningsResponse>(
        config.gateway,
        "GET",
        `/v1/knowledge/earnings?days=${opts.days}`,
        { apiKey: config.apiKey },
      );

      if (isGatewayError(res)) {
        spinner.fail(`Failed: ${res.error}`);
        process.exit(1);
      }

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      const data = res.data;
      console.log(chalk.bold(`\n  Knowledge Query Earnings (last ${opts.days} days)`));
      console.log(`  Total earned: ${chalk.green(`${data.totalEarned.toFixed(2)} credits`)}`);
      console.log(`  Attributions: ${data.attributionCount}\n`);

      if (data.topContent.length > 0) {
        console.log(chalk.bold("  Top earning content:"));
        for (const item of data.topContent) {
          console.log(`    ${chalk.cyan(`[${item.contentType}]`)} ${item.contentId} — ${chalk.green(`${item.totalEarned.toFixed(2)} credits`)} (${item.queryCount} queries)`);
        }
        console.log();
      }
    });

  // ---- nookplot knowledge topics ----
  cmd
    .command("topics")
    .description("View your inferred query topic map")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const config = loadConfig();
      const errors = validateConfig(config);
      if (errors.length > 0) {
        console.error(chalk.red("Configuration errors:"));
        errors.forEach((e) => console.error(`  - ${e}`));
        process.exit(1);
      }

      const spinner = ora("Fetching topics...").start();

      const res = await gatewayRequest<{ topics: TopicItem[] }>(
        config.gateway,
        "GET",
        "/v1/knowledge/topics",
        { apiKey: config.apiKey },
      );

      if (isGatewayError(res)) {
        spinner.fail(`Failed: ${res.error}`);
        process.exit(1);
      }

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      const topics = res.data.topics;
      console.log(chalk.bold(`\n  Your Query Topics (${topics.length} topics)\n`));

      if (topics.length === 0) {
        console.log(chalk.yellow("  No query topics yet. Make some knowledge queries first.\n"));
        return;
      }

      for (const t of topics) {
        const bar = "█".repeat(Math.min(t.queryCount, 30));
        console.log(`  ${chalk.white(t.topic.padEnd(40))} ${chalk.cyan(bar)} ${t.queryCount}`);
      }
      console.log();
    });
}
