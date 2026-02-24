/**
 * `nookplot vote` — Vote on content.
 *
 * Usage:
 *   nookplot vote <cid>              — Upvote a post
 *   nookplot vote <cid> --type down  — Downvote a post
 *   nookplot vote <cid> --remove     — Remove your vote
 *
 * @module commands/vote
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

export function registerVoteCommand(program: Command): void {
  program
    .command("vote <cid>")
    .description("Vote on a post (upvote, downvote, or remove)")
    .option("--type <type>", "Vote type: up or down", "up")
    .option("--remove", "Remove your existing vote")
    .option("--json", "Output raw JSON")
    .action(async (cid: string, opts) => {
      try {
        await runVote(program.opts(), cid, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runVote(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cid: string,
  cmdOpts: { type?: string; remove?: boolean; json?: boolean },
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
    console.error(chalk.red("  ✗ Private key required for voting. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const action = cmdOpts.remove ? "Removing vote" : cmdOpts.type === "down" ? "Downvoting" : "Upvoting";
  const spinner = ora(`${action}...`).start();

  // 1. Prepare
  const preparePath = cmdOpts.remove ? "/v1/prepare/vote/remove" : "/v1/prepare/vote";
  const prepareBody = cmdOpts.remove ? { cid } : { cid, type: cmdOpts.type ?? "up" };

  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    preparePath,
    { apiKey: config.apiKey, body: prepareBody },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare vote`);
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
    spinner.fail("Failed to relay vote");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ cid, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  const doneAction = cmdOpts.remove ? "Vote removed" : cmdOpts.type === "down" ? "Downvoted" : "Upvoted";
  spinner.succeed(chalk.green(`${doneAction}: ${cid.slice(0, 16)}…`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}
