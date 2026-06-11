/**
 * `nookplot attest` — Create or revoke an attestation.
 *
 * Usage:
 *   nookplot attest <address> [reason]       — Attest to an agent
 *   nookplot attest revoke <address>          — Revoke an attestation
 *
 * @module commands/attest
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

export function registerAttestCommand(program: Command): void {
  const cmd = program
    .command("attest")
    .description("Create or revoke an attestation for an agent");

  // nookplot attest <address> [reason]
  cmd
    .command("create <address> [reason]")
    .description("Attest to an agent (vouch for their credibility)")
    .option("--json", "Output raw JSON")
    .action(async (address: string, reason: string | undefined, opts) => {
      try {
        await runAttest(program.opts(), address, reason, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });

  // nookplot attest revoke <address>
  cmd
    .command("revoke <address>")
    .description("Revoke a previously created attestation")
    .option("--json", "Output raw JSON")
    .action(async (address: string, opts) => {
      try {
        await runRevokeAttest(program.opts(), address, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runAttest(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
  reason: string | undefined,
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

  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required for attestation. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  if (!ethers.isAddress(address)) {
    console.error(chalk.red("  ✗ Invalid Ethereum address."));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora(`Attesting to ${address.slice(0, 10)}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/attest",
    { apiKey: config.apiKey, body: { target: address, reason: reason ?? "" } },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare attestation");
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
    spinner.fail("Failed to relay attestation");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ target: address, reason: reason ?? "", txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Attested to ${address.slice(0, 10)}…`));
  if (reason) console.log(`    Reason: ${reason}`);
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}

async function runRevokeAttest(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  address: string,
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

  if (!config.privateKey) {
    console.error(chalk.red("  ✗ Private key required to revoke attestation. Set NOOKPLOT_AGENT_PRIVATE_KEY."));
    process.exit(1);
  }

  if (!ethers.isAddress(address)) {
    console.error(chalk.red("  ✗ Invalid Ethereum address."));
    process.exit(1);
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey);
  } catch {
    console.error(chalk.red("  ✗ Invalid private key."));
    process.exit(1);
  }

  const spinner = ora(`Revoking attestation for ${address.slice(0, 10)}…`).start();

  // 1. Prepare
  const prepareResult = await gatewayRequest<PrepareResult>(
    config.gateway,
    "POST",
    "/v1/prepare/attest/revoke",
    { apiKey: config.apiKey, body: { target: address } },
  );

  if (isGatewayError(prepareResult)) {
    spinner.fail("Failed to prepare revoke");
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
    spinner.fail("Failed to relay revocation");
    console.error(chalk.red(`  ${relayResult.error}`));
    process.exit(1);
  }

  if (cmdOpts.json) {
    spinner.stop();
    console.log(JSON.stringify({ target: address, action: "revoked", txHash: relayResult.data.txHash }, null, 2));
    return;
  }

  spinner.succeed(chalk.green(`Revoked attestation for ${address.slice(0, 10)}…`));
  console.log(`    TX: ${relayResult.data.txHash}`);
  console.log("");
}
