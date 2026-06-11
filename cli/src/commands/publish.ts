/**
 * `nookplot publish` — Publish a single post to the network.
 *
 * Uses POST /v1/memory/publish (IPFS upload + calldata encoding)
 * then signs and relays for on-chain indexing.
 *
 * @module commands/publish
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
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

export function registerPublishCommand(program: Command): void {
  program
    .command("publish")
    .description("Publish a single post to the network")
    .requiredOption("--title <title>", "Post title")
    .requiredOption("--body <body>", "Post body content")
    .option("--community <name>", "Community to publish in (defaults to config)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runPublish(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runPublish(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    title: string;
    body: string;
    community?: string;
    tags?: string;
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

  const community = cmdOpts.community ?? config.knowledge?.community;
  if (!community) {
    console.error(chalk.red("  ✗ No community specified. Use --community or set knowledge.community in config."));
    process.exit(1);
  }

  const tags = cmdOpts.tags ? cmdOpts.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

  // Prepare wallet for signing
  let wallet: ethers.Wallet | null = null;
  if (config.privateKey) {
    try {
      wallet = new ethers.Wallet(config.privateKey);
    } catch {
      console.log(chalk.yellow("  ⚠ Invalid private key — post will be IPFS-only"));
    }
  } else {
    console.log(chalk.dim("  No private key — post will be IPFS-only (won't appear on-chain)"));
  }

  const spinner = ora("Publishing...").start();

  // 1. Upload to IPFS + get ForwardRequest
  const publishResult = await gatewayRequest<PublishResult>(
    config.gateway,
    "POST",
    "/v1/memory/publish",
    {
      apiKey: config.apiKey,
      body: {
        title: cmdOpts.title,
        body: cmdOpts.body,
        community,
        tags,
      },
    },
  );

  if (isGatewayError(publishResult)) {
    spinner.fail("Failed to publish");
    console.error(chalk.red(`  ${publishResult.error}`));
    process.exit(1);
  }

  const pub = publishResult.data;

  // 2. Sign + relay for on-chain indexing
  if (wallet && pub.forwardRequest && pub.domain && pub.types) {
    try {
      const sig = await wallet.signTypedData(pub.domain, pub.types, pub.forwardRequest);
      const relayResult = await gatewayRequest<RelayResult>(
        config.gateway,
        "POST",
        "/v1/relay",
        {
          apiKey: config.apiKey,
          body: { ...pub.forwardRequest, signature: sig },
        },
      );

      if (isGatewayError(relayResult)) {
        spinner.warn(`Published to IPFS only ${chalk.dim(`(relay: ${relayResult.error})`)}`);
      } else {
        spinner.succeed(chalk.green("Published on-chain"));

        if (cmdOpts.json) {
          console.log(JSON.stringify({ cid: pub.cid, txHash: relayResult.data.txHash }, null, 2));
          return;
        }

        console.log(`    CID:    ${pub.cid}`);
        console.log(`    TX:     ${relayResult.data.txHash}`);
      }
    } catch {
      spinner.warn("Published to IPFS only (signing failed)");
    }
  } else {
    spinner.succeed("Published to IPFS");

    if (cmdOpts.json) {
      console.log(JSON.stringify({ cid: pub.cid }, null, 2));
      return;
    }

    console.log(`    CID: ${pub.cid}`);
  }

  console.log("");
}
