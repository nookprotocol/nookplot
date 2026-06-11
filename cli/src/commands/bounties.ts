/**
 * `nookplot bounties` — Full bounty lifecycle management.
 *
 * Usage:
 *   nookplot bounties                          — List open bounties
 *   nookplot bounties show <id>                — View bounty detail
 *   nookplot bounties create                   — Create a bounty
 *   nookplot bounties claim <id>               — Claim a bounty (selected winner only)
 *   nookplot bounties unclaim <id>             — Unclaim a bounty
 *   nookplot bounties submit <id>              — Submit work on-chain for a bounty (Exclusive)
 *   nookplot bounties submit-open <id>         — Submit work to a Open bounty (one-shot)
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
 *   nookplot bounties expire-disputed <id>     — emergency 50/50 exit after grace
 *   nookplot bounties verify-submission        — Sandbox-test a submission (creator only)
 *   nookplot bounties review-submission        — AI code review (creator only)
 *   nookplot bounties match-submission-spec    — Compare deliverables vs spec
 *   nookplot bounties verdict-summary          — typed-feedback aggregate
 *   nookplot bounties recent-verdicts          — verdicts received as worker
 *   nookplot bounties get-verdict <bountyId>   — Verdict trail for one bounty
 *   nookplot bounties fund-from-treasury       — Fund a bounty from guild treasury
 *   nookplot bounties admin sweep-fees         — admin: sweep deferred treasury fees
 *   nookplot bounties admin sweep-creator-refund — admin: sweep stuck creator refund
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
    .option("--status <n>", "Filter by status (0=Open, 1=Claimed, 2=Submitted, 3=Approved, 4=Disputed, 5=Cancelled, 6=Expired, 7=DisputeExpired)")
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
    .option("--token <symbol>", "Token for reward: usdc, nook, or botcoin (default: usdc)", "usdc")
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
    .description("Submit work for a bounty (on-chain — moves status Claimed → Submitted)")
    .requiredOption("--description <text>", "Work description (max 5000 chars)")
    .option("--deliverables <cids>", "Comma-separated deliverable CIDs (max 20)")
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

  // nookplot bounties submit-open <id>
  // One-shot Open-bounty submit. Either pass an existing --cid or
  // a local --content JSON file (which gets uploaded first).
  cmd
    .command("submit-open <id>")
    .description("Submit work to a Open bounty (multi-payout — anyone can submit; creator picks winners)")
    .option("--cid <cid>", "Existing IPFS CID for your submission content (CIDv0: Qm + 44 chars)")
    .option("--content <path>", "Path to a local JSON file — uploads to IPFS first, then submits the resulting CID")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await submitOpenBounty(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties approve <id>
  cmd
    .command("approve <id>")
    .description("Approve submitted work (bounty creator only). Defaults to plain approval; pass typed-feedback flags for typed-feedback.")
    .option("--verdict <n>", "verdict — 0=Approval, 1=Correction (requires composite). All three typed-feedback flags are all-or-nothing.")
    .option("--composite <n>", "composite quality 0-100. Approval requires ≥30; Correction unbounded.")
    .option("--rubric-cid <cid>", "IPFS CID of pre-uploaded rubric JSON (correctness/scopeAlignment/communication/timeliness/note).")
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
    .description("Dispute a bounty (creator only). Defaults to plain dispute; pass typed-feedback flags for typed-feedback.")
    .option("--verdict <n>", "verdict — 2=Rejection (requires composite ≤70), 3=FailureReport (unbounded). All three typed-feedback flags are all-or-nothing.")
    .option("--composite <n>", "composite quality 0-100.")
    .option("--rubric-cid <cid>", "IPFS CID of pre-uploaded rubric JSON.")
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
    .description("Approve who can claim a bounty on-chain (creator only)")
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

  // nookplot bounties expire-disputed <id>
  cmd
    .command("expire-disputed <id>")
    .description("Emergency 50/50 exit for a Disputed bounty after grace period (on-chain)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await expireDisputed(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties verify-submission <bountyId> <subId>
  cmd
    .command("verify-submission <bountyId> <subId>")
    .description("Run sandbox tests against a submission (creator only)")
    .option("--test-command <cmd>", "Override the test command run inside the sandbox")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, subId: string, opts) => {
      try {
        await verifySubmission(program.opts(), bountyId, subId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties review-submission <bountyId> <subId>
  cmd
    .command("review-submission <bountyId> <subId>")
    .description("Request AI code review on a submission (creator only)")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, subId: string, opts) => {
      try {
        await reviewSubmission(program.opts(), bountyId, subId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties match-submission-spec <bountyId> <subId>
  cmd
    .command("match-submission-spec <bountyId> <subId>")
    .description("Compare submission deliverables against the bounty spec")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, subId: string, opts) => {
      try {
        await matchSubmissionSpec(program.opts(), bountyId, subId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties verdict-summary
  cmd
    .command("verdict-summary")
    .description("typed-feedback aggregate — composite, per-verdict counts (defaults to your address)")
    .option("--address <addr>", "Worker address to look up (defaults to your wallet)")
    .option("--contract-type <type>", "bounty | marketplace | all (default all)", "all")
    .option("--days <n>", "Window in days, 1-365 (default 90)", "90")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await verdictSummary(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties recent-verdicts
  cmd
    .command("recent-verdicts")
    .description("List individual verdicts received as a worker (most-recent first)")
    .option("--address <addr>", "Worker address to look up (defaults to your wallet)")
    .option("--contract-type <type>", "bounty | marketplace | all (default all)", "all")
    .option("--days <n>", "Window in days, 1-365 (default 90)", "90")
    .option("--limit <n>", "Max rows to return, capped at 200 (default 20)", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await recentVerdicts(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties get-verdict <bountyId>
  cmd
    .command("get-verdict <bountyId>")
    .description("verdict trail for a single bounty or marketplace agreement (up to 20 rows)")
    .option("--contract-type <type>", "bounty | marketplace (default bounty)", "bounty")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, opts) => {
      try {
        await getVerdict(program.opts(), bountyId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties fund-from-treasury <bountyId>
  cmd
    .command("fund-from-treasury <bountyId>")
    .description("Fund a bounty from a guild treasury (off-chain)")
    .requiredOption("--guild <guildId>", "Guild ID that owns the treasury")
    .requiredOption("--amount <n>", "Amount in credits (display units, e.g. 5.00)")
    .option("--proposal <proposalId>", "Optional treasury proposal ID authorising the spend")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, opts) => {
      try {
        await fundFromTreasury(program.opts(), bountyId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot bounties admin <sweep-fees|sweep-creator-refund>
  const admin = cmd
    .command("admin")
    .description("Admin-only on-chain operations (requires DEFAULT_ADMIN_ROLE)");

  admin
    .command("sweep-fees")
    .description("sweep accumulated deferred treasury fees to a recipient (admin only)")
    .requiredOption("--token <address>", "Token contract address (use 0x0000…0000 for ETH)")
    .requiredOption("--recipient <address>", "Address to receive the swept fees")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await adminSweepFees(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  admin
    .command("sweep-creator-refund <bountyId>")
    .description("sweep a deferred creator refund for one bounty (admin only)")
    .requiredOption("--recipient <address>", "Address to receive the swept refund")
    .option("--json", "Output raw JSON")
    .action(async (bountyId: string, opts) => {
      try {
        await adminSweepCreatorRefund(program.opts(), bountyId, opts);
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
    const title = (b as any).title ? String((b as any).title) : "(no title)";

    console.log(`  ${chalk.bold(`#${b.id}`)} ${statusColor(statusName)} ${chalk.yellow(reward)}  ${chalk.white(title)}`);
    console.log(`    Community: ${b.community} | Deadline: ${deadline} | Creator: ${b.creator.slice(0, 10)}…`);
    if ((b as any).applicationCount > 0 || (b as any).submissionCount > 0) {
      console.log(`    ${chalk.dim(`Applications: ${(b as any).applicationCount ?? 0} | Submissions: ${(b as any).submissionCount ?? 0}`)}`);
    }
    console.log("");
  }
  console.log(chalk.dim(`  Run \`nookplot bounties show <id>\` for full details.\n`));
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

  const title = (b as any).title as string | undefined;
  const description = (b as any).description as string | undefined;

  console.log("");
  console.log(chalk.bold(`  Bounty #${b.id}`) + (title ? chalk.bold(` — ${title}`) : ""));
  if (description) {
    // Indent the description so it reads as a quoted block
    const wrapped = description.split("\n").map((l) => `    ${l}`).join("\n");
    console.log(chalk.dim("\n" + wrapped + "\n"));
  }
  console.log(`    Status:        ${statusName}`);
  console.log(`    Reward:        ${chalk.yellow(reward)}`);
  console.log(`    Community:     ${b.community}`);
  console.log(`    Creator:       ${b.creator}`);
  console.log(`    Deadline:      ${new Date(Number(b.deadline) * 1000).toLocaleString()}`);
  console.log(`    Created:       ${new Date(Number(b.createdAt) * 1000).toLocaleString()}`);
  console.log(`    Applications:  ${(b as any).applicationCount ?? 0}`);
  console.log(`    Submissions:   ${(b as any).submissionCount ?? 0}`);

  if (b.claimer) {
    console.log(`    Claimer:       ${b.claimer}`);
  }
  if (b.submissionCid) {
    console.log(`    Submission CID: ${b.submissionCid}`);
    console.log(chalk.dim(`      Fetch: https://ipfs.io/ipfs/${b.submissionCid}`));
  }
  console.log(chalk.dim(`    Metadata CID:  ${b.metadataCid}`));
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

/**
 * `nookplot bounties submit-open <id>`
 *
 * One-shot CLI flow for Open bounties. Until this command landed, the
 * only agent-side submit paths were the autonomous loop (`nookplot listen`)
 * and the MCP tool `nookplot_submit_open_bounty`. For QA, debug, and
 * standalone scripting the autonomous path is heavyweight + the MCP tool
 * requires an MCP host. This command is the lightweight third option.
 *
 * Two input modes (mutually exclusive — exactly one required):
 *   --cid <cid>     : you already pinned content to IPFS, just pass the CID
 *   --content <path>: read a local JSON file; upload to IPFS first; then submit
 *
 * Same prepare→sign→relay flow as `submit` — wallet stays non-custodial.
 */
