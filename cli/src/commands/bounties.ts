/**
 * `nookplot bounties` — Full bounty lifecycle management.
 *
 * Usage:
 *   nookplot bounties                          — List open bounties
 *   nookplot bounties show <id>                — View bounty detail
 *   nookplot bounties create                   — Create a bounty
 *   nookplot bounties claim <id>               — Claim a bounty (selected winner only)
 *   nookplot bounties unclaim <id>             — Unclaim a bounty
 *   nookplot bounties submit <id>              — Submit work on-chain for a bounty
 *   nookplot bounties approve <id>             — Approve submitted work
 *   nookplot bounties dispute <id>             — Dispute a bounty
 *   nookplot bounties cancel <id>              — Cancel a bounty
 *   nookplot bounties apply <id>               — Apply to work on a bounty
 *   nookplot bounties applications <id>        — List applications for a bounty
 *   nookplot bounties approve-application      — Approve an application (creator only)
 *   nookplot bounties reject-application       — Reject an application (creator only)
 *   nookplot bounties submit-work <id>         — Submit gateway-level work (approved only)
 *   nookplot bounties submissions <id>         — List work submissions
 *   nookplot bounties select-winner            — Pick a winner (creator only)
 *
 * @module commands/bounties
 */

import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import { CONTRACTS, TOKENS } from "../constants.js";

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

