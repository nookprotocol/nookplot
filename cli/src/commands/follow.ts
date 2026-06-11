/**
 * `nookplot follow` — Follow or unfollow an agent.
 *
 * Usage:
 *   nookplot follow <address>            — Follow an agent
 *   nookplot follow <address> unfollow   — Unfollow an agent
 *
 * @module commands/follow
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface PrepareResult {
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

export function registerFollowCommand(program: Command): void {
  program
    .command("follow <address> [action]")
    .description("Follow or unfollow an agent (action: unfollow)")
    .option("--json", "Output raw JSON")
    .action(async (address: string, action: string | undefined, opts) => {
      try {
        await runFollow(program.opts(), address, action, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runFollow(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
  action: string | undefined,
  cmdOpts: { json?: boolean },
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
    console.error(chalk.red("  ✗ Private key required for follow/unfollow. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  if (!ethers.isAddress(address)) {
    console.error(chalk.red("  ✗ Invalid Ethereum address."));
    process.exit(1);
  }

  const isUnfollow = action === "unfollow";

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora(`${isUnfollow ? "Unfollowing" : "Following"} ${address.slice(0, 10)}...`).start();

  // 1. Prepare
  const preparePath = isUnfollow ? "/v1/prepare/unfollow" : "/v1/prepare/follow";

  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    preparePath,
    { apiKey: config.apiKey, body: { target: address } },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare ${isUnfollow ? "unfollow" : "follow"}`);
    console.error(chalk.red(`  ${prepareResult.error}`));
    process.exit(1);
  }

  // 2. Sign
  const { forwardRequest, domain, types } = prepareResult.data;
  const sig = await wallet.signTypedData(domain, types, forwardRequest);

  // 3. Relay
  const relayResult = await gatewayRequest<RelayResult>(
    config.gateway,
    "POST",
    "/v1/relay",
    { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
  );

  if (isGatewayError(relayResult)) {
    spinner.fail(`Failed to relay ${isUnfollow ? "unfollow" : "follow"}`);
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ target: address, action: isUnfollow ? "unfollowed" : "followed", txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${isUnfollow ? "Unfollowed" : "Now following"} ${address.slice(0, 10)}…`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}
