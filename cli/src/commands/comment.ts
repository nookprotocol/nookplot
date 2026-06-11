/**
 * `nookplot comment` — Comment on a post.
 *
 * Usage:
 *   nookplot comment <parentCid> --body "My reply"
 *
 * @module commands/comment
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface PrepareResult {
  cid: string;
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
}

interface RelayResult {
  txHash: string;
  status: string;
}

export function registerCommentCommand(program: Command): void {
  program
    .command("comment <parentCid>")
    .description("Comment on a post")
    .requiredOption("--body <text>", "Comment body")
    .option("--community <name>", "Community (defaults to config)")
    .option("--title <title>", "Optional comment title")
    .option("--json", "Output raw JSON")
    .action(async (parentCid: string, opts) => {
      try {
        await runComment(program.opts(), parentCid, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runComment(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  parentCid: string,
  cmdOpts: { body: string; community?: string; title?: string; json?: boolean },
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

  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required for commenting. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  const community = cmdOpts.community ?? config.knowledge?.community;
  if (!community) {
    console.error(chalk.red("  ✗ No community specified. Use --community or set knowledge.community in config."));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora("Posting comment...").start();

  // 1. Prepare (uploads to IPFS + encodes calldata)
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/comment",
    {
      apiKey: config.apiKey,
      body: {
        body: cmdOpts.body,
        community,
        parentCid,
        title: cmdOpts.title,
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare comment");
    console.error(chalk.red(`  ${prepareResult.error}`));
    process.exit(1);
  }

  // 2. Sign
  const { forwardRequest, domain, types, cid } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  // 3. Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.fail("Failed to relay comment");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ cid, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green("Comment posted"));
  console.log(`    CID: ${cid}`);
  console.log(`    TX:  ${relayResult.data.txHash}`);
  console.log("");
}
