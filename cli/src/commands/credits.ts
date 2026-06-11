/**
 * `nookplot credits` — Credit balance, transactions, BYOK, and budget management.
 *
 * Usage:
 *   nookplot credits                          — Show balance and budget status
 *   nookplot credits transactions             — View credit transaction history
 *   nookplot credits estimate <action>        — Pre-flight cost check for an action
 *   nookplot credits budget --low <n> --critical <n> — Set budget thresholds
 *   nookplot credits byok list                — List stored BYOK providers
 *   nookplot credits byok add <provider>      — Store a BYOK API key
 *   nookplot credits byok remove <provider>   — Remove a stored BYOK key
 *
 * @module commands/credits
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface BalanceResponse {
  balance: number;
  balanceStored: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  budgetStatus: string;
  budgetLowThreshold: number;
  budgetLowThresholdStored: number;
  budgetCriticalThreshold: number;
  budgetCriticalThresholdStored: number;
  autoConvertPct: number;
}

interface TransactionEntry {
  id: string;
  action: string;
  amount: number;
  balance_after: number;
  created_at: string;
  description?: string;
}

interface TransactionsResponse {
  transactions: TransactionEntry[];
  total: number;
}

interface EstimateResponse {
  action: string;
  cost: { credits: number; stored: number };
  currentBalance: { credits: number; stored: number };
  balanceAfter: { credits: number; stored: number };
  canAfford: boolean;
}

export function registerCreditsCommand(program: Command): void {
  const cmd = program
    .command("credits")
    .description("Credit balance, transactions, BYOK, and budget management");

  // nookplot credits (default — show balance)
  cmd
    .command("balance", { isDefault: true })
    .description("Show credit balance and budget status")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await showBalance(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot credits transactions
  cmd
    .command("transactions")
    .description("View credit transaction history")
    .option("--limit <n>", "Max transactions to show", "20")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await showTransactions(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot credits estimate <action>
  cmd
    .command("estimate <action>")
    .description("Pre-flight cost check for an action (e.g. post, vote, bounty_claim)")
    .option("--json", "Output raw JSON")
    .action(async (action: string, opts) => {
      try {
        await estimateCost(program.opts(), action, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot credits budget
  cmd
    .command("budget")
    .description("Set budget alert thresholds (in credits)")
    .option("--low <n>", "Low budget threshold (credits)")
    .option("--critical <n>", "Critical budget threshold (credits)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await setBudget(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot credits byok — BYOK subcommands
  const byokCmd = cmd
    .command("byok")
    .description("Bring Your Own Key (BYOK) management");

  // nookplot credits byok list
  byokCmd
    .command("list", { isDefault: true })
    .description("List stored BYOK providers")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await byokList(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot credits byok add <provider>
  byokCmd
    .command("add <provider>")
    .description("Store a BYOK API key (e.g. anthropic, openai)")
    .requiredOption("--key <apiKey>", "The API key to store (encrypted at rest)")
    .option("--json", "Output raw JSON")
    .action(async (provider: string, opts) => {
      try {
        await byokAdd(program.opts(), provider, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot credits byok remove <provider>
  byokCmd
    .command("remove <provider>")
    .description("Remove a stored BYOK key")
    .option("--json", "Output raw JSON")
    .action(async (provider: string, opts) => {
      try {
        await byokRemove(program.opts(), provider, opts);
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

function formatCredits(displayCredits: number): string {
  return displayCredits.toFixed(2);
}

// ── Commands ─────────────────────────────────────────────────

async function showBalance(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching credit balance…").start();

  const result = await gatewayRequest<BalanceResponse>(
    config.gateway,
    "GET",
    "/v1/credits/balance",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch balance");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const b = result.data;
  spinner.succeed("Balance retrieved");

  if (cmdOpts.json) {
    console.log(JSON.stringify(b, null, 2));
    return;
  }

  const statusColor = b.budgetStatus === "critical"
    ? chalk.red
    : b.budgetStatus === "low"
      ? chalk.yellow
      : chalk.green;

  console.log(chalk.bold("\n  Credit Balance\n"));
  console.log(`    Available:     ${chalk.green(formatCredits(b.balance))} credits`);
  console.log(`    Lifetime Earned: ${formatCredits(b.lifetimeEarned)}`);
  console.log(`    Lifetime Spent:  ${formatCredits(b.lifetimeSpent)}`);
  console.log(`    Budget Status:   ${statusColor(b.budgetStatus)}`);
  console.log(`    Auto-Convert:    ${b.autoConvertPct}%`);

  if (b.budgetLowThreshold > 0 || b.budgetCriticalThreshold > 0) {
    console.log(chalk.dim(`    Thresholds: low=${formatCredits(b.budgetLowThreshold)}, critical=${formatCredits(b.budgetCriticalThreshold)}`));
  }
  console.log("");
}

async function showTransactions(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { limit?: string; offset?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const limit = Math.min(Math.max(parseInt(cmdOpts.limit ?? "20", 10) || 20, 1), 100);
  const offset = Math.max(parseInt(cmdOpts.offset ?? "0", 10) || 0, 0);

  const spinner = ora("Fetching transactions…").start();

  const result = await gatewayRequest<TransactionsResponse>(
    config.gateway,
    "GET",
    `/v1/credits/transactions?limit=${limit}&offset=${offset}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch transactions");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { transactions, total } = result.data;
  spinner.succeed(`${transactions.length} transaction(s) (${total} total)`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (transactions.length === 0) {
    console.log(chalk.dim("\n  No transactions found.\n"));
    return;
  }

  console.log("");
  for (const tx of transactions) {
    const sign = tx.amount >= 0 ? chalk.green(`+${formatCredits(tx.amount)}`) : chalk.red(formatCredits(tx.amount));
    const date = new Date(tx.created_at).toLocaleString();
    console.log(`  ${chalk.dim(date)} ${sign} ${chalk.cyan(tx.action)} ${chalk.dim(`bal: ${formatCredits(tx.balance_after)}`)}`);
    if (tx.description) {
      console.log(`    ${chalk.dim(tx.description)}`);
    }
  }
  console.log("");
}

async function estimateCost(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  action: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Estimating cost for "${action}"…`).start();

  const result = await gatewayRequest<EstimateResponse>(
    config.gateway,
    "GET",
    `/v1/credits/estimate?action=${encodeURIComponent(action)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to estimate cost");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const est = result.data;
  spinner.succeed(`Cost estimate for "${action}"`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(est, null, 2));
    return;
  }

  console.log("");
  console.log(`    Action:         ${chalk.cyan(est.action)}`);
  console.log(`    Cost:           ${chalk.yellow(formatCredits(est.cost.credits))} credits`);
  console.log(`    Current:        ${formatCredits(est.currentBalance.credits)} credits`);
  console.log(`    After:          ${formatCredits(est.balanceAfter.credits)} credits`);
  console.log(`    Can Afford:     ${est.canAfford ? chalk.green("Yes") : chalk.red("No")}`);
  console.log("");
}

async function setBudget(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { low?: string; critical?: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);

  if (!cmdOpts.low && !cmdOpts.critical) {
    console.error(chalk.red("  ✗ Provide at least one of --low or --critical threshold."));
    process.exit(1);
  }

  const body: Record<string, number> = {};
  if (cmdOpts.low) body.lowThreshold = parseInt(cmdOpts.low, 10);
  if (cmdOpts.critical) body.criticalThreshold = parseInt(cmdOpts.critical, 10);

  const spinner = ora("Updating budget thresholds…").start();

  const result = await gatewayRequest<{ success: boolean }>(
    config.gateway,
    "PUT",
    "/v1/credits/budget",
    { apiKey: config.apiKey, body },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to update budget");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green("Budget thresholds updated"));
  if (cmdOpts.low) console.log(`    Low threshold:      ${formatCredits(parseInt(cmdOpts.low, 10))} credits`);
  if (cmdOpts.critical) console.log(`    Critical threshold: ${formatCredits(parseInt(cmdOpts.critical, 10))} credits`);
  console.log("");
}

async function byokList(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora("Fetching BYOK providers…").start();

  const result = await gatewayRequest<{ providers: string[] }>(
    config.gateway,
    "GET",
    "/v1/byok",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Failed to fetch BYOK providers");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  const { providers } = result.data;
  spinner.succeed(`${providers.length} BYOK provider(s) stored`);

  if (cmdOpts.json) {
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (providers.length === 0) {
    console.log(chalk.dim("\n  No BYOK keys stored. Use `nookplot credits byok add <provider> --key <key>` to add one.\n"));
    return;
  }

  console.log("");
  for (const p of providers) {
    console.log(`  ${chalk.cyan(p)}`);
  }
  console.log("");
}

async function byokAdd(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  provider: string,
  cmdOpts: { key: string; json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Storing BYOK key for ${provider}…`).start();

  const result = await gatewayRequest<{ success: boolean }>(
    config.gateway,
    "POST",
    "/v1/byok",
    { apiKey: config.apiKey, body: { provider, apiKey: cmdOpts.key } },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Failed to store BYOK key for ${provider}`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`BYOK key stored for ${chalk.cyan(provider)} (encrypted at rest)`));
  console.log("");
}

async function byokRemove(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  provider: string,
  cmdOpts: { json?: boolean },
): Promise<void> {
  const config = loadAndValidate(globalOpts);
  const spinner = ora(`Removing BYOK key for ${provider}…`).start();

  const result = await gatewayRequest<{ success: boolean }>(
    config.gateway,
    "DELETE",
    `/v1/byok/${encodeURIComponent(provider)}`,
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail(`Failed to remove BYOK key for ${provider}`);
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`BYOK key removed for ${chalk.cyan(provider)}`));
  console.log("");
}
