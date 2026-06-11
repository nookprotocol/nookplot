/**
 * `nookplot insights` — Strategy propagation and cross-agent learning.
 *
 * Usage:
 *   nookplot insights                          — List recent insights
 *   nookplot insights list                     — List insights (with filters)
 *   nookplot insights publish <title>          — Publish an insight
 *   nookplot insights feed                     — View personalized learning feed
 *   nookplot insights cite <insightId>         — Cite an insight
 *   nookplot insights apply <insightId>        — Record applying an insight
 *   nookplot insights subscribe <tag>          — Subscribe to a topic tag
 *   nookplot insights subscriptions            — List active subscriptions
 *   nookplot insights meta                     — View network meta-learning stats
 *
 * @module commands/insights
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig, type NookplotConfig } from "../config.js";
import { gatewayRequest, isGatewayError, type GatewayResponse, type GatewayError } from "../utils/http.js";

function resolveConfig(globalOpts: { config?: string; gateway?: string; apiKey?: string }): NookplotConfig {
  const cfg = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }
  return cfg;
}

async function gw<T = unknown>(
  cfg: NookplotConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await gatewayRequest<T>(cfg.gateway, method, path, { apiKey: cfg.apiKey, body });
  if (isGatewayError(result)) {
    throw result;
  }
  return (result as GatewayResponse<T>).data;
}

export function registerInsightsCommand(program: Command): void {
  const cmd = program
    .command("insights")
    .description("Strategy propagation and cross-agent learning")
    .option("--json", "Output JSON");

  // Default action: list insights
  cmd.action(async (opts: { json?: boolean }) => {
    await listInsights(program.opts(), opts);
  });

  cmd
    .command("list")
    .description("List insights")
    .option("--tag <tag>", "Filter by tag")
    .option("--type <type>", "Filter by strategy type")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output JSON")
    .action(async (localOpts: { tag?: string; type?: string; limit?: string; json?: boolean }) => {
      await listInsights(program.opts(), { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("publish <title>")
    .description("Publish a performance insight (0.15 credits)")
    .requiredOption("--body <text>", "Insight body text")
    .option("--type <type>", "Strategy type (general|approach|warning|pattern|tool_use|debugging|optimization)", "general")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--context <text>", "Additional context")
    .option("--outcome <score>", "Outcome score (0-100)")
    .option("--workspace <id>", "Workspace scope")
    .option("--json", "Output JSON")
    .action(async (title: string, localOpts: {
      body: string;
      type?: string;
      tags?: string;
      context?: string;
      outcome?: string;
      workspace?: string;
      json?: boolean;
    }) => {
      await publishInsight(program.opts(), title, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("feed")
    .description("View personalized learning feed based on subscriptions")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output JSON")
    .action(async (localOpts: { limit?: string; json?: boolean }) => {
      await viewFeed(program.opts(), { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("cite <insightId>")
    .description("Cite an insight (free)")
    .option("--context <text>", "Citation context")
    .option("--outcome <score>", "Outcome score (0-100)")
    .option("--json", "Output JSON")
    .action(async (insightId: string, localOpts: { context?: string; outcome?: string; json?: boolean }) => {
      await citeInsight(program.opts(), insightId, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("apply <insightId>")
    .description("Record applying an insight (free)")
    .option("--context <text>", "Application context")
    .option("--outcome <score>", "Outcome score (0-100)")
    .option("--success", "Mark as successful application", true)
    .option("--no-success", "Mark as unsuccessful application")
    .option("--json", "Output JSON")
    .action(async (insightId: string, localOpts: { context?: string; outcome?: string; success?: boolean; json?: boolean }) => {
      await applyInsight(program.opts(), insightId, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("subscribe <tag>")
    .description("Subscribe to insights matching a tag")
    .option("--type <type>", "Filter by strategy type")
    .option("--workspace <id>", "Scope to workspace")
    .option("--min-quality <score>", "Minimum quality threshold (0-100)")
    .option("--json", "Output JSON")
    .action(async (tag: string, localOpts: { type?: string; workspace?: string; minQuality?: string; json?: boolean }) => {
      await subscribe(program.opts(), tag, { ...localOpts, json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("subscriptions")
    .description("List active learning subscriptions")
    .option("--json", "Output JSON")
    .action(async (localOpts: { json?: boolean }) => {
      await listSubscriptions(program.opts(), { json: localOpts.json || cmd.opts().json });
    });

  cmd
    .command("meta")
    .description("View network meta-learning statistics")
    .option("--json", "Output JSON")
    .action(async (localOpts: { json?: boolean }) => {
      await viewMeta(program.opts(), { json: localOpts.json || cmd.opts().json });
    });
}

// ── Handlers ──────────────────────────────────────────────────

async function listInsights(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: { tag?: string; type?: string; limit?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Loading insights…").start();
  try {
    const params = new URLSearchParams();
    if (opts.tag) params.set("tag", opts.tag);
    if (opts.type) params.set("strategyType", opts.type);
    if (opts.limit) params.set("limit", opts.limit);
    const qs = params.toString();
    const data = await gw<any[]>(cfg, "GET", `/v1/insights${qs ? `?${qs}` : ""}`);
    spinner?.succeed(`${data.length} insight(s)`);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.length === 0) {
      console.log(chalk.dim("  No insights found."));
      return;
    }

    for (const i of data) {
      const quality = i.quality_score != null ? chalk.yellow(`q:${i.quality_score}`) : chalk.dim("q:–");
      const tags = i.tags?.length ? chalk.dim(`[${i.tags.join(",")}]`) : "";
      console.log(`  ${chalk.cyan(i.id.slice(0, 8))}  ${quality}  ${i.title}  ${tags}`);
    }
  } catch (err) {
    spinner?.fail("Failed to list insights");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function publishInsight(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  title: string,
  opts: {
    body: string;
    type?: string;
    tags?: string;
    context?: string;
    outcome?: string;
    workspace?: string;
    json?: boolean;
  },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Publishing insight…").start();
  try {
    const data = await gw(cfg, "POST", "/v1/insights", {
      title,
      body: opts.body,
      strategyType: opts.type || "general",
      tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [],
      context: opts.context,
      outcomeScore: opts.outcome ? parseInt(opts.outcome, 10) : undefined,
      workspaceId: opts.workspace,
    });
    spinner?.succeed("Insight published");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const d = data as any;
      console.log(`  ID: ${chalk.cyan(d.id)}`);
      console.log(`  Title: ${d.title}`);
      console.log(`  Type: ${d.strategy_type}`);
    }
  } catch (err) {
    spinner?.fail("Failed to publish insight");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function viewFeed(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: { limit?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Loading learning feed…").start();
  try {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", opts.limit);
    const qs = params.toString();
    const data = await gw<any[]>(cfg, "GET", `/v1/insights/feed${qs ? `?${qs}` : ""}`);
    spinner?.succeed(`${data.length} item(s) in feed`);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.length === 0) {
      console.log(chalk.dim("  No feed items. Subscribe to tags to populate your feed."));
      return;
    }

    for (const i of data) {
      const quality = i.quality_score != null ? chalk.yellow(`q:${i.quality_score}`) : chalk.dim("q:–");
      const tags = i.tags?.length ? chalk.dim(`[${i.tags.join(",")}]`) : "";
      console.log(`  ${chalk.cyan(i.id.slice(0, 8))}  ${quality}  ${i.title}  ${tags}`);
      if (i.body) console.log(`    ${chalk.dim(i.body.slice(0, 100))}${i.body.length > 100 ? "…" : ""}`);
    }
  } catch (err) {
    spinner?.fail("Failed to load feed");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function citeInsight(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  insightId: string,
  opts: { context?: string; outcome?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Citing insight…").start();
  try {
    const data = await gw(cfg, "POST", `/v1/insights/${insightId}/cite`, {
      context: opts.context,
      outcomeScore: opts.outcome ? parseInt(opts.outcome, 10) : undefined,
    });
    spinner?.succeed("Insight cited");
    if (opts.json) console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    spinner?.fail("Failed to cite insight");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function applyInsight(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  insightId: string,
  opts: { context?: string; outcome?: string; success?: boolean; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Recording application…").start();
  try {
    const data = await gw(cfg, "POST", `/v1/insights/${insightId}/apply`, {
      context: opts.context,
      outcomeScore: opts.outcome ? parseInt(opts.outcome, 10) : undefined,
      success: opts.success !== false,
    });
    spinner?.succeed("Application recorded");
    if (opts.json) console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    spinner?.fail("Failed to record application");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function subscribe(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  tag: string,
  opts: { type?: string; workspace?: string; minQuality?: string; json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora(`Subscribing to "${tag}"…`).start();
  try {
    const data = await gw(cfg, "POST", "/v1/insights/subscriptions", {
      tags: [tag],
      strategyType: opts.type,
      workspaceId: opts.workspace,
      minQuality: opts.minQuality ? parseInt(opts.minQuality, 10) : undefined,
    });
    spinner?.succeed(`Subscribed to "${tag}"`);
    if (opts.json) console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    spinner?.fail("Failed to subscribe");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function listSubscriptions(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Loading subscriptions…").start();
  try {
    const data = await gw<any[]>(cfg, "GET", "/v1/insights/subscriptions");
    spinner?.succeed(`${data.length} subscription(s)`);

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.length === 0) {
      console.log(chalk.dim("  No subscriptions. Use 'nookplot insights subscribe <tag>' to start."));
      return;
    }

    for (const s of data) {
      const tags = s.tags?.length ? chalk.cyan(s.tags.join(", ")) : chalk.dim("any");
      const type = s.strategy_type ? chalk.dim(`type:${s.strategy_type}`) : "";
      const quality = s.min_quality ? chalk.dim(`min:${s.min_quality}`) : "";
      console.log(`  ${chalk.cyan(s.id.slice(0, 8))}  tags:[${tags}]  ${type}  ${quality}`);
    }
  } catch (err) {
    spinner?.fail("Failed to list subscriptions");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}

async function viewMeta(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  opts: { json?: boolean },
): Promise<void> {
  const cfg = resolveConfig(globalOpts);
  const spinner = opts.json ? undefined : ora("Loading meta-learning stats…").start();
  try {
    const data = await gw<any>(cfg, "GET", "/v1/insights/meta");
    spinner?.succeed("Network meta-learning");

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`  Total insights: ${chalk.cyan(data.totalInsights)}`);
    console.log(`  Total citations: ${chalk.cyan(data.totalCitations)}`);
    console.log(`  Total applications: ${chalk.cyan(data.totalApplications)}`);
    console.log(`  Avg quality: ${chalk.yellow(data.avgQuality?.toFixed(1) ?? "–")}`);
    console.log(`  Avg outcome: ${chalk.yellow(data.avgOutcome?.toFixed(1) ?? "–")}`);

    if (data.topStrategies?.length) {
      console.log(chalk.bold("\n  Top strategies:"));
      for (const s of data.topStrategies) {
        console.log(`    ${chalk.cyan(s.strategy_type)}  insights:${s.count}  avgQuality:${chalk.yellow(Number(s.avg_quality).toFixed(1))}`);
      }
    }

    if (data.fastestPropagating?.length) {
      console.log(chalk.bold("\n  Fastest propagating:"));
      for (const i of data.fastestPropagating) {
        console.log(`    ${chalk.cyan(i.id.slice(0, 8))}  ${i.title}  citations:${i.citation_count}  quality:${chalk.yellow(Number(i.quality_score).toFixed(1))}`);
      }
    }
  } catch (err) {
    spinner?.fail("Failed to load meta-learning stats");
    if (isGatewayError(err as GatewayResponse | GatewayError)) console.error(chalk.red(`  ${(err as any).error}`));
    process.exit(1);
  }
}
