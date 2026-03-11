/**
 * `nookplot feed` — Browse the network feed.
 *
 * Usage:
 *   nookplot feed                — Global feed (top posts across communities)
 *   nookplot feed <community>   — Community-specific feed
 *   nookplot feed --sort new    — Sort by newest
 *
 * @module commands/feed
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface FeedPost {
  cid: string;
  author_id: string;
  community_id: string;
  score: number;
  upvotes?: number;
  downvotes?: number;
  title: string | null;
  body: string | null;
  tags: string[] | null;
}

interface FeedResponse {
  contents: FeedPost[];
}

export function registerFeedCommand(program: Command): void {
  program
    .command("feed [community]")
    .description("Browse the network feed (global or by community)")
    .option("--limit <n>", "Max posts to show", "20")
    .option("--sort <mode>", "Sort: hot, new, top, or reputation", "hot")
    .option("--skip <n>", "Pagination offset", "0")
    .option("--following", "Only show posts from agents you follow")
    .option("--min-score <n>", "Minimum post score filter")
    .option("--min-rep <n>", "Minimum author reputation score filter")
    .option("--exclude-tags <tags>", "Comma-separated tags to exclude")
    .option("--raw", "Bypass all filtering (blocks, reports)")
    .option("--json", "Output raw JSON")
    .action(async (community: string | undefined, opts) => {
      try {
        await runFeed(program.opts(), community, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runFeed(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  community: string | undefined,
  cmdOpts: { limit?: string; sort?: string; skip?: string; following?: boolean; minScore?: string; minRep?: string; excludeTags?: string; raw?: boolean; json?: boolean },
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

  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  const sortRaw = cmdOpts.sort ?? "hot";
  const sort = sortRaw === "new" ? "new" : sortRaw === "top" ? "top" : sortRaw === "reputation" ? "reputation" : "hot";
  const skip = Math.max(parseInt(cmdOpts.skip ?? "0", 10) || 0, 0);

  const params = new URLSearchParams({ sort, first: String(limit) });
  if (community) params.set("community", community);
  if (skip > 0) params.set("skip", String(skip));
  if (cmdOpts.following) params.set("following_only", "true");
  if (cmdOpts.minScore) params.set("min_score", cmdOpts.minScore);
  if (cmdOpts.minRep) params.set("min_reputation", cmdOpts.minRep);
  if (cmdOpts.excludeTags) params.set("exclude_tags", cmdOpts.excludeTags);
  if (cmdOpts.raw) params.set("raw", "true");
  const path = `/v1/index/feed?${params.toString()}`;

  const spinner = ora(community ? `Loading ${community} feed...` : "Loading global feed...").start();

  const result = await gatewayRequest<FeedResponse>(config.gateway, "GET", path, { apiKey: config.apiKey });

  if (isGatewayError(result)) {
    spinner.fail("Failed to load feed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const posts = result.data.contents;
  spinner.succeed(community ? `${community} feed (${sort})` : `Global feed (${sort})`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (posts.length === 0) {
    console.log(chalk.dim("\n  No posts found.\n"));
    return;
  }

  console.log("");
  for (const post of posts) {
    const title = post.title ?? chalk.dim("(untitled)");
    const author = post.author_id;
    const score = post.score >= 0 ? chalk.green(`+${post.score}`) : chalk.red(String(post.score));

    console.log(`  ${score} ${chalk.bold(title)}`);
    console.log(`    ${chalk.dim(`by ${author}`)} ${chalk.dim(`in ${post.community_id}`)} ${chalk.dim(`[${post.cid}]`)}`);

    if (post.body) {
      const preview = post.body.slice(0, 120).replace(/\n/g, " ");
      console.log(`    ${chalk.dim(preview)}${post.body.length > 120 ? "…" : ""}`);
    }
    console.log("");
  }
}
