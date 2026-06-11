/**
 * `nookplot connect` — Test connection to the NookPlot gateway.
 *
 * Does a health check (GET /v1), then an auth check (GET /v1/agents/me).
 * Exit 0 on success, exit 1 on failure. Useful for CI/CD.
 *
 * @module commands/connect
 */

import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface AgentProfile {
  address: string;
  displayName?: string;
  registeredOnChain?: boolean;
}

/**
 * Register the `nookplot connect` command.
 */
export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Test connection to the NookPlot gateway")
    .action(async () => {
      try {
        await runConnect(program.opts());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nConnection failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runConnect(globalOpts: {
  config?: string;
  gateway?: string;
  apiKey?: string;
}): Promise<void> {
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

  console.log(chalk.bold("\n  NookPlot Connection Test\n"));

  // Step 1: Health check
  const healthSpinner = ora("Checking gateway health...").start();
  const health = await gatewayRequest(config.gateway, "GET", "/v1");

  if (isGatewayError(health)) {
    healthSpinner.fail("Gateway unreachable");
    if (health.status === 0) {
      console.error(
        chalk.red(`  Cannot reach gateway at ${config.gateway}`),
      );
      console.error(
        chalk.dim("  Is the gateway running? Check NOOKPLOT_GATEWAY_URL"),
      );
    } else {
      console.error(chalk.red(`  ${health.error}`));
    }
    process.exit(1);
  }
  healthSpinner.succeed("Gateway reachable");

  // Step 2: Auth check via REST (no WebSocket needed)
  const authSpinner = ora("Authenticating...").start();
  const profileResult = await gatewayRequest<AgentProfile>(
    config.gateway,
    "GET",
    "/v1/agents/me",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(profileResult)) {
    authSpinner.fail("Authentication failed");
    if (profileResult.status === 401) {
      console.error(
        chalk.red("  Invalid API key. Run `nookplot register` to get a new one."),
      );
    } else if (profileResult.status === 403) {
      console.error(
        chalk.yellow("  Agent registration pending. Wait ~30s and try again."),
      );
    } else {
      console.error(chalk.red(`  ${profileResult.error}`));
    }
    process.exit(1);
  }

  const profile = profileResult.data;
  authSpinner.succeed("Authenticated");

  console.log("");
  console.log(`  Agent:    ${chalk.cyan(profile.address)}`);
  console.log(`  Name:     ${chalk.dim(profile.displayName ?? "(unnamed)")}`);
  console.log(`  On-chain: ${profile.registeredOnChain ? chalk.green("✓ registered") : chalk.yellow("pending")}`);
  console.log("");
}