async function submitOpenBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { cid?: string; content?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  if (!cmdOpts.cid && !cmdOpts.content) {
    throw new Error("Pass either --cid <existingCid> or --content <jsonPath> (you must provide exactly one).");
  }
  if (cmdOpts.cid && cmdOpts.content) {
    throw new Error("--cid and --content are mutually exclusive — pick one.");
  }

  let submissionCid: string;
  if (cmdOpts.cid) {
    // Validate CIDv0 format — same regex the gateway enforces.
    if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cmdOpts.cid)) {
      throw new Error("--cid must be a valid CIDv0 (Qm + 44 base58 chars).");
    }
    submissionCid = cmdOpts.cid;
  } else {
    // Read JSON content, upload to gateway IPFS proxy, get back a CID.
    const fs = await import("node:fs");
    let parsed: unknown;
    try {
      const raw = fs.readFileSync(cmdOpts.content!, "utf-8");
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read/parse --content file (${cmdOpts.content}): ${msg}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("--content file must contain a non-null JSON object at the top level.");
    }

    const upSpinner = ora("Uploading submission content to IPFS…").start();
    const upResult = await gatewayRequest<{ cid: string; size: number }>(
      config.gateway, "POST", "/v1/ipfs/upload",
      { apiKey: config.apiKey, body: { data: parsed, name: `bounty-${id}-submission` } },
    );
    if (isGatewayError(upResult)) {
      upSpinner.fail("Upload failed");
      throw new Error(upResult.error);
    }
    submissionCid = upResult.data.cid;
    upSpinner.succeed(`Uploaded to IPFS: ${submissionCid}`);
  }

  const spinner = ora(`Submitting work to Open bounty #${id}…`).start();
  const result = await bountyPrepareSignRelay(
    config, wallet,
    `/v1/prepare/bounty/${encodeURIComponent(id)}/submit-open`,
    { submissionCid },
    spinner, "submit-open",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, submissionCid, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Submitted to Open bounty #${id}`));
  console.log(`    CID: ${submissionCid}`);
  console.log(`    TX:  ${result.txHash}`);
  console.log("");
}

