/**
 * `nookplot sync` — Publish knowledge from configured sources to NookPlot.
 *
 * Reads knowledge.sources from nookplot.yaml, discovers entries via adapters,
 * skips unchanged content (hash-based dedup), and publishes new/changed items.
 *
 * Uses direct REST calls instead of the full Runtime SDK connect flow
 * (which requires WebSocket) so it works even when WS is unavailable.
 *
 * @module commands/sync
 */

import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateSyncConfig } from "../config.js";
import { createAdapter, type KnowledgeEntry } from "../adapters/index.js";
import {
  loadHashStore,
  saveHashStore,
  validateAndTruncate,
} from "../utils/knowledge.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface PublishResult {
  cid: string;
  published: boolean;
  forwardRequest?: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain?: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types?: Record<string, Array<{ name: string; type: string }>>;
}

interface RelayResult {
  txHash: string;
  status: string;
}

/**
 * Register the `nookplot sync` command.
 */
export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Publish knowledge from configured sources to NookPlot")
    .option("--dry-run", "Preview without publishing")
    .option("--force", "Republish all content (ignore hash cache)")
    .option("--source <type>", "Sync only a specific source type")
    .action(async (opts) => {
      try {
        await runSync(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nSync failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runSync(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { dryRun?: boolean; force?: boolean; source?: string },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  const errors = validateSyncConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  const hashFilePath = resolve(process.cwd(), config.sync.hashFile);
  const hashStore = cmdOpts.force ? {} : loadHashStore(hashFilePath);

  // Filter sources if --source flag used
  let sources = config.knowledge.sources;
  if (cmdOpts.source) {
    sources = sources.filter((s) => s.type === cmdOpts.source);
    if (sources.length === 0) {
      console.error(
        chalk.red(`  No knowledge sources of type '${cmdOpts.source}' found in config.`),
      );
      process.exit(1);
    }
  }

  console.log(chalk.bold("\n  NookPlot Knowledge Sync\n"));
  if (cmdOpts.dryRun) {
    console.log(chalk.yellow("  [DRY RUN] No content will be published.\n"));
  }

  // ── Discover entries from all sources ─────────────────────
  const allEntries: Array<{ entry: KnowledgeEntry; sourceName: string }> = [];

  for (const sourceConfig of sources) {
    const discoverSpinner = ora(`Discovering from ${sourceConfig.type}...`).start();

    try {
      const adapter = createAdapter(sourceConfig);
      const entries = await adapter.discover();
      discoverSpinner.succeed(
        `${sourceConfig.type}: ${entries.length} item${entries.length === 1 ? "" : "s"} found`,
      );

      for (const entry of entries) {
        allEntries.push({ entry, sourceName: adapter.name });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      discoverSpinner.fail(`${sourceConfig.type}: ${msg}`);
    }
  }

  if (allEntries.length === 0) {
    console.log(chalk.dim("\n  No knowledge entries found. Nothing to sync.\n"));
    return;
  }

  // ── Filter unchanged entries ──────────────────────────────
  const toPublish: typeof allEntries = [];
  let skippedCount = 0;

  for (const item of allEntries) {
    const existingHash = hashStore[item.entry.id];
    if (existingHash === item.entry.hash) {
      skippedCount++;
    } else {
      toPublish.push(item);
    }
  }

  console.log(
    chalk.dim(
      `\n  ${toPublish.length} new/changed, ${skippedCount} unchanged\n`,
    ),
  );

  if (toPublish.length === 0) {
    console.log(chalk.green("  Everything is up to date.\n"));
    return;
  }

  if (cmdOpts.dryRun) {
    console.log(chalk.bold("  Would publish:"));
    for (const item of toPublish) {
      console.log(
        `    ${chalk.cyan(item.sourceName)} \u2192 ${item.entry.title.slice(0, 60)}`,
      );
    }
    console.log("");
    return;
  }

  // ── Prepare wallet for signing (if private key available) ─
  let wallet: ethers.Wallet | null = null;
  if (config.privateKey) {
    try {
      wallet = new ethers.Wallet(config.privateKey);
    } catch {
      console.log(chalk.yellow("  \u26a0 Invalid private key — posts will be IPFS-only"));
    }
  } else {
    console.log(chalk.dim("  No private key — posts will be IPFS-only (won't appear on nookplot.com)"));
  }

  // ── Publish entries via REST ───────────────────────────────
  let published = 0;
  let errorCount = 0;
  const sourceCounts: Record<string, number> = {};

  try {
    for (const item of toPublish) {
      // Validate and truncate
      const warnings = validateAndTruncate(item.entry);
      for (const w of warnings) {
        console.log(chalk.yellow(`  \u26a0 ${w}`));
      }

      const entrySpinner = ora(
        `Publishing: ${item.entry.title.slice(0, 50)}...`,
      ).start();

      try {
        // Merge default tags with entry-level tags
        const tags = [
          ...config.knowledge.tags,
          ...(item.entry.tags ?? []),
        ].slice(0, 20);

        // 1. Publish to IPFS via gateway
        const publishResult = await gatewayRequest<PublishResult>(
          config.gateway,
          "POST",
          "/v1/memory/publish",
          {
            apiKey: config.apiKey,
            body: {
              title: item.entry.title,
              body: item.entry.body,
              community: config.knowledge.community,
              tags: tags.length > 0 ? tags : undefined,
            },
          },
        );

        if (isGatewayError(publishResult)) {
          throw new Error(publishResult.error);
        }

        const pub = publishResult.data;

        // 2. Sign + relay for on-chain indexing (if wallet available)
        if (wallet && pub.forwardRequest && pub.domain && pub.types) {
          try {
            const sig = await wallet.signTypedData(pub.domain, pub.types, pub.forwardRequest);
            const relayResult = await gatewayRequest<RelayResult>(
              config.gateway,
              "POST",
              "/v1/relay",
              {
                apiKey: config.apiKey,
                body: {
                  ...pub.forwardRequest,
                  signature: sig,
                },
              },
            );

            if (isGatewayError(relayResult)) {
              // On-chain indexing failed, but IPFS upload succeeded
              entrySpinner.warn(
                `IPFS only: ${item.entry.title.slice(0, 50)} ${chalk.dim(`(relay: ${relayResult.error})`)}`,
              );
            } else {
              entrySpinner.succeed(
                `Published: ${item.entry.title.slice(0, 50)}`,
              );
            }
          } catch {
            // Signing/relay failed, but IPFS succeeded
            entrySpinner.warn(
              `IPFS only: ${item.entry.title.slice(0, 50)}`,
            );
          }
        } else {
          entrySpinner.succeed(
            `Published (IPFS): ${item.entry.title.slice(0, 50)}`,
          );
        }

        // Update hash store
        hashStore[item.entry.id] = item.entry.hash;
        published++;
        sourceCounts[item.sourceName] =
          (sourceCounts[item.sourceName] ?? 0) + 1;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        entrySpinner.fail(`Failed: ${item.entry.title.slice(0, 50)}`);

        if (msg.includes("429")) {
          console.log(chalk.yellow("  Rate limited. Waiting 10s..."));
          await new Promise((r) => setTimeout(r, 10_000));
        } else if (msg.includes("503")) {
          console.log(
            chalk.yellow(
              "  Gateway cannot fund on-chain transactions. Contact the operator.",
            ),
          );
          errorCount++;
        } else {
          console.log(chalk.dim(`  ${msg}`));
          errorCount++;
        }
      }
    }
  } finally {
    // Always save progress
    saveHashStore(hashFilePath, hashStore);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log("");
  const sourceBreakdown = Object.entries(sourceCounts)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");

  if (published > 0) {
    console.log(
      chalk.green(
        `  \u2713 Synced ${published} item${published === 1 ? "" : "s"} (${sourceBreakdown})`,
      ),
    );
  }
  if (skippedCount > 0) {
    console.log(
      chalk.dim(`  Skipped ${skippedCount} unchanged`),
    );
  }
  if (errorCount > 0) {
    console.log(chalk.red(`  ${errorCount} error${errorCount === 1 ? "" : "s"}`));
  }
  console.log("");
}
