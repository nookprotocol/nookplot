/**
 * `nookplot rotate-key` — Rotate the agent's API key.
 *
 * Calls POST /v1/agents/me/rotate-key, then updates the local .env file
 * with the new key so subsequent CLI commands work immediately.
 *
 * @module commands/rotateKey
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

interface RotateKeyResult {
  apiKey: string;
  prefix: string;
  createdAt: string;
  message: string;
}

export function registerRotateKeyCommand(program: Command): void {
  program
    .command("rotate-key")
    .description("Rotate your agent's API key (invalidates the current key)")
    .option("--gateway <url>", "Gateway URL override")
    .option("--api-key <key>", "Current API key override")
    .action(async (opts) => {
      try {
        await runRotateKey(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nKey rotation failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runRotateKey(opts: {
  gateway?: string;
  apiKey?: string;
}): Promise<void> {
  const config = loadConfig({
    gatewayOverride: opts.gateway,
    apiKeyOverride: opts.apiKey,
  });

  console.log(chalk.bold("\n  API Key Rotation\n"));

  const spinner = ora("Rotating API key...").start();

  const result = await gatewayRequest<RotateKeyResult>(
    config.gateway,
    "POST",
    "/v1/agents/me/rotate-key",
    { apiKey: config.apiKey },
  );

  if (isGatewayError(result)) {
    spinner.fail("Rotation failed");
    console.error(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("API key rotated");

  // Update .env with new key
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    let content = readFileSync(envPath, "utf-8");
    const regex = /^NOOKPLOT_API_KEY=.*/m;
    if (regex.test(content)) {
      content = content.replace(regex, `NOOKPLOT_API_KEY=${result.data.apiKey}`);
      writeFileSync(envPath, content, "utf-8");
      console.log(chalk.green("  .env updated with new key"));
    } else {
      console.log(chalk.yellow("  NOOKPLOT_API_KEY not found in .env — update manually"));
    }
  } else {
    console.log(chalk.yellow("  No .env file found — save the key manually"));
  }

  // Display masked key
  const masked = `nk_${"*".repeat(20)}...${result.data.apiKey.slice(-4)}`;
  console.log("");
  console.log(`  New key:    ${chalk.cyan(masked)}`);
  console.log(`  Prefix:     ${chalk.dim(result.data.prefix)}`);
  console.log(`  Created:    ${result.data.createdAt}`);
  console.log("");
  console.log(chalk.bold.yellow("  The old key is now invalid."));
  console.log("");
}
