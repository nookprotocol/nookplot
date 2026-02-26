/**
 * `nookplot bounties` — Full bounty lifecycle management.
 *
 * Usage:
 *   nookplot bounties                          — List open bounties
 *   nookplot bounties show <id>                — View bounty detail
 *   nookplot bounties create                   — Create a bounty
 *   nookplot bounties claim <id>               — Claim a bounty
 *   nookplot bounties unclaim <id>             — Unclaim a bounty
 *   nookplot bounties submit <id>              — Submit work for a bounty
 *   nookplot bounties approve <id>             — Approve submitted work
 *   nookplot bounties dispute <id>             — Dispute a bounty
 *   nookplot bounties cancel <id>              — Cancel a bounty
 *
 * @module commands/bounties
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
  const cmd = program
    .command("bounties")
    .description("Full bounty lifecycle — create, claim, submit, approve, dispute, cancel");

  // nookplot bounties list (default)
  cmd
    .command("list", { isDefault: true })
    .description("List bounties on the network")
    .option("--limit <n>", "Max bounties to show", "20")
    .option("--status <n>", "Filter by status (0=Open, 1=Claimed, 2=Submitted, 3=Approved, 4=Disputed, 5=Cancelled)")
    .option("--community <name>", "Filter by community")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listBounties(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties show <id>
  cmd
    .command("show <id>")
    .description("View bounty detail")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showBountyDetail(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties create
  cmd
    .command("create")
    .description("Create a new bounty")
    .requiredOption("--title <title>", "Bounty title")
    .requiredOption("--description <desc>", "Bounty description")
    .requiredOption("--community <name>", "Community for the bounty")
    .requiredOption("--deadline <days>", "Deadline in days from now")
    .option("--reward <amount>", "Reward amount in USDC (default: 0 for non-token bounty)", "0")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await createBounty(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties claim <id>
  cmd
    .command("claim <id>")
    .description("Claim a bounty to work on it")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bountyAction(program.opts(), id, "claim", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties unclaim <id>
  cmd
    .command("unclaim <id>")
    .description("Release your claim on a bounty")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bountyAction(program.opts(), id, "unclaim", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties submit <id>
  cmd
    .command("submit <id>")
    .description("Submit work for a bounty")
    .requiredOption("--cid <cid>", "CID of the submission content")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await submitBounty(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties approve <id>
  cmd
    .command("approve <id>")
    .description("Approve submitted work (bounty creator only)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bountyAction(program.opts(), id, "approve", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties dispute <id>
  cmd
    .command("dispute <id>")
    .description("Dispute a bounty")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bountyAction(program.opts(), id, "dispute", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties cancel <id>
  cmd
    .command("cancel <id>")
    .description("Cancel a bounty (creator only)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await bountyAction(program.opts(), id, "cancel", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────

function loadAndValidate(globalOpts: { config?: string; gateway?: string; apiKey?: string }) {
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
  return config;
}

function requireWallet(config: { privateKey: string }): ethers.Wallet {
  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }
  try {
    return new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }
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

// ── Read commands ───────────────────────────────────────────

async function listBounties(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { limit?: string; status?: string; community?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching bounties…").start();

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
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching bounty #${id}…`).start();

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

// ── Write commands ──────────────────────────────────────────

async function createBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    title: string;
    description: string;
    community: string;
    deadline: string;
    reward?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const deadlineDays = parseInt(cmdOpts.deadline, 10);
  if (isNaN(deadlineDays) || deadlineDays < 1) {
    console.error(chalk.red("  ✗ Deadline must be a positive number of days."));
    process.exit(1);
  }

  const deadlineTs = Math.floor(Date.now() / 1000) + deadlineDays * 86400;

  const spinner = ora("Creating bounty…").start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/bounty",
    {
      apiKey: config.apiKey,
      body: {
        title: cmdOpts.title,
        description: cmdOpts.description,
        community: cmdOpts.community,
        deadline: deadlineTs,
        tokenRewardAmount: cmdOpts.reward ?? "0",
      },
    },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare bounty creation");
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
    spinner.fail("Failed to relay bounty creation");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ title: cmdOpts.title, community: cmdOpts.community, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Bounty "${cmdOpts.title}" created`));
  console.log(`    Community: ${cmdOpts.community}`);
  console.log(`    Deadline:  ${new Date(deadlineTs * 1000).toLocaleString()}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function submitBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { cid: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const spinner = ora(`Submitting work for bounty #${id}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    `/v1/prepare/bounty/${encodeURIComponent(id)}/submit`,
    { apiKey: config.apiKey, body: { submissionCid: cmdOpts.cid } },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare submission");
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
    spinner.fail("Failed to relay submission");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, submissionCid: cmdOpts.cid, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Work submitted for bounty #${id}`));
  console.log(`    Submission CID: ${cmdOpts.cid}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function bountyAction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  action: "claim" | "unclaim" | "approve" | "dispute" | "cancel",
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const actionLabels: Record<string, { present: string; past: string }> = {
    claim: { present: "Claiming", past: "Claimed" },
    unclaim: { present: "Unclaiming", past: "Unclaimed" },
    approve: { present: "Approving", past: "Approved" },
    dispute: { present: "Disputing", past: "Disputed" },
    cancel: { present: "Cancelling", past: "Cancelled" },
  };

  const label = actionLabels[action];
  const spinner = ora(`${label.present} bounty #${id}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    `/v1/prepare/bounty/${encodeURIComponent(id)}/${action}`,
    { apiKey: config.apiKey, body: {} },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail(`Failed to prepare ${action}`);
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
    spinner.fail(`Failed to relay ${action}`);
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, action, txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${label.past} bounty #${id}`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}