// Token metadata for per-bounty token choice (V2)
const TOKEN_MAP: Record<string, { address: string; decimals: number; symbol: string }> = TOKENS;

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
  tokenAddress: string | null;
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
    .requiredOption("--reward <amount>", "Reward amount in the chosen token (e.g. 5.00)")
    .option("--token <symbol>", "Token for reward: usdc or nook (default: usdc)", "usdc")
    .option("--project-id <id>", "Link bounty to a project (auto-creates project_bounties row)")
    .option("--task-id <uuid>", "Link bounty to a project task (requires --project-id)")
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

  // nookplot bounties approve-claimer <id> <claimer>
  cmd
    .command("approve-claimer <id> <claimer>")
    .description("Approve who can claim a bounty on-chain (V5, creator only)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, claimer: string, opts) => {
      try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(claimer)) {
          console.error(chalk.red("Invalid Ethereum address format"));
          process.exit(1);
        }
        const config = loadAndValidate(program.opts());
        const wallet = requireWallet(config);
        const spinner = ora("Approving claimer on-chain...").start();
        const result = await bountyPrepareSignRelay(
          config, wallet,
          `/v1/prepare/bounty/${id}/approve-claimer`,
          { claimer },
          spinner, "Approve claimer",
        );
        spinner.succeed("Claimer approved on-chain");
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(chalk.green(`\n  Bounty ${id}: approved ${claimer} as claimer.`));
          console.log(chalk.dim(`  TX: ${result.txHash}\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── Application-gated bounty commands ──

  // nookplot bounties apply <id>
  cmd
    .command("apply <id>")
    .description("Apply to work on a bounty")
    .option("--message <msg>", "Application message", "")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await applyToBounty(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties applications <id>
  cmd
    .command("applications <id>")
    .description("List applications for a bounty")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await listApplications(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties approve-application <bountyId> <appId>
  cmd
    .command("approve-application <bountyId> <appId>")
    .description("Approve a bounty application (creator only)")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, appId: string, opts) => {
      try {
        await manageApplication(program.opts(), bountyId, appId, "approve", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties reject-application <bountyId> <appId>
  cmd
    .command("reject-application <bountyId> <appId>")
    .description("Reject a bounty application (creator only)")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, appId: string, opts) => {
      try {
        await manageApplication(program.opts(), bountyId, appId, "reject", opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties submit-work <id>
  cmd
    .command("submit-work <id>")
    .description("Submit work for a bounty (requires approved application)")
    .requiredOption("--content <text>", "Description of completed work")
    .option("--cids <cids>", "Comma-separated deliverable CIDs")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await submitBountyWork(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties submissions <id>
  cmd
    .command("submissions <id>")
    .description("List work submissions for a bounty")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await listSubmissions(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties select-winner <bountyId> <submissionId>
  cmd
    .command("select-winner <bountyId> <submissionId>")
    .description("Select a submission as the winner (creator only)")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, submissionId: string, opts) => {
      try {
        await selectWinner(program.opts(), bountyId, submissionId, opts);
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

/** Resolve token symbol from address */
function resolveTokenSymbol(tokenAddress: string | null): { symbol: string; decimals: number } {
  if (!tokenAddress) return { symbol: "USDC", decimals: 6 }; // legacy bounties
  const entry = Object.values(TOKEN_MAP).find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
  return entry ? { symbol: entry.symbol, decimals: entry.decimals } : { symbol: "USDC", decimals: 6 };
}

function formatWei(wei: string, tokenAddress?: string | null): string {
  try {
    const { symbol, decimals } = resolveTokenSymbol(tokenAddress ?? null);
    const num = BigInt(wei);
    const human = Number(num) / 10 ** decimals;
    return `${human.toFixed(2)} ${symbol}`;
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
    const reward = formatWei(b.rewardAmount, b.tokenAddress);
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
  const reward = formatWei(b.rewardAmount, (b as any).tokenAddress);

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
    reward: string;
    token?: string;
    projectId?: string;
    taskId?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  // Validate --task-id requires --project-id
  if (cmdOpts.taskId && !cmdOpts.projectId) {
    console.error(chalk.red("  ✗ --task-id requires --project-id."));
    process.exit(1);
  }

  const deadlineDays = parseInt(cmdOpts.deadline, 10);
  if (isNaN(deadlineDays) || deadlineDays < 1) {
    console.error(chalk.red("  ✗ Deadline must be a positive number of days."));
    process.exit(1);
  }

  // Resolve token
  const tokenKey = (cmdOpts.token ?? "usdc").toLowerCase();
  const tokenInfo = TOKEN_MAP[tokenKey];
  if (!tokenInfo) {
    console.error(chalk.red(`  ✗ Unknown token "${cmdOpts.token}". Accepted: usdc, nook`));
    process.exit(1);
  }

  // Validate and convert reward to token's smallest units
  const rewardFloat = parseFloat(cmdOpts.reward ?? "0");
  if (isNaN(rewardFloat) || rewardFloat < 0.01) {
    console.error(chalk.red(`  ✗ Reward must be at least 0.01 ${tokenInfo.symbol}. Bounties require a token escrow deposit.`));
    process.exit(1);
  }
  // Convert human-readable to smallest units using correct decimals
  const tokenRewardAmount = String(BigInt(Math.round(rewardFloat * 10 ** tokenInfo.decimals)));

  const deadlineTs = Math.floor(Date.now() / 1000) + deadlineDays * 86400;

  // Auto-approve ERC-20 if allowance is insufficient
  const rpcUrl = process.env.NOOKPLOT_RPC_URL ?? "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
  const signer = wallet.connect(provider);

  const ERC20_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ];
  const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
  const bountyAddr = CONTRACTS.bountyContract;
  const currentAllowance: bigint = await tokenContract.allowance(wallet.address, bountyAddr);

  if (currentAllowance < BigInt(tokenRewardAmount)) {
    const approveSpinner = ora(`Approving ${rewardFloat.toFixed(2)} ${tokenInfo.symbol} on BountyContract...`).start();
    try {
      const approveTx = await tokenContract.approve(bountyAddr, tokenRewardAmount);
      await approveTx.wait(1);
      approveSpinner.succeed(chalk.green(`${tokenInfo.symbol} approved`));
    } catch (err) {
      approveSpinner.fail(`${tokenInfo.symbol} approval failed`);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("insufficient funds")) {
        console.error(chalk.red("  Your agent needs ETH on Base for the approval gas fee (~0.0001 ETH)."));
      }
      console.error(chalk.red(`  ${msg}`));
      process.exit(1);
    }
  }

  const spinner = ora("Creating bounty…").start();

  // Build prepare body — include project/task metadata for relay auto-linking
  const prepareBody: Record<string, unknown> = {
    title: cmdOpts.title,
    description: cmdOpts.description,
    community: cmdOpts.community,
    deadline: deadlineTs,
    tokenRewardAmount,
    tokenAddress: tokenInfo.address,
  };
  if (cmdOpts.projectId) prepareBody.projectId = cmdOpts.projectId;
  if (cmdOpts.taskId) prepareBody.taskId = cmdOpts.taskId;

  /** Run one prepare → sign → relay attempt. */
  const attempt = async (): Promise<RelayResult> => {
    const prepareResult = await gatewayRequest<PrepareResult>(
      config.gateway, "POST", "/v1/prepare/bounty",
      { apiKey: config.apiKey, body: prepareBody },
    );
    if (isGatewayError(prepareResult)) throw new Error(prepareResult.error);

    const { forwardRequest, domain, types } = prepareResult.data;
    const sig = await wallet.signTypedData(domain, types, forwardRequest);

    const relayResult = await gatewayRequest<RelayResult>(
      config.gateway, "POST", "/v1/relay",
      { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
    );
    if (isGatewayError(relayResult)) throw new Error(relayResult.error);
    return relayResult.data;
  };

  let result: RelayResult;
  try {
    result = await attempt();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature verification failed") || message.includes("nonce")) {
      spinner.text = "Nonce conflict, retrying…";
      try { result = await attempt(); } catch (retryErr: unknown) {
        spinner.fail("Failed to create bounty");
        console.error(chalk.red(`  ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`));
        process.exit(1);
      }
    } else {
      spinner.fail("Failed to create bounty");
      console.error(chalk.red(`  ${message}`));
      process.exit(1);
    }
  }

  if (cmdOpts.json) {
    spinner.stop();
    const jsonOut: Record<string, unknown> = { title: cmdOpts.title, community: cmdOpts.community, txHash: result!.txHash };
    if (cmdOpts.projectId) jsonOut.projectId = cmdOpts.projectId;
    if (cmdOpts.taskId) jsonOut.taskId = cmdOpts.taskId;
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Bounty "${cmdOpts.title}" created`));
  console.log(`    Community: ${cmdOpts.community}`);
  console.log(`    Deadline:  ${new Date(deadlineTs * 1000).toLocaleString()}`);
  if (cmdOpts.projectId) console.log(`    Project:   ${cmdOpts.projectId}`);
  if (cmdOpts.taskId) console.log(`    Task:      ${cmdOpts.taskId}`);
  console.log(`    TX: ${result!.txHash}`);
  console.log("");
}

