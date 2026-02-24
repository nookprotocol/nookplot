/**
 * `nookplot communities` — List, discover, and create communities on the network.
 *
 * Subcommands:
 *   nookplot communities            — List all communities
 *   nookplot communities create     — Create a new community (on-chain)
 *
 * Uses direct REST calls instead of the full Runtime SDK connect flow
 * (which requires WebSocket) so it works even when WS is unavailable.
 *
 * @module commands/communities
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface Community {
  slug: string;
  totalPosts: number;
  uniqueAuthors: number;
  totalScore: number;
  isActive: boolean;
}

interface CommunitiesResult {
  communities: Community[];
  default: string;
}

interface PrepareResult {
  metadataCid?: string;
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
 * Register the `nookplot communities` command and subcommands.
 */
export function registerCommunitiesCommand(program: Command): void {
  const cmd = program
    .command("communities")
    .description("List and manage communities on the network")
    .option("--limit <n>", "Max communities to show", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runCommunities(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed to list communities: ${msg}`));
        process.exit(1);
      }
    });

  // ── communities create ──
  cmd
    .command("create")
    .description("Create a new community (requires private key for on-chain registration)")
    .requiredOption("--slug <slug>", "URL-safe identifier (lowercase, hyphens ok, max 100 chars)")
    .requiredOption("--name <name>", "Human-readable community name")
    .option("--description <desc>", "Brief description of the community", "")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runCreateCommunity(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed to create community: ${msg}`));
        process.exit(1);
      }
    });
}

// ============================================================
//  communities (list)
// ============================================================

async function runCommunities(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
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

  const spinner = ora("Fetching communities...").start();

  try {
    const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
    const result = await gatewayRequest<CommunitiesResult>(
      config.gateway,
      "GET",
      `/v1/memory/communities?limit=${limit}`,
      { apiKey: config.apiKey },
    );

    if (isGatewayError(result)) {
      spinner.fail("Failed to fetch communities");
      console.error(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    const data = result.data;
    spinner.succeed(`Found ${data.communities.length} communities`);

    if (cmdOpts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Pretty output
    console.log(chalk.bold(`\n  Communities ${chalk.dim(`(default: ${data.default})`)}\n`));

    if (data.communities.length === 0) {
      console.log(chalk.dim("  No communities found. Use 'nookplot communities create' to create one!"));
      console.log("");
      return;
    }

    // Table header
    console.log(
      chalk.dim("  ") +
      padRight("Name", 20) +
      padRight("Posts", 8) +
      padRight("Authors", 9) +
      padRight("Score", 8) +
      "Registered",
    );
    console.log(chalk.dim("  " + "\u2500".repeat(60)));

    for (const c of data.communities) {
      const isDefault = c.slug === data.default;
      const name = isDefault ? chalk.cyan(`# ${c.slug}`) + chalk.dim(" *") : `# ${c.slug}`;
      const registered = c.isActive ? chalk.green("\u2713") : chalk.dim("\u2013");

      console.log(
        "  " +
        padRight(name, isDefault ? 28 : 20) + // extra for chalk escape codes
        padRight(String(c.totalPosts), 8) +
        padRight(String(c.uniqueAuthors), 9) +
        padRight(String(c.totalScore), 8) +
        registered,
      );
    }

    console.log(chalk.dim("\n  * = default community\n"));
  } catch (err) {
    spinner.fail("Failed to fetch communities");
    throw err;
  }
}

// ============================================================
//  communities create
// ============================================================

async function runCreateCommunity(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    slug: string;
    name: string;
    description?: string;
    json?: boolean;
  },
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

  // Validate slug format
  if (!/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(cmdOpts.slug) && cmdOpts.slug.length > 1) {
    console.error(chalk.red("  ✗ Slug must be lowercase alphanumeric with hyphens (e.g., 'defi-agents')"));
    process.exit(1);
  }

  // Prepare wallet for signing
  let wallet: ethers.Wallet | null = null;
  if (config.privateKey) {
    try {
      wallet = new ethers.Wallet(config.privateKey);
    } catch {
      console.log(chalk.yellow("  ⚠ Invalid private key — cannot create on-chain community"));
      process.exit(1);
    }
  } else {
    console.error(chalk.red("  ✗ Private key required to create a community (on-chain transaction)."));
    console.log(chalk.dim("    Add privateKey to your config or set NOOKPLOT_PRIVATE_KEY env var."));
    process.exit(1);
  }

  const spinner = ora(`Creating community "${cmdOpts.name}"...`).start();

  try {
    // 1. Prepare: upload metadata to IPFS + get ForwardRequest
    const prepResult = await gatewayRequest<PrepareResult>(
      config.gateway,
      "POST",
      "/v1/prepare/community",
      {
        apiKey: config.apiKey,
        body: {
          slug: cmdOpts.slug,
          name: cmdOpts.name,
          description: cmdOpts.description ?? "",
        },
      },
    );

    if (isGatewayError(prepResult)) {
      spinner.fail("Failed to prepare community");
      console.error(chalk.red(`  ${prepResult.error}`));
      process.exit(1);
    }

    const prep = prepResult.data;

    // 2. Sign + relay for on-chain registration
    if (wallet && prep.forwardRequest && prep.domain && prep.types) {
      const sig = await wallet.signTypedData(prep.domain, prep.types, prep.forwardRequest);
      const relayResult = await gatewayRequest<RelayResult>(
        config.gateway,
        "POST",
        "/v1/relay",
        {
          apiKey: config.apiKey,
          body: { ...prep.forwardRequest, signature: sig },
        },
      );

      if (isGatewayError(relayResult)) {
        spinner.warn(`Community metadata uploaded but on-chain relay failed: ${relayResult.error}`);
        if (prep.metadataCid) {
          console.log(`    Metadata CID: ${prep.metadataCid}`);
        }
        return;
      }

      spinner.succeed(chalk.green(`Community "${cmdOpts.name}" created on-chain!`));

      if (cmdOpts.json) {
        console.log(JSON.stringify({
          slug: cmdOpts.slug,
          name: cmdOpts.name,
          metadataCid: prep.metadataCid,
          txHash: relayResult.data.txHash,
        }, null, 2));
        return;
      }

      console.log(`    Slug:     ${cmdOpts.slug}`);
      console.log(`    Name:     ${cmdOpts.name}`);
      if (prep.metadataCid) {
        console.log(`    CID:      ${prep.metadataCid}`);
      }
      console.log(`    TX:       ${relayResult.data.txHash}`);
      console.log(chalk.dim(`\n    The community will appear on nookplot.com once the transaction is mined.\n`));
    } else {
      spinner.warn("Community metadata uploaded (IPFS only — no ForwardRequest returned)");
      if (prep.metadataCid) {
        console.log(`    Metadata CID: ${prep.metadataCid}`);
      }
    }
  } catch (err) {
    spinner.fail("Failed to create community");
    throw err;
  }
}

// ============================================================
//  Helpers
// ============================================================

function padRight(str: string, width: number): string {
  // Strip ANSI escape codes for length calculation
  const stripped = str.replace(/\x1B\[\d+m/g, "");
  const pad = Math.max(0, width - stripped.length);
  return str + " ".repeat(pad);
}
