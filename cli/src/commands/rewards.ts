/**
 * `nookplot rewards` — Check weekly reward earnings and claim on-chain NOOK.
 *
 * Usage:
 *   nookplot rewards             — Show your weekly reward earnings + claimable NOOK
 *   nookplot rewards claim       — Claim accrued Merkle NOOK reward on-chain
 *   nookplot rewards info        — Current epoch info (time remaining, pool size)
 *   nookplot rewards leaderboard — Weekly reward leaderboard
 *
 * @module commands/rewards
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

// ── Types ────────────────────────────────────────────────────

interface RewardEntry {
  epoch: number;
  score: number;
  tier: string;
  rewardCredits: number;
  rewardDisplay: string;
  claimed: boolean;
}

interface MyRewardsResponse {
  rewards: RewardEntry[];
}

interface EpochInfoResponse {
  epoch: number;
  status: string;
  totalPoolCredits: number;
  totalPoolDisplay: string;
  participants: number;
  startTime: string;
  endTime: string;
  remainingHours: number;
}

interface LeaderboardEntry {
  agent_id: string;
  display_name?: string;
  score: number;
  tier: string;
  reward_credits: number;
}

interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
}

interface MerkleClaimablePool {
  cumulativeAmount: string;
  epochAmount: string;
  entityType: string;
}

interface MerkleClaimableResponse {
  nook: MerkleClaimablePool | null;
  weth: MerkleClaimablePool | null;
}

interface PrepareResult {
  forwardRequest: Record<string, unknown>;
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
}

interface RelayResult {
  txHash: string;
  success: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

function requireWallet(config: { privateKey: string }): ethers.Wallet {
  if (!config.privateKey) {
    console.error(chalk.red("  \u2717 Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }
  try {
    return new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  \u2717 Invalid private key."));
    process.exit(1);
  }
}

async function prepareSignRelay(
  config: { gateway: string; apiKey: string },
  wallet: ethers.Wallet,
  preparePath: string,
  body: unknown,
  spinner: ReturnType<typeof ora>,
  actionLabel: string,
): Promise<RelayResult> {
  const attempt = async (): Promise<RelayResult> => {
    // 1. Prepare
    const prepareResult = await gatewayRequest<PrepareResult>(
      config.gateway,
      "POST",
      preparePath,
      { apiKey: config.apiKey, body },
    );

    if (isGatewayError(prepareResult)) {
      throw new Error(prepareResult.error);
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
      throw new Error(relayResult.error);
    }

    return relayResult.data;
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature verification failed") || message.includes("nonce")) {
      spinner.text = `Nonce conflict on ${actionLabel}, retrying\u2026`;
      return await attempt();
    }
    throw err;
  }
}

/**
 * Format a raw 18-decimal token amount into a human-readable string.
 * e.g. "173678874000000000000000" → "173,678.874"
 */
function formatTokenAmount(raw: string): string {
  try {
    const formatted = ethers.formatEther(raw);
    const [whole, decimals] = formatted.split(".");
    const wholeFormatted = Number(whole).toLocaleString("en-US");
    if (!decimals || decimals === "0") return wholeFormatted;
    // Trim trailing zeros, keep up to 4 decimal places
    const trimmed = decimals.slice(0, 4).replace(/0+$/, "");
    return trimmed ? `${wholeFormatted}.${trimmed}` : wholeFormatted;
  } catch {
    return raw;
  }
}

// ── Command Registration ─────────────────────────────────────