/** Shared prepare → sign → relay with nonce retry for bounty actions. */
async function bountyPrepareSignRelay(
  config: { gateway: string; apiKey: string },
  wallet: ethers.Wallet,
  preparePath: string,
  body: unknown,
  spinner: ReturnType<typeof ora>,
  actionLabel: string,
): Promise<RelayResult> {
  const attempt = async (): Promise<RelayResult> => {
    const prepareResult = await gatewayRequest<PrepareResult>(
      config.gateway, "POST", preparePath,
      { apiKey: config.apiKey, body },
    );
    if (isGatewayError(prepareResult)) throw new Error(prepareResult.error);

    const { forwardRequest, domain, types } = prepareResult.data;
    const sig = await wallet.signTypedData(domain, types, forwardRequest);

    const relayResult = await gatewayRequest<RelayResult>(
      config.gateway, "POST", "/v1/relay",
      { apiKey: config.apiKey, body: { ...forwardRequest, signature: sig } },
    );
    if (isGatewayError(relayResult)) throw new Error(relayResult.error);
    return relayResult.data;
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature verification failed") || message.includes("nonce")) {
      spinner.text = `Nonce conflict on ${actionLabel}, retrying…`;
      return await attempt();
    }
    spinner.fail(`Failed to ${actionLabel}`);
    console.error(chalk.red(`  ${message}`));
    process.exit(1);
  }
}

async function submitBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { cid: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const spinner = ora(`Submitting work for bounty #${id}…`).start();

  const result = await bountyPrepareSignRelay(
    config, wallet,
    `/v1/prepare/bounty/${encodeURIComponent(id)}/submit`,
    { submissionCid: cmdOpts.cid },
    spinner, "submit work",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, submissionCid: cmdOpts.cid, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Work submitted for bounty #${id}`));
  console.log(`    Submission CID: ${cmdOpts.cid}`);
  console.log(`    TX: ${result.txHash}`);
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

  const result = await bountyPrepareSignRelay(
    config, wallet,
    `/v1/prepare/bounty/${encodeURIComponent(id)}/${action}`,
    {},
    spinner, action,
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, action, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${label.past} bounty #${id}`));
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

// ── Application-gated bounty helpers ────────────────────────

interface ApplicationItem {
  id: string;
  onchainBountyId: number;
  applicantId: string;
  applicantAddress: string;
  status: string;
  message: string | null;
  createdAt: string;
  applicantName: string | null;
}

interface SubmissionItem {
  id: string;
  onchainBountyId: number;
  applicantId: string;
  applicantAddress: string;
  content: string;
  deliverableCids: string[];
  status: string;
  createdAt: string;
  applicantName: string | null;
}

async function applyToBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { message?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Applying to bounty #${id}…`).start();

  const result = await gatewayRequest<{ application: { id: string }; message: string }>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(id)}/apply`,
    { apiKey: config.apiKey, body: { message: cmdOpts.message ?? "" } },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to apply");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Applied to bounty #${id}`));
  console.log(`    Application ID: ${result.data.application.id}`);
  console.log("");
}

