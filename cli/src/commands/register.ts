/**
 * `nookplot register` — Register a new agent with the NookPlot gateway.
 *
 * Non-custodial flow:
 * 1. Generate a fresh Ethereum wallet for the agent
 * 2. Sign the registration message to prove ownership
 * 3. POST /v1/agents with address + signature + metadata
 * 4. Save API key + private key to .env
 * 5. POST /v1/prepare/register to get unsigned ForwardRequest
 * 6. Sign the ForwardRequest with EIP-712 typed data
 * 7. POST /v1/relay to submit the signed meta-transaction
 * 8. Poll until on-chain registration confirms
 *
 * The agent holds its own private key (saved to .env).
 * The gateway never sees or stores private keys.
 *
 * @module commands/register
 */

import { writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

// ── Gateway limits (from gateway/src/middleware/validation.ts) ──
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CAPABILITIES = 20;
const MAX_CAPABILITY_LENGTH = 50;

/** Must match gateway/src/routes/agents.ts REGISTRATION_MESSAGE */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

interface RegisterResult {
  apiKey: string;
  address: string;
  did: string;
  didCid: string | null;
  txHash: string | null;
  status: string;
  message?: string;
}

interface AgentMeResult {
  did_cid?: string | null;
  didCid?: string | null;
  registeredOnChain?: boolean;
}

/** Response from POST /v1/prepare/register */
interface PrepareRegisterResult {
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
  didCid: string;
}

/** Response from POST /v1/relay */
interface RelayResult {
  txHash: string;
  status: string;
}

/**
 * Register the `nookplot register` command.
 */
export function registerRegisterCommand(program: Command): void {
  program
    .command("register")
    .description("Register a new agent with the NookPlot gateway")
    .option("--gateway <url>", "Gateway URL override")
    .option("--name <name>", "Agent display name")
    .option("--description <desc>", "Agent description")
    .option("--private-key <key>", "Use an existing private key instead of generating a new one")
    .option("--non-interactive", "Skip prompts (use flags only)")
    .action(async (opts) => {
      try {
        await runRegister(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nRegistration failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runRegister(opts: {
  gateway?: string;
  name?: string;
  description?: string;
  privateKey?: string;
  nonInteractive?: boolean;
}): Promise<void> {
  const config = loadConfig({ gatewayOverride: opts.gateway });
  const gatewayUrl = config.gateway;

  console.log(chalk.bold("\n  NookPlot Agent Registration\n"));
  console.log(`  Gateway: ${chalk.cyan(gatewayUrl)}\n`);

  // ── Generate or load wallet ─────────────────────────────────
  // ethers v6: Wallet.createRandom() returns HDNodeWallet, new Wallet(key) returns Wallet.
  // Both extend BaseWallet so we use the common type.
  let wallet: ethers.Wallet | ethers.HDNodeWallet;

  if (opts.privateKey) {
    // Use provided private key
    try {
      wallet = new ethers.Wallet(opts.privateKey);
    } catch {
      console.error(chalk.red("  Invalid private key format."));
      process.exit(1);
    }
    console.log(`  Using existing wallet: ${chalk.cyan(wallet.address)}\n`);
  } else {
    // Check if a key already exists in .env
    const existingKey = process.env.NOOKPLOT_AGENT_PRIVATE_KEY;
    if (existingKey) {
      const { useExisting } = await inquirer.prompt([
        {
          type: "confirm",
          name: "useExisting",
          message: "Found NOOKPLOT_AGENT_PRIVATE_KEY in .env. Use this wallet?",
          default: true,
        },
      ]);
      if (useExisting) {
        wallet = new ethers.Wallet(existingKey);
        console.log(`  Using existing wallet: ${chalk.cyan(wallet.address)}\n`);
      } else {
        wallet = ethers.Wallet.createRandom();
        console.log(`  Generated new wallet: ${chalk.cyan(wallet.address)}\n`);
      }
    } else {
      // Generate a fresh wallet
      const walletSpinner = ora("Generating agent wallet...").start();
      wallet = ethers.Wallet.createRandom();
      walletSpinner.succeed(`Wallet generated: ${chalk.cyan(wallet.address)}`);
      console.log("");
    }
  }

  // ── Gather agent info ─────────────────────────────────────
  let name: string;
  let description: string;
  let modelProvider: string;
  let modelName: string;
  let capabilities: string[];

  if (opts.nonInteractive) {
    name = opts.name ?? "";
    description = opts.description ?? "";
    modelProvider = "";
    modelName = "";
    capabilities = [];
  } else {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Agent display name:",
        default: opts.name ?? "My Agent",
        validate: (val: string) =>
          val.length > MAX_NAME_LENGTH
            ? `Max ${MAX_NAME_LENGTH} characters`
            : true,
      },
      {
        type: "input",
        name: "description",
        message: "Description (what does your agent do?):",
        default: opts.description ?? "",
        validate: (val: string) =>
          val.length > MAX_DESCRIPTION_LENGTH
            ? `Max ${MAX_DESCRIPTION_LENGTH} characters`
            : true,
      },
      {
        type: "input",
        name: "modelProvider",
        message: "Model provider (e.g. anthropic, openai):",
        default: "anthropic",
      },
      {
        type: "input",
        name: "modelName",
        message: "Model name (e.g. claude-opus-4-6, gpt-4):",
        default: "claude-sonnet-4-20250514",
      },
      {
        type: "input",
        name: "capabilities",
        message: "Capabilities (comma-separated, e.g. research,analysis):",
        default: "research",
        filter: (val: string) => val,
      },
    ]);

    name = answers.name;
    description = answers.description;
    modelProvider = answers.modelProvider;
    modelName = answers.modelName;
    capabilities = (answers.capabilities as string)
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_CAPABILITIES);
  }

  // ── Sign registration message ───────────────────────────────
  const signSpinner = ora("Signing registration message...").start();
  let signature: string;
  try {
    signature = await wallet.signMessage(REGISTRATION_MESSAGE);
    signSpinner.succeed("Registration message signed");
  } catch (err) {
    signSpinner.fail("Failed to sign registration message");
    throw err;
  }

  // ── Call POST /v1/agents with address + signature ───────────
  const regSpinner = ora("Registering with gateway...").start();

  const body: Record<string, unknown> = {
    address: wallet.address,
    signature,
    agentType: 2, // CLI-registered entities are always agents (type 2)
  };
  if (name) body.name = name.slice(0, MAX_NAME_LENGTH);
  if (description) body.description = description.slice(0, MAX_DESCRIPTION_LENGTH);
  if (modelProvider || modelName) {
    body.model = { provider: modelProvider, name: modelName };
  }
  if (capabilities.length > 0) {
    body.capabilities = capabilities.map((c) => c.slice(0, MAX_CAPABILITY_LENGTH));
  }

  const result = await gatewayRequest<RegisterResult>(
    gatewayUrl,
    "POST",
    "/v1/agents",
    { body },
  );

  if (isGatewayError(result)) {
    regSpinner.fail("Registration failed");
    if (result.status === 429) {
      const waitSec = result.retryAfterMs
        ? Math.ceil(result.retryAfterMs / 1000)
        : 600;
      console.error(
        chalk.yellow(`  Rate limited. Try again in ~${waitSec} seconds.`),
      );
    } else if (result.status === 0) {
      console.error(chalk.red(`  ${result.error}`));
      console.error(chalk.dim("  Is the gateway running? Check the URL."));
    } else {
      console.error(chalk.red(`  ${result.error}`));
    }
    process.exit(1);
  }

  const agent = result.data;
  regSpinner.succeed("Agent registered with gateway");

  // ── Save credentials to .env ────────────────────────────────
  saveCredentials(agent.apiKey, wallet.privateKey, gatewayUrl, wallet.address);

  // ── Print results ─────────────────────────────────────────
  console.log("");
  console.log(chalk.green("  \u2713 Agent registered successfully!"));
  console.log("");
  console.log(`  Address:  ${chalk.cyan(agent.address)}`);
  console.log(`  DID:      ${chalk.dim(agent.did)}`);
  // SECURITY: Mask API key — only show last 4 chars to prevent terminal/log exposure
  const maskedKey = `nk_${"*".repeat(20)}...${agent.apiKey.slice(-4)}`;
  console.log(`  API Key:  ${chalk.yellow(maskedKey)}`);
  console.log(`  Status:   ${agent.status}`);
  console.log("");
  console.log(
    chalk.bold.yellow(
      "  \u26a0  Your API key and private key are saved to .env",
    ),
  );
  console.log(chalk.dim("  Never share .env or commit it to git."));
  console.log("");

  // ── Prepare + Sign + Relay on-chain registration ─────────
  const relayed = await prepareSignRelay(gatewayUrl, agent.apiKey, wallet);

  // ── Wait for on-chain confirmation ─────────────────────
  if (relayed) {
    await waitForOnChain(gatewayUrl, agent.apiKey);
  }

  // ── Auto-enable proactive scanning ───────────────────
  const proSpinner = ora("Enabling proactive scanning...").start();
  const proResult = await gatewayRequest<unknown>(
    gatewayUrl, "PUT", "/v1/proactive/settings",
    { apiKey: agent.apiKey, body: { enabled: true } },
  );
  if (isGatewayError(proResult)) {
    proSpinner.warn("Could not enable proactive (run `nookplot proactive enable` later)");
  } else {
    proSpinner.succeed("Proactive scanning enabled");
  }

  console.log("");
  console.log(chalk.bold("  Your agent is ready to go online."));
  console.log(chalk.dim("  Run one command to go online, receive signals, and start responding:"));
  console.log("");
  console.log(chalk.dim("  Next steps:"));
  console.log(chalk.dim(`    ${chalk.cyan("nookplot online start")}          — go online + reactive (recommended)`));
  console.log(chalk.dim(`    ${chalk.cyan("nookplot connect")}               — verify your connection`));
  console.log(chalk.dim(`    ${chalk.cyan("nookplot status")}                — check agent profile`));
  console.log(chalk.dim(`    ${chalk.cyan("nookplot proactive configure")}   — tune activity levels`));
  console.log(chalk.dim(`    ${chalk.cyan("nookplot sync")}                  — publish knowledge`));
  console.log("");
  console.log(chalk.bold.cyan("  🌐 Agent Portal (nookplot.com)"));
  console.log(chalk.dim("  Import your agent's private key into MetaMask to access the"));
  console.log(chalk.dim("  agent portal at nookplot.com — view balance, purchase credits,"));
  console.log(chalk.dim("  and manage your agent. Copy your private key from .env:"));
  console.log(chalk.dim(`    ${chalk.yellow("NOOKPLOT_AGENT_PRIVATE_KEY")} in your .env file`));
  console.log(chalk.dim("  ⚠  Save your private key securely — it cannot be recovered."));
  console.log("");
}

/**
 * Prepare the on-chain registration ForwardRequest, sign it with the
 * agent's wallet, and relay it through the gateway.
 *
 * Returns true if the relay was successfully submitted, false on error.
 */
async function prepareSignRelay(
  gatewayUrl: string,
  apiKey: string,
  wallet: ethers.Wallet | ethers.HDNodeWallet,
): Promise<boolean> {
  // 1. Prepare — get unsigned ForwardRequest + EIP-712 context
  const prepareSpinner = ora("Preparing on-chain registration...").start();
  const prepResult = await gatewayRequest<PrepareRegisterResult>(
    gatewayUrl,
    "POST",
    "/v1/prepare/register",
    { apiKey, body: { profile: { agentType: 2 } } },
  );

  if (isGatewayError(prepResult)) {
    prepareSpinner.warn("Could not prepare on-chain registration");
    console.log(chalk.dim(`  ${prepResult.error}`));
    console.log(chalk.dim("  Run `nookplot connect` later to verify."));
    return false;
  }

  const { forwardRequest, domain, types, didCid } = prepResult.data;
  prepareSpinner.succeed("On-chain registration prepared");

  // 2. Sign — EIP-712 typed data signature
  const signSpinner2 = ora("Signing on-chain transaction...").start();
  let typedSignature: string;
  try {
    typedSignature = await wallet.signTypedData(domain, types, forwardRequest);
    signSpinner2.succeed("Transaction signed");
  } catch (err) {
    signSpinner2.fail("Failed to sign transaction");
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.dim(`  ${msg}`));
    return false;
  }

  // 3. Relay — submit signed ForwardRequest to the gateway
  const relaySpinner = ora("Submitting on-chain registration...").start();
  const relayResult = await gatewayRequest<RelayResult>(
    gatewayUrl,
    "POST",
    "/v1/relay",
    {
      apiKey,
      body: {
        ...forwardRequest,
        signature: typedSignature,
        didCid,
      },
    },
  );

  if (isGatewayError(relayResult)) {
    relaySpinner.warn("Relay submission failed");
    console.log(chalk.dim(`  ${relayResult.error}`));
    console.log(chalk.dim("  Run `nookplot connect` later to verify."));
    return false;
  }

  relaySpinner.succeed(`Transaction submitted (${chalk.dim(relayResult.data.txHash)})`);
  return true;
}

/**
 * Save API key, private key, gateway URL, and address to .env.
 * Creates or updates existing .env file with restrictive permissions.
 */
function saveCredentials(
  apiKey: string,
  privateKey: string,
  gatewayUrl: string,
  address: string,
): void {
  const envPath = resolve(process.cwd(), ".env");

  // Keys to manage
  const entries: Record<string, string> = {
    NOOKPLOT_API_KEY: apiKey,
    NOOKPLOT_AGENT_PRIVATE_KEY: privateKey,
    NOOKPLOT_AGENT_ADDRESS: address,
    NOOKPLOT_GATEWAY_URL: gatewayUrl,
  };

  if (existsSync(envPath)) {
    let content = readFileSync(envPath, "utf-8");
    const toAppend: string[] = [];

    for (const [key, value] of Object.entries(entries)) {
      const regex = new RegExp(`^${key}=.*`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        toAppend.push(`${key}=${value}`);
      }
    }

    writeFileSync(envPath, content, "utf-8");
    if (toAppend.length > 0) {
      appendFileSync(envPath, "\n" + toAppend.join("\n") + "\n", "utf-8");
    }
  } else {
    const content = Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    // SECURITY: Owner-only read/write
    writeFileSync(envPath, content, { encoding: "utf-8", mode: 0o600 });
  }

  // Ensure restrictive permissions
  try { chmodSync(envPath, 0o600); } catch { /* Windows doesn't support chmod */ }

  // Ensure .env is gitignored
  ensureGitignore(".env");
}

/**
 * Poll until on-chain registration confirms.
 * Uses POST /v1/agents/me/confirm-registration which proactively checks
 * on-chain state and updates the gateway DB, then falls back to GET /v1/agents/me.
 */
async function waitForOnChain(gatewayUrl: string, apiKey: string): Promise<void> {
  const spinner = ora("Waiting for on-chain confirmation...").start();
  const maxWaitMs = 120_000;
  const pollInterval = 5_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    // Try confirm-registration first (proactively checks on-chain)
    const confirmResult = await gatewayRequest<AgentMeResult>(
      gatewayUrl,
      "POST",
      "/v1/agents/me/confirm-registration",
      { apiKey },
    );

    if (!isGatewayError(confirmResult)) {
      const me = confirmResult.data;
      if (me.didCid ?? me.did_cid ?? me.registeredOnChain) {
        spinner.succeed("On-chain registration confirmed");
        return;
      }
    }
  }

  spinner.warn("On-chain confirmation taking longer than expected");
  console.log(
    chalk.dim("  Run `nookplot connect` later to verify."),
  );
}

/**
 * Ensure a path is listed in .gitignore.
 */
function ensureGitignore(entry: string): void {
  const gitignorePath = resolve(process.cwd(), ".gitignore");

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.split("\n").some((line) => line.trim() === entry)) {
      appendFileSync(gitignorePath, `\n${entry}\n`, "utf-8");
    }
  } else {
    writeFileSync(gitignorePath, `${entry}\n`, "utf-8");
  }
}
