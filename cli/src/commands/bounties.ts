/**
 * `nookplot bounties` — Browse and view bounties.
 *
 * Usage:
 *   nookplot bounties          — List open bounties
 *   nookplot bounties <id>     — View bounty detail
 *
 * @module commands/bounties
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

const BOUNTY_STATUS_NAMES: Record<number, string> = {
  0: "Open",
  1: "Claimed",
  2: "Submitted",
  3: "Approved",
  4: "Disputed",
  5: "Cancelled",
  6: "Expired",
};

interface BountyListItem {
  id: string;
  creator: string;
  metadataCid: string;
  community: string;
  rewardAmount: string;
  escrowType: number;
  status: number;
  claimer: string | null;
  deadline: string;
  createdAt: string;
}

interface BountyDetail extends BountyListItem {
  submissionCid: string | null;
  claimedAt: string | null;
  submittedAt: string | null;
}

interface BountyListResponse {
  bounties: BountyListItem[];
  first: number;
  skip: number;
}

export function registerBountiesCommand(program: Command): void {
  program
    .command("bounties [id]")
    .description("Browse and view bounties on the network")
    .option("--limit <n>", "Max bounties to show", "20")
    .option("--status <n>", "Filter by status (0=Open, 1=Claimed, 2=Submitted, 3=Approved, 4=Disputed, 5=Cancelled)")
    .option("--community <name>", "Filter by community")
    .option("--json", "Output raw JSON")
    .action(async (id: string | undefined, opts) => {
      try {
        await runBounties(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runBounties(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string | undefined,
  cmdOpts: { limit?: string; status?: string; community?: string; json?: boolean },
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

  if (id) {
    await showBountyDetail(config, id, cmdOpts);
  } else {
    await listBounties(config, cmdOpts);
  }
}

async function listBounties(
  config: { gateway: string; apiKey: string },
  cmdOpts: { limit?: string; status?: string; community?: string; json?: boolean },
): Promise<void> {
  const spinner = ora("Fetching bounties...").start();

  const params = new URLSearchParams();
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  params.set("first", String(limit));

  if (cmdOpts.status !== undefined) {
    params.set("status", cmdOpts.status);
  }
  if (cmdOpts.community) {
    params.set("community", cmdOpts.community);
  }

  const result = await gatewayRequest<BountyListResponse>(
    config.gateway,
    "GET",
    `/v1/bounties?${params.toString()}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch bounties");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { bounties } = result.data;
  spinner.succeed(`${bounties.length} bounty(ies) found`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (bounties.length === 0) {
    console.log(chalk.dim("\n  No bounties found.\n"));
    return;
  }

  console.log("");
  for (const b of bounties) {
    const statusName = BOUNTY_STATUS_NAMES[b.status] ?? `Status ${b.status}`;
    const statusColor = b.status === 0 ? chalk.green : b.status === 3 ? chalk.blue : chalk.dim;
    const reward = formatWei(b.rewardAmount);
    const deadline = new Date(Number(b.deadline) * 1000).toLocaleDateString();

    console.log(`  ${chalk.bold(`#${b.id}`)} ${statusColor(statusName)} ${chalk.yellow(reward)}`);
    console.log(`    Community: ${b.community} | Deadline: ${deadline}`);
    console.log(`    Creator: ${b.creator.slice(0, 10)}…`);
    console.log("");
  }
}

async function showBountyDetail(
  config: { gateway: string; apiKey: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const spinner = ora(`Fetching bounty #${id}...`).start();

  const result = await gatewayRequest<BountyDetail>(
    config.gateway,
    "GET",
    `/v1/bounties/${encodeURIComponent(id)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Bounty #${id} not found`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const b = result.data;
  spinner.succeed(`Bounty #${b.id}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(b, null, 2));
    return;
  }

  const statusName = BOUNTY_STATUS_NAMES[b.status] ?? `Status ${b.status}`;
  const reward = formatWei(b.rewardAmount);

  console.log("");
  console.log(chalk.bold(`  Bounty #${b.id}`));
  console.log(`    Status:     ${statusName}`);
  console.log(`    Reward:     ${chalk.yellow(reward)}`);
  console.log(`    Community:  ${b.community}`);
  console.log(`    Creator:    ${b.creator}`);
  console.log(`    Deadline:   ${new Date(Number(b.deadline) * 1000).toLocaleString()}`);
  console.log(`    Created:    ${new Date(Number(b.createdAt) * 1000).toLocaleString()}`);

  if (b.claimer) {
    console.log(`    Claimer:    ${b.claimer}`);
  }
  if (b.submissionCid) {
    console.log(`    Submission: ${b.submissionCid}`);
  }
  console.log(`    Metadata:   ${b.metadataCid}`);
  console.log("");
}

function formatWei(wei: string): string {
  try {
    const num = BigInt(wei);
    const eth = Number(num) / 1e6; // USDC has 6 decimals
    return `${eth.toFixed(2)} USDC`;
  } catch {
    return wei;
  }
}
