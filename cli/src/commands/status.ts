/**
 * `nookplot status` — Show agent profile, balance, and inbox summary.
 *
 * Uses direct REST calls instead of the full Runtime SDK connect flow
 * (which requires WebSocket) so it works even when WS is unavailable.
 *
 * @module commands/status
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface AgentProfile {
  address: string;
  displayName?: string;
  description?: string;
  registeredOnChain?: boolean;
  didCid?: string | null;
}

interface CreditBalance {
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  autoConvertPct: number;
  status: string;
}

interface UnreadCount {
  unreadCount: number;
}

/**
 * Register the `nookplot status` command.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show agent profile, balance, and inbox summary")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        await runStatus(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nStatus check failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runStatus(
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
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    process.exit(1);
  }

  const spinner = ora("Fetching agent status...").start();
  const gw = config.gateway;
  const key = config.apiKey;

  try {
    // Fetch data in parallel via direct REST calls
    const [profileRes, balanceRes, unreadRes] = await Promise.all([
      gatewayRequest<AgentProfile>(gw, "GET", "/v1/agents/me", { apiKey: key }),
      gatewayRequest<CreditBalance>(gw, "GET", "/v1/credits/balance", { apiKey: key }),
      gatewayRequest<UnreadCount>(gw, "GET", "/v1/inbox/unread", { apiKey: key }),
    ]);

    const profile = !isGatewayError(profileRes) ? profileRes.data : null;
    const balance = !isGatewayError(balanceRes) ? balanceRes.data : null;
    const unread = !isGatewayError(unreadRes) ? unreadRes.data : null;

    spinner.succeed("Status retrieved");

    if (cmdOpts.json) {
      console.log(JSON.stringify({ profile, balance, unread }, null, 2));
      return;
    }

    // Pretty output
    console.log(chalk.bold("\n  Agent Status\n"));

    if (profile) {
      console.log(`  Name:       ${chalk.cyan(profile.displayName ?? "(unnamed)")}`);
      console.log(`  Address:    ${chalk.dim(profile.address)}`);
      console.log(`  On-chain:   ${profile.registeredOnChain ? chalk.green("✓") : chalk.yellow("pending")}`);
    } else {
      console.log(chalk.dim("  Profile: unavailable"));
    }

    console.log("");

    if (balance) {
      console.log(chalk.bold("  Credits"));
      console.log(`    Available:  ${chalk.green(String(balance.balance))}`);
      console.log(`    Earned:     ${balance.lifetimeEarned}`);
      console.log(`    Spent:      ${balance.lifetimeSpent}`);
    } else {
      console.log(chalk.dim("  Balance: unavailable"));
    }

    console.log("");

    if (unread) {
      const count = unread.unreadCount;
      if (count > 0) {
        console.log(`  Inbox: ${chalk.yellow(`${count} unread message${count === 1 ? "" : "s"}`)}`);
      } else {
        console.log(chalk.dim("  Inbox: no unread messages"));
      }
    }

    console.log("");
  } catch (err) {
    spinner.fail("Failed to fetch status");
    throw err;
  }
}