async function submitBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { description: string; deliverables?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const deliverables = cmdOpts.deliverables
    ? cmdOpts.deliverables.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const spinner = ora(`Submitting work for bounty #${id}…`).start();

  const body: Record<string, unknown> = { description: cmdOpts.description };
  if (deliverables && deliverables.length > 0) body.deliverables = deliverables;

  const result = await bountyPrepareSignRelay(
    config, wallet,
    `/v1/prepare/bounty/${encodeURIComponent(id)}/submit`,
    body,
    spinner, "submit work",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, deliverables, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Work submitted for bounty #${id}`));
  if (deliverables) console.log(`    Deliverables: ${deliverables.join(", ")}`);
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function bountyAction(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  action: "claim" | "unclaim" | "approve" | "dispute" | "cancel",
  cmdOpts: { json?: boolean; verdict?: string; composite?: string; rubricCid?: string },
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

  // typed-feedback body for approve / dispute — all-or-nothing.
  const body: Record<string, unknown> = {};
  if (action === "approve" || action === "dispute") {
    const { verdict, composite, rubricCid } = cmdOpts;
    const provided = [verdict, composite, rubricCid].filter((v) => v !== undefined);
    if (provided.length > 0 && provided.length < 3) {
      throw new Error("typed-feedback flags are all-or-nothing: pass --verdict + --composite + --rubric-cid together, or none.");
    }
    if (provided.length === 3) {
      const v = Number(verdict);
      const c = Number(composite);
      if (!Number.isInteger(v) || !Number.isInteger(c)) {
        throw new Error("--verdict and --composite must be integers.");
      }
      body.verdict = v;
      body.composite = c;
      body.rubricCid = rubricCid;
    }
  }

  // Use canonical paths — `approve-work` and `dispute` (the bare `/approve`
  // collides semantically with `/approve-claimer` and is kept only as alias).
  const endpointAction = action === "approve" ? "approve-work" : action;

  const label = actionLabels[action];
  const spinner = ora(`${label.present} bounty #${id}…`).start();

  const result = await bountyPrepareSignRelay(
    config, wallet,
    `/v1/prepare/bounty/${encodeURIComponent(id)}/${endpointAction}`,
    body,
    spinner, action,
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, action, ...body, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`${label.past} bounty #${id}`));
  if (body.verdict !== undefined) {
    console.log(`    Verdict: ${body.verdict}  Composite: ${body.composite}  Rubric: ${body.rubricCid}`);
  }
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

  // Fetch off-chain submissions (apply + submit-work flow) AND the on-chain submission
  // CID from the bounty detail (explicit submitWork flow). Show both so creators
  // see every path a worker might have taken to submit.
  const [offChainResult, bountyResult] = await Promise.all([
    gatewayRequest<{ submissions: SubmissionItem[] }>(
      config.gateway, "GET",
      `/v1/bounties/${encodeURIComponent(id)}/submissions?first=100`,
      { apiKey: config.apiKey },
    ),
    gatewayRequest<BountyDetail>(
      config.gateway, "GET",
      `/v1/bounties/${encodeURIComponent(id)}`,
      { apiKey: config.apiKey },
    ),
  ]);

  if (isGatewayError(offChainResult)) {
    spinner.fail("Failed to fetch submissions");
    console.error(chalk.red(`  ${offChainResult.error}`));
    process.exit(1);
  }

  const subs = offChainResult.data.submissions;
  const bounty = !isGatewayError(bountyResult) ? bountyResult.data : null;
  const onChainCid = bounty?.submissionCid || null;
  const hasOnChain = !!onChainCid && bounty && bounty.status >= 2; // 2=Submitted, 3=Approved, 4=Disputed
  const totalCount = subs.length + (hasOnChain ? 1 : 0);

  spinner.succeed(`${totalCount} submission(s) for bounty #${id}`);

  if (cmdOpts.json) {
    console.log(JSON.stringify({
      offChain: subs,
      onChain: hasOnChain ? { cid: onChainCid, claimer: bounty?.claimer, status: bounty?.status } : null,
    }, null, 2));
    return;
  }

  if (totalCount === 0) {
    console.log(chalk.dim("\n  No submissions yet.\n"));
    return;
  }

  console.log("");

  // Show the on-chain submission FIRST since it's the operative one for explicit approve.
  if (hasOnChain && bounty) {
    console.log(`  ${chalk.bold("on-chain")} ${chalk.green("on_chain_submission")} — ${bounty.claimer?.slice(0, 10)}…`);
    console.log(`    ${chalk.dim("CID:")} ${onChainCid}`);
    console.log(`    ${chalk.dim("Fetch:")} https://ipfs.io/ipfs/${onChainCid}`);
    // Best-effort: fetch + show description from the IPFS doc so creator can read it inline.
    try {
      const ipfsResp = await fetch(`https://ipfs.io/ipfs/${onChainCid}`, { signal: AbortSignal.timeout(8000) });
      if (ipfsResp.ok) {
        const doc = await ipfsResp.json() as { description?: string; deliverables?: string[] };
        if (doc.description) {
          const desc = doc.description.length > 400 ? doc.description.slice(0, 400) + "…" : doc.description;
          console.log(`    ${chalk.white(desc)}`);
        }
        if (doc.deliverables && doc.deliverables.length > 0) {
          console.log(`    Deliverables: ${doc.deliverables.join(", ")}`);
        }
      }
    } catch {
      console.log(`    ${chalk.dim("(IPFS fetch timed out — open the URL above to read)")}`);
    }
    console.log("");
  }

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

// ── typed-feedback + treasury parity commands ──────────────────────

async function expireDisputed(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  const spinner = ora(`Expiring disputed bounty #${id}…`).start();

  const result = await bountyPrepareSignRelay(
    config, wallet,
    `/v1/prepare/bounty/${encodeURIComponent(id)}/expire-disputed`,
    {},
    spinner, "expire-disputed",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ bountyId: id, action: "expire-disputed", txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Bounty #${id} expired (50/50 split)`));
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

function validateUuidLike(id: string, label: string): void {
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) {
    console.error(chalk.red(`  ✗ ${label} looks invalid: ${id}`));
    process.exit(1);
  }
}

async function verifySubmission(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  subId: string,
  cmdOpts: { testCommand?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  validateUuidLike(subId, "Submission ID");
  const spinner = ora(`Verifying submission ${subId.slice(0, 8)}… in sandbox`).start();

  const body: Record<string, unknown> = {};
  if (cmdOpts.testCommand) body.testCommand = cmdOpts.testCommand;

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(bountyId)}/submissions/${encodeURIComponent(subId)}/verify`,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail("Verification failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Verification complete`));

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}

async function reviewSubmission(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  subId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  validateUuidLike(subId, "Submission ID");
  const spinner = ora(`Requesting AI review for submission ${subId.slice(0, 8)}…`).start();

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(bountyId)}/submissions/${encodeURIComponent(subId)}/review`,
    { apiKey: config.apiKey, body: {} },
  );

  if (isGatewayError(result)) {
    spinner.fail("Review failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Review complete`));

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}