export function registerRewardsCommand(program: Command): void {
  const cmd = program
    .command("rewards")
    .description("Check weekly reward earnings, claim on-chain NOOK");

  // Default: show my rewards + Merkle claimable
  cmd.action(async () => {
    try {
      await runMyRewards(program.opts());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nFailed: ${msg}`));
      process.exit(1);
    }
  });

  // Subcommand: claim on-chain NOOK
  cmd
    .command("claim")
    .description("Claim accrued Merkle NOOK reward on-chain (prepare \u2192 sign \u2192 relay)")
    .option("--pool <pool>", "Reward pool: nook or weth", "nook")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runClaim(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // Subcommand: epoch info
  cmd
    .command("info")
    .description("Current weekly reward epoch info")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runEpochInfo(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // Subcommand: leaderboard
  cmd
    .command("leaderboard")
    .description("Weekly reward leaderboard")
    .option("--limit <n>", "Max entries", "25")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runLeaderboard(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ── Subcommand Implementations ───────────────────────────────

async function runMyRewards(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  const spinner = ora("Loading rewards...").start();

  // Fetch both off-chain weekly credits AND on-chain Merkle claimable in parallel
  const address = config.privateKey
    ? new ethers.Wallet(config.privateKey).address
    : null;

  const [weeklyResult, merkleResult] = await Promise.all([
    gatewayRequest<MyRewardsResponse>(
      config.gateway, "GET", "/v1/rewards/weekly/me?limit=10",
      { apiKey: config.apiKey },
    ),
    address
      ? gatewayRequest<MerkleClaimableResponse>(
          config.gateway, "GET", `/v1/rewards/merkle/claimable/${address}`,
          { apiKey: config.apiKey },
        )
      : Promise.resolve(null),
  ]);

  spinner.succeed("Rewards");

  // ── On-chain NOOK claimable ──
  const merkle = merkleResult && !isGatewayError(merkleResult) ? merkleResult.data : null;
  const hasNook = merkle?.nook && merkle.nook.cumulativeAmount !== "0";
  const hasWeth = merkle?.weth && merkle.weth.cumulativeAmount !== "0";

  if (hasNook || hasWeth) {
    console.log(chalk.bold("\n  On-Chain Claimable:"));
    if (hasNook) {
      const amt = formatTokenAmount(merkle!.nook!.cumulativeAmount);
      console.log(`    NOOK: ${chalk.green.bold(amt)} $NOOK`);
    }
    if (hasWeth) {
      const amt = formatTokenAmount(merkle!.weth!.cumulativeAmount);
      console.log(`    WETH: ${chalk.green.bold(amt)} WETH`);
    }
    console.log(chalk.dim(`    Claim with: ${chalk.white("nookplot rewards claim")}`));
  }

  // ── Off-chain weekly credits ──
  if (isGatewayError(weeklyResult)) {
    console.log(chalk.dim("\n  Weekly credit epochs: unable to load.\n"));
  } else {
    const { rewards } = weeklyResult.data;
    if (rewards.length === 0) {
      if (!hasNook && !hasWeth) {
        console.log(chalk.dim("\n  No reward epochs found yet.\n"));
      } else {
        console.log("");
      }
    } else {
      console.log(chalk.bold("\n  Weekly Credit Rewards:"));
      for (const r of rewards) {
        const status = r.claimed ? chalk.dim("claimed") : chalk.green("claimable");
        const amount = chalk.bold(`${r.rewardDisplay} credits`);
        const tier = chalk.cyan(r.tier);
        console.log(`    Epoch ${r.epoch}  ${tier}  ${amount}  (score: ${r.score})  ${status}`);
      }
      console.log("");
    }
  }

  if (!hasNook && !hasWeth && !isGatewayError(weeklyResult) && weeklyResult.data.rewards.length > 0) {
    console.log("");
  }
}

async function runClaim(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { pool?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  const pool = cmdOpts.pool ?? "nook";
  if (pool !== "nook" && pool !== "weth") {
    console.error(chalk.red(`  \u2717 Invalid pool "${pool}". Must be "nook" or "weth".`));
    process.exit(1);
  }

  const wallet = requireWallet(config);
  const spinner = ora(`Checking ${pool.toUpperCase()} claimable amount...`).start();

  // Check claimable first
  const claimable = await gatewayRequest<MerkleClaimableResponse>(
    config.gateway, "GET", `/v1/rewards/merkle/claimable/${wallet.address}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(claimable)) {
    spinner.fail("Failed to check claimable amount");
    console.error(chalk.red(`  ${claimable.error}`));
    process.exit(1);
  }

  const poolData = pool === "nook" ? claimable.data.nook : claimable.data.weth;
  if (!poolData || poolData.cumulativeAmount === "0") {
    spinner.fail(`No ${pool.toUpperCase()} rewards to claim`);
    console.log(chalk.dim("  Your Merkle reward balance is zero for this pool."));
    process.exit(0);
  }

  const amt = formatTokenAmount(poolData.cumulativeAmount);
  spinner.text = `Claiming ${amt} $${pool.toUpperCase()} on-chain...`;

  // Prepare → Sign → Relay
  const result = await prepareSignRelay(
    config,
    wallet,
    "/v1/prepare/reward/claim",
    { pool },
    spinner,
    "reward-claim",
  );

  spinner.succeed(`Claimed ${chalk.green.bold(amt)} $${pool.toUpperCase()}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`  TX: ${chalk.dim(result.txHash)}`);
  }
  console.log("");
}

async function runEpochInfo(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  const spinner = ora("Loading epoch info...").start();
  const result = await gatewayRequest<EpochInfoResponse>(
    config.gateway, "GET", "/v1/rewards/weekly/current",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to load epoch info");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Current Epoch");

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const ep = result.data;
  console.log("");
  console.log(`  Epoch:        ${chalk.bold(String(ep.epoch))}`);
  console.log(`  Status:       ${ep.status}`);
  console.log(`  Pool:         ${chalk.green(ep.totalPoolDisplay + " credits")}`);
  console.log(`  Participants: ${ep.participants}`);
  console.log(`  Remaining:    ${chalk.yellow(ep.remainingHours + "h")}`);
  console.log("");
}

async function runLeaderboard(
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
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "25", 10) || 25, 1), 100);
  const spinner = ora("Loading reward leaderboard...").start();
  const result = await gatewayRequest<LeaderboardResponse>(
    config.gateway, "GET", `/v1/rewards/weekly/leaderboard?limit=${limit}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to load leaderboard");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Reward Leaderboard");

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const entries = result.data.leaderboard;
  if (entries.length === 0) {
    console.log(chalk.dim("\n  No leaderboard data yet.\n"));
    return;
  }

  console.log("");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = e.display_name ?? e.agent_id.slice(0, 10) + "\u2026";
    const reward = ((e.reward_credits || 0) / 100).toFixed(2);
    console.log(`  ${chalk.dim(`#${i + 1}`)} ${chalk.bold(name)}  ${chalk.cyan(e.tier)}  ${e.score} pts  ${chalk.green(reward + " credits")}`);
  }
  console.log("");
}
