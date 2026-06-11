/**
 * `nookplot bug-bounties` — External bug-bounty browsing and claim tracking.
 *
 * Mirrors the `nookplot_*_bug_bounty*` MCP tools so users who'd rather not
 * grant the MCP server permission can still browse Immunefi / Code4rena /
 * Sherlock programs and track their claims from a terminal.
 *
 * Usage:
 *   nookplot bug-bounties list                — Browse active programs
 *   nookplot bug-bounties show <id>           — Full detail for one program
 *   nookplot bug-bounties claims              — Your active claims
 *   nookplot bug-bounties claim-show <id>     — Status of one claim
 *   nookplot bug-bounties claim <bountyId>    — Register a new claim
 *   nookplot bug-bounties update-claim <id>   — Update claim progress / status
 *
 * @module commands/bug-bounties
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface BugBountyListItem {
  id: string;
  platform: string | null;
  name?: string | null;
  project_name?: string | null;
  max_reward?: number | null;
  maxReward?: number | null;
  chain?: string | string[] | null;
  language?: string | string[] | null;
  url?: string | null;
}

interface BugBountyListResponse {
  bounties?: BugBountyListItem[];
  total?: number;
}

interface BugBountyClaim {
  id: string;
  bug_bounty_id?: string;
  bugBountyId?: string;
  status: string;
  notes?: string | null;
  platform_submission_url?: string | null;
  platformSubmissionUrl?: string | null;
  severity_claimed?: string | null;
  severityClaimed?: string | null;
  reward_earned?: number | null;
  rewardEarned?: number | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
}

const ALLOWED_STATUSES = ["researching", "submitted", "accepted", "rejected", "withdrawn"];
const ALLOWED_SEVERITY = ["critical", "high", "medium", "low", "informational"];

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

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function fmtCell(v: unknown, fallback = "—"): string {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v.join(", ") || fallback;
  return String(v);
}

export function registerBugBountiesCommand(program: Command): void {
  const cmd = program
    .command("bug-bounties")
    .description("External bug-bounty programs (Immunefi, Code4rena, Sherlock) + claim tracking");

  // ── list ──
  cmd
    .command("list", { isDefault: true })
    .description("Browse active external bug bounties")
    .option("--platform <name>", "immunefi, code4rena, or sherlock")
    .option("--chain <name>", "Filter by blockchain (e.g. Ethereum, Base, Solana)")
    .option("--language <lang>", "Filter by language (e.g. Solidity, Rust, Move)")
    .option("--search <text>", "Search by project name or description")
    .option("--min-reward <usd>", "Minimum max reward in USD")
    .option("--sort-by <key>", "reward | date | updated", "reward")
    .option("--limit <n>", "Max results (default 25)", "25")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listBugBounties(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── show ──
  cmd
    .command("show <id>")
    .description("Get full details of one bug bounty program")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await showBugBounty(program.opts(), id, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── claims (my claims) ──
  cmd
    .command("claims")
    .description("List your active bug bounty claims")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await listMyClaims(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── claim-show ──
  cmd
    .command("claim-show <claimId>")
    .description("Get status of a specific claim")
    .option("--json", "Output raw JSON")
    .action(async (claimId: string, opts) => {
      try {
        await showClaim(program.opts(), claimId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── claim (create new claim) ──
  cmd
    .command("claim <bugBountyId>")
    .description("Create a tracking claim on a bug bounty (you still submit on the external platform)")
    .option("--notes <text>", "Initial research notes")
    .option("--json", "Output raw JSON")
    .action(async (bugBountyId: string, opts) => {
      try {
        await createClaim(program.opts(), bugBountyId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // ── update-claim ──
  cmd
    .command("update-claim <claimId>")
    .description("Update claim progress, status, submission URL, severity, or reward")
    .option("--status <s>", `New status: ${ALLOWED_STATUSES.join(" | ")}`)
    .option("--notes <text>", "Updated research notes")
    .option("--submission-url <url>", "URL of your submission on the external platform")
    .option("--severity <s>", `Severity reported: ${ALLOWED_SEVERITY.join(" | ")}`)
    .option("--reward <usd>", "Actual reward received (USD)")
    .option("--json", "Output raw JSON")
    .action(async (claimId: string, opts) => {
      try {
        await updateClaim(program.opts(), claimId, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

// ── Read commands ───────────────────────────────────────────

async function listBugBounties(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    platform?: string;
    chain?: string;
    language?: string;
    search?: string;
    minReward?: string;
    sortBy?: string;
    limit?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "25", 10) || 25, 1), 100);
  const params = new URLSearchParams({ status: "active", limit: String(limit) });
  if (cmdOpts.platform) params.set("platform", cmdOpts.platform);
  if (cmdOpts.chain) params.set("chain", cmdOpts.chain);
  if (cmdOpts.language) params.set("language", cmdOpts.language);
  if (cmdOpts.search) params.set("search", cmdOpts.search);
  if (cmdOpts.minReward) params.set("minReward", String(parseInt(cmdOpts.minReward, 10) || 0));
  if (cmdOpts.sortBy) params.set("sortBy", cmdOpts.sortBy);

  const spinner = ora("Fetching bug bounties…").start();

  const result = await gatewayRequest<BugBountyListResponse>(
    config.gateway, "GET",
    `/v1/integrations/bugbounties?${params}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch bug bounties");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const data = result.data;
  const bounties = data.bounties ?? [];
  spinner.succeed(`${data.total ?? bounties.length} active bug bounty(ies)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (bounties.length === 0) {
    console.log(chalk.dim("\n  No active programs match the filters.\n"));
    return;
  }

  console.log("");
  for (const [i, b] of bounties.entries()) {
    const reward = fmtUsd(b.max_reward ?? b.maxReward ?? null);
    const name = b.name ?? b.project_name ?? "(unnamed)";
    console.log(`  ${chalk.bold(`${i + 1}.`)} ${chalk.green(reward.padEnd(8))} ${chalk.bold(name)} ${chalk.dim(`[${b.platform ?? "?"}]`)}`);
    console.log(`     ${chalk.dim("chain:")} ${fmtCell(b.chain)}  ${chalk.dim("lang:")} ${fmtCell(b.language)}`);
    console.log(`     ${chalk.dim("id:")} ${b.id}`);
  }
  console.log("");
}

async function showBugBounty(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  id: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching bug bounty ${id.slice(0, 8)}…`).start();

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "GET",
    `/v1/integrations/bugbounties/${encodeURIComponent(id)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Bug bounty not found");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Bug bounty retrieved");

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}

async function listMyClaims(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching your bug bounty claims…").start();

  const result = await gatewayRequest<{ claims?: BugBountyClaim[] } | BugBountyClaim[]>(
    config.gateway, "GET",
    "/v1/integrations/bugbounties/claims",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch claims");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const data = result.data;
  const claims = Array.isArray(data) ? data : (data.claims ?? []);
  spinner.succeed(`${claims.length} claim(s)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (claims.length === 0) {
    console.log(chalk.dim("\n  No active claims yet. Use `nookplot bug-bounties claim <id>` to start one.\n"));
    return;
  }

  console.log("");
  for (const c of claims) {
    const color = c.status === "accepted" ? chalk.green
      : c.status === "rejected" || c.status === "withdrawn" ? chalk.red
      : chalk.yellow;
    console.log(`  ${chalk.bold(c.id.slice(0, 8))} ${color(c.status)}`);
    console.log(`    bounty: ${c.bug_bounty_id ?? c.bugBountyId ?? "?"}`);
    const subUrl = c.platform_submission_url ?? c.platformSubmissionUrl;
    if (subUrl) console.log(`    submission: ${subUrl}`);
    console.log("");
  }
}

async function showClaim(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  claimId: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Fetching claim ${claimId.slice(0, 8)}…`).start();

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "GET",
    `/v1/integrations/bugbounties/claims/${encodeURIComponent(claimId)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Claim not found");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Claim retrieved");

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}

// ── Write commands ──────────────────────────────────────────

async function createClaim(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  bugBountyId: string,
  cmdOpts: { notes?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Creating claim on ${bugBountyId.slice(0, 8)}…`).start();

  const body: Record<string, unknown> = {};
  if (cmdOpts.notes) body.notes = cmdOpts.notes;

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "POST",
    `/v1/integrations/bugbounties/${encodeURIComponent(bugBountyId)}/claim`,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail("Claim creation failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green("Claim created"));

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}

async function updateClaim(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  claimId: string,
  cmdOpts: {
    status?: string;
    notes?: string;
    submissionUrl?: string;
    severity?: string;
    reward?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  if (cmdOpts.status && !ALLOWED_STATUSES.includes(cmdOpts.status)) {
    throw new Error(`--status must be one of: ${ALLOWED_STATUSES.join(", ")}`);
  }
  if (cmdOpts.severity && !ALLOWED_SEVERITY.includes(cmdOpts.severity)) {
    throw new Error(`--severity must be one of: ${ALLOWED_SEVERITY.join(", ")}`);
  }

  const body: Record<string, unknown> = {};
  if (cmdOpts.status) body.status = cmdOpts.status;
  if (cmdOpts.notes) body.notes = cmdOpts.notes;
  if (cmdOpts.submissionUrl) body.platformSubmissionUrl = cmdOpts.submissionUrl;
  if (cmdOpts.severity) body.severityClaimed = cmdOpts.severity;
  if (cmdOpts.reward !== undefined) {
    const r = Number(cmdOpts.reward);
    if (!Number.isFinite(r) || r < 0) {
      throw new Error(`--reward must be a non-negative number (got "${cmdOpts.reward}").`);
    }
    body.rewardEarned = r;
  }

  if (Object.keys(body).length === 0) {
    throw new Error("Provide at least one of --status, --notes, --submission-url, --severity, --reward.");
  }

  const spinner = ora(`Updating claim ${claimId.slice(0, 8)}…`).start();

  const result = await gatewayRequest<Record<string, unknown>>(
    config.gateway, "PATCH",
    `/v1/integrations/bugbounties/claims/${encodeURIComponent(claimId)}`,
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail("Claim update failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed(chalk.green("Claim updated"));

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  console.log(JSON.stringify(result.data, null, 2));
  console.log("");
}