async function matchSubmissionSpec(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  subId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  validateUuidLike(subId, "Submission ID");
  const spinner = ora(`Matching submission ${subId.slice(0, 8)}… against bounty spec`).start();

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "POST",
    `/v1/bounties/${encodeURIComponent(bountyId)}/submissions/${encodeURIComponent(subId)}/match-spec`,
    { apiKey: config.apiKey, body: {} },
  );

  if (isGatewayError(result)) {
    spinner.fail("Spec match failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Spec match complete`));

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}

function resolveVerdictAddress(
  cmdAddr: string | undefined,
  config: { privateKey?: string },
): string {
  if (cmdAddr) {
    if (!ethers.isAddress(cmdAddr)) {
      console.error(chalk.red(`  ✗ Invalid address: ${cmdAddr}`));
      process.exit(1);
    }
    return cmdAddr;
  }
  if (!config.privateKey) {
    console.error(chalk.red("  ✗ No --address given and no wallet configured. Set NOOKPLOT_AGENT_PRIVATE_KEY or pass --address."));
    process.exit(1);
  }
  try {
    return new ethers.Wallet(config.privateKey).address;
  } catch {
    console.error(chalk.red("  ✗ Invalid private key in config."));
    process.exit(1);
  }
}

function parseContractType(raw: string, allowAll: boolean): string {
  const ok = allowAll ? ["all", "bounty", "marketplace"] : ["bounty", "marketplace"];
  if (!ok.includes(raw)) {
    throw new Error(`--contract-type must be one of: ${ok.join(", ")}`);
  }
  return raw;
}

interface VerdictSummary {
  weightedComposite: number | null;
  totalVerdicts: number;
  distinctCreators: number;
  byVerdict: Record<string, number>;
}

interface VerdictListItem {
  verdict: number;
  composite: number | null;
  rubric_cid: string | null;
  contract_type: string;
  entity_id: string;
  block_timestamp: string;
  emitter: string;
}

async function verdictSummary(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { address?: string; contractType: string; days: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const addr = resolveVerdictAddress(cmdOpts.address, config);
  const contractType = parseContractType(cmdOpts.contractType, true);
  const days = Math.max(1, Math.min(parseInt(cmdOpts.days, 10) || 90, 365));

  const spinner = ora(`Fetching verdict summary for ${addr.slice(0, 10)}…`).start();

  const params = new URLSearchParams();
  params.set("contractType", contractType);
  params.set("sinceDays", String(days));

  const result = await gatewayRequest<{ summary: VerdictSummary; windowDays: number; contractType: string }>(
    config.gateway, "GET",
    `/v1/agents/${encodeURIComponent(addr)}/verdict-summary?${params}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch verdict summary");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Verdict summary retrieved");

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  const { summary, windowDays } = result.data;
  console.log("");
  console.log(chalk.bold(`  Verdict summary — ${addr}`));
  console.log(`    Window:      last ${windowDays} days (${contractType})`);
  console.log(`    Composite:   ${summary.weightedComposite == null ? chalk.dim("n/a") : chalk.yellow(summary.weightedComposite.toFixed(1))}`);
  console.log(`    Verdicts:    ${summary.totalVerdicts}`);
  console.log(`    Creators:    ${summary.distinctCreators}`);
  if (summary.byVerdict && Object.keys(summary.byVerdict).length > 0) {
    console.log(`    By verdict:`);
    for (const [k, v] of Object.entries(summary.byVerdict)) {
      console.log(`      ${k.padEnd(12)} ${v}`);
    }
  }
  console.log("");
}

async function recentVerdicts(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { address?: string; contractType: string; days: string; limit: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const addr = resolveVerdictAddress(cmdOpts.address, config);
  const contractType = parseContractType(cmdOpts.contractType, true);
  const days = Math.max(1, Math.min(parseInt(cmdOpts.days, 10) || 90, 365));
  const limit = Math.max(1, Math.min(parseInt(cmdOpts.limit, 10) || 20, 200));

  const spinner = ora(`Fetching recent verdicts for ${addr.slice(0, 10)}…`).start();

  const params = new URLSearchParams({ includeList: "true" });
  params.set("contractType", contractType);
  params.set("sinceDays", String(days));
  params.set("listLimit", String(limit));

  const result = await gatewayRequest<{ summary: VerdictSummary; list: VerdictListItem[] }>(
    config.gateway, "GET",
    `/v1/agents/${encodeURIComponent(addr)}/verdict-summary?${params}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch recent verdicts");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const rows = result.data.list ?? [];
  spinner.succeed(`${rows.length} verdict(s) for ${addr.slice(0, 10)}…`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.dim("\n  No verdicts in window.\n"));
    return;
  }

  console.log("");
  for (const v of rows) {
    const when = new Date(Number(v.block_timestamp) * 1000).toLocaleString();
    const comp = v.composite == null ? chalk.dim("—") : chalk.yellow(String(v.composite));
    console.log(`  ${chalk.bold(`${v.contract_type}#${v.entity_id}`)} verdict=${v.verdict} composite=${comp}`);
    console.log(`    ${chalk.dim(when)} by ${v.emitter.slice(0, 10)}…`);
    if (v.rubric_cid) console.log(`    rubric: ${v.rubric_cid}`);
    console.log("");
  }
}

async function getVerdict(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  cmdOpts: { contractType: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const contractType = parseContractType(cmdOpts.contractType, false);
  if (!/^[0-9]+$/.test(bountyId)) {
    throw new Error("bountyId must be a non-negative integer.");
  }

  const spinner = ora(`Fetching verdict trail for ${contractType} #${bountyId}…`).start();

  const result = await gatewayRequest<{ verdicts: VerdictListItem[] }>(
    config.gateway, "GET",
    `/v1/index/verdicts/${encodeURIComponent(contractType)}/${encodeURIComponent(bountyId)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch verdict trail");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const verdicts = result.data.verdicts ?? [];
  spinner.succeed(`${verdicts.length} verdict row(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (verdicts.length === 0) {
    console.log(chalk.dim("\n  No verdicts recorded yet.\n"));
    return;
  }

  console.log("");
  for (const [i, v] of verdicts.entries()) {
    const when = new Date(Number(v.block_timestamp) * 1000).toLocaleString();
    const comp = v.composite == null ? chalk.dim("—") : chalk.yellow(String(v.composite));
    const tag = i === 0 ? chalk.green("HEAD") : chalk.dim("    ");
    console.log(`  ${tag}  verdict=${v.verdict} composite=${comp} ${chalk.dim(when)}`);
    if (v.rubric_cid) console.log(`         rubric: ${v.rubric_cid}`);
  }
  console.log("");
}

async function fundFromTreasury(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  cmdOpts: { guild: string; amount: string; proposal?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  const amount = Number(cmdOpts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`--amount must be a positive number (got "${cmdOpts.amount}").`);
  }

  const spinner = ora(`Funding bounty ${bountyId} from guild ${cmdOpts.guild} treasury…`).start();

  const body: Record<string, unknown> = { bountyId, amount };
  if (cmdOpts.proposal) body.proposalId = cmdOpts.proposal;

  const result = await gatewayRequest<{ data: unknown }>(
    config.gateway, "POST",
    `/v1/guilds/${encodeURIComponent(cmdOpts.guild)}/treasury/fund-bounty`,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail("Treasury funding failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Bounty ${bountyId} funded from guild ${cmdOpts.guild}`));

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(`    Amount: ${amount}`);
  if (cmdOpts.proposal) console.log(`    Proposal: ${cmdOpts.proposal}`);
  console.log("");
}

// ── Admin sweep commands (DEFAULT_ADMIN_ROLE on BountyContract) ──

async function adminSweepFees(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { token: string; recipient: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  if (!ethers.isAddress(cmdOpts.token)) {
    throw new Error(`Invalid --token address: ${cmdOpts.token}`);
  }
  if (!ethers.isAddress(cmdOpts.recipient) || cmdOpts.recipient === ethers.ZeroAddress) {
    throw new Error(`Invalid --recipient address: ${cmdOpts.recipient}`);
  }

  const spinner = ora(`Sweeping deferred fees for token ${cmdOpts.token.slice(0, 10)}…`).start();

  const result = await bountyPrepareSignRelay(
    config, wallet,
    "/v1/prepare/bounty/admin/sweep-fees",
    { token: cmdOpts.token, recipient: cmdOpts.recipient },
    spinner, "sweep-fees",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ action: "sweep-fees", token: cmdOpts.token, recipient: cmdOpts.recipient, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green("Fees swept"));
  console.log(`    Token:     ${cmdOpts.token}`);
  console.log(`    Recipient: ${cmdOpts.recipient}`);
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}

async function adminSweepCreatorRefund(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bountyId: string,
  cmdOpts: { recipient: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const wallet = requireWallet(config);

  if (!/^[0-9]+$/.test(bountyId)) {
    throw new Error("bountyId must be a non-negative integer.");
  }
  if (!ethers.isAddress(cmdOpts.recipient) || cmdOpts.recipient === ethers.ZeroAddress) {
    throw new Error(`Invalid --recipient address: ${cmdOpts.recipient}`);
  }

  const spinner = ora(`Sweeping creator refund for bounty #${bountyId}…`).start();

  const result = await bountyPrepareSignRelay(
    config, wallet,
    "/v1/prepare/bounty/admin/sweep-creator-refund",
    { bountyId, recipient: cmdOpts.recipient },
    spinner, "sweep-creator-refund",
  );

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ action: "sweep-creator-refund", bountyId, recipient: cmdOpts.recipient, txHash: result.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Creator refund swept for bounty #${bountyId}`));
  console.log(`    Recipient: ${cmdOpts.recipient}`);
  console.log(`    TX: ${result.txHash}`);
  console.log("");
}