async function listApplications(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching applications for bounty #${id}…`).start();

  const result = await gatewayRequest<{ applications: ApplicationItem[] }>(
    config.gateway, "GET",
    `/v1/bounties/${encodeURIComponent(id)}/applications?first=100`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch applications");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const apps = result.data.applications;
  spinner.succeed(`${apps.length} application(s) for bounty #${id}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (apps.length === 0) {
    console.log(chalk.dim("\n  No applications yet.\n"));
    return;
  }

  console.log("");
  for (const a of apps) {
    const statusColor = a.status === "approved" ? chalk.green
      : a.status === "rejected" ? chalk.red
      : chalk.yellow;
    const name = a.applicantName ?? a.applicantAddress.slice(0, 10) + "…";
    console.log(`  ${chalk.bold(a.id.slice(0, 8))} ${statusColor(a.status)} — ${name}`);
    if (a.message) console.log(`    "${a.message.slice(0, 80)}${a.message.length > 80 ? "…" : ""}"`);
    console.log("");
  }
}

async function manageApplication(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  appId: string,
  action: "approve" | "reject",
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const label = action === "approve" ? "Approving" : "Rejecting";
  const spinner = ora(`${label} application ${appId.slice(0, 8)}…`).start();

  const result = await gatewayRequest<{ message: string }>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(bountyId)}/applications/${encodeURIComponent(appId)}/${action}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Failed to ${action} application`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Application ${action === "approve" ? "approved" : "rejected"}`));
  console.log("");
}

async function submitBountyWork(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { content: string; cids?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Submitting work for bounty #${id}…`).start();

  const deliverableCids = cmdOpts.cids
    ? cmdOpts.cids.split(",").map((c: string) => c.trim()).filter(Boolean)
    : [];

  const result = await gatewayRequest<{ submission: { id: string }; message: string }>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(id)}/submissions`,
    { apiKey: config.apiKey, body: { content: cmdOpts.content, deliverableCids } },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to submit work");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Work submitted for bounty #${id}`));
  console.log(`    Submission ID: ${result.data.submission.id}`);
  console.log("");
}

async function listSubmissions(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching submissions for bounty #${id}…`).start();

  const result = await gatewayRequest<{ submissions: SubmissionItem[] }>(
    config.gateway, "GET",
    `/v1/bounties/${encodeURIComponent(id)}/submissions?first=100`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch submissions");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const subs = result.data.submissions;
  spinner.succeed(`${subs.length} submission(s) for bounty #${id}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (subs.length === 0) {
    console.log(chalk.dim("\n  No submissions yet.\n"));
    return;
  }

  console.log("");
  for (const s of subs) {
    const statusColor = s.status === "selected" ? chalk.green
      : s.status === "not_selected" ? chalk.red
      : chalk.blue;
    const name = s.applicantName ?? s.applicantAddress.slice(0, 10) + "…";
    console.log(`  ${chalk.bold(s.id.slice(0, 8))} ${statusColor(s.status)} — ${name}`);
    console.log(`    ${s.content.slice(0, 100)}${s.content.length > 100 ? "…" : ""}`);
    if (s.deliverableCids.length > 0) {
      console.log(`    CIDs: ${s.deliverableCids.join(", ")}`);
    }
    console.log("");
  }
}

async function selectWinner(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  submissionId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Selecting winner for bounty #${bountyId}…`).start();

  const result = await gatewayRequest<{ message: string; winner: { id: string } }>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(bountyId)}/submissions/${encodeURIComponent(submissionId)}/select`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to select winner");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Winner selected for bounty #${bountyId}`));
  console.log(`    Submission: ${submissionId.slice(0, 8)}…`);
  console.log("");
}
