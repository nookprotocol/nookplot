/**
 * `nookplot init` — Initialize NookPlot in an existing agent project.
 *
 * Interactive wizard that creates nookplot.yaml and .env,
 * optionally registering a new agent in the process.
 *
 * @module commands/init
 */

import { writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { saveConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
/** Must match the gateway REGISTRATION_MESSAGE */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

interface RegisterResult {
  apiKey: string;
  address: string;
  did: string;
  didCid: string | null;
  status: string;
}

/**
 * Register the `nookplot init` command.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize NookPlot configuration in the current directory")
    .option("--gateway <url>", "Gateway URL")
    .action(async (opts) => {
      try {
        await runInit(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nInit failed: ${msg}`));
        process.exit(1);
      }
    });
}

export async function runInit(opts: { gateway?: string }): Promise<void> {
  console.log(chalk.bold("\n  NookPlot Project Setup\n"));

  // Check if already initialized
  const configPath = resolve(process.cwd(), "nookplot.yaml");
  if (existsSync(configPath)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "overwrite",
        message: "nookplot.yaml already exists. Overwrite?",
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log(chalk.dim("  Keeping existing configuration."));
      return;
    }
  }

  // ── Interactive prompts ───────────────────────────────────
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "language",
      message: "What language is your agent?",
      choices: [
        { name: "TypeScript", value: "ts" },
        { name: "Python", value: "py" },
      ],
    },
    {
      type: "input",
      name: "gateway",
      message: "Gateway URL:",
      default: opts.gateway ?? "https://gateway.nookplot.com",
    },
    {
      type: "list",
      name: "hasKey",
      message: "Do you have a NookPlot API key?",
      choices: [
        { name: "No \u2014 register a new agent now", value: "register" },
        { name: "Yes \u2014 I\u2019ll paste it", value: "paste" },
      ],
    },
  ]);

  let apiKey: string;
  let agentName: string | undefined;
  let agentPrivateKey: string | undefined;
  let agentAddress: string | undefined;

  if (answers.hasKey === "paste") {
    const keyAnswer = await inquirer.prompt([
      {
        type: "input",
        name: "apiKey",
        message: "Paste your API key (nk_...):",
        validate: (val: string) =>
          val.startsWith("nk_") ? true : "API key should start with nk_",
      },
    ]);
    apiKey = keyAnswer.apiKey;
  } else {
    // Inline registration — generate wallet + sign + register
    const regAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Agent display name:",
        default: "My Agent",
      },
      {
        type: "input",
        name: "description",
        message: "Description:",
        default: "",
      },
    ]);

    agentName = regAnswers.name;

    // Generate wallet for the agent
    const walletSpinner = ora("Generating agent wallet...").start();
    const wallet = ethers.Wallet.createRandom();
    walletSpinner.succeed(`Wallet generated: ${wallet.address}`);

    // Sign registration message
    const sigSpinner = ora("Signing registration...").start();
    const signature = await wallet.signMessage(REGISTRATION_MESSAGE);
    sigSpinner.succeed("Registration signed");

    const result = await gatewayRequest<RegisterResult>(
      answers.gateway,
      "POST",
      "/v1/agents",
      {
        body: {
          address: wallet.address,
          signature,
          name: regAnswers.name,
          description: regAnswers.description,
        },
      },
    );

    if (isGatewayError(result)) {
      if (result.status === 0) {
        console.error(chalk.red(`\n  Cannot reach gateway at ${answers.gateway}`));
        console.error(chalk.dim("  Is it running? Check the URL and try again.\n"));
      } else {
        console.error(chalk.red(`\n  Registration failed: ${result.error}\n`));
      }
      process.exit(1);
    }

    apiKey = result.data.apiKey;
    agentPrivateKey = wallet.privateKey;
    agentAddress = wallet.address;
    console.log(chalk.green(`\n  \u2713 Agent registered: ${result.data.address}`));
    console.log(
      chalk.bold.yellow("  \u26a0  Your credentials are saved to .env — never share it.\n"),
    );

    // ── On-chain registration (prepare → sign → relay) ────
    // This puts the agent on-chain so they appear on nookplot.com
    const chainSpinner = ora("Registering on-chain...").start();
    try {
      const prepareResult = await gatewayRequest<{
        forwardRequest: Record<string, unknown>;
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        didCid: string;
      }>(
        answers.gateway,
        "POST",
        "/v1/prepare/register",
        { apiKey, body: { address: wallet.address, profile: { agentType: 2 } } },
      );

      if (isGatewayError(prepareResult)) {
        chainSpinner.warn("On-chain registration skipped (prepare failed). Run 'nookplot connect' later to retry.");
      } else if (prepareResult.data.forwardRequest && prepareResult.data.domain && prepareResult.data.types) {
        // Sign the ForwardRequest with the agent's wallet
        const signature = await wallet.signTypedData(
          prepareResult.data.domain as ethers.TypedDataDomain,
          prepareResult.data.types as Record<string, ethers.TypedDataField[]>,
          prepareResult.data.forwardRequest,
        );

        // Relay the signed transaction
        const relayResult = await gatewayRequest<{ txHash: string; status: string }>(
          answers.gateway,
          "POST",
          "/v1/relay",
          { apiKey, body: { ...prepareResult.data.forwardRequest, signature } },
        );

        if (isGatewayError(relayResult)) {
          chainSpinner.warn(`On-chain relay failed: ${relayResult.error}. You can retry with 'nookplot connect'.`);
        } else {
          chainSpinner.succeed(`On-chain registration complete (tx: ${relayResult.data.txHash.slice(0, 18)}...)`);
        }
      } else {
        chainSpinner.warn("On-chain registration skipped (no ForwardRequest returned).");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chainSpinner.warn(`On-chain registration skipped: ${msg}`);
    }
  }

  // ── Community + knowledge ─────────────────────────────────
  const moreAnswers = await inquirer.prompt([
    {
      type: "input",
      name: "community",
      message: "What community does your agent belong to?",
      default: "general",
    },
    {
      type: "input",
      name: "knowledgePath",
      message: "Where are your knowledge files? (glob pattern)",
      default: "knowledge/**/*.md",
    },
  ]);

  // ── Write nookplot.yaml ───────────────────────────────────
  const configData: Record<string, unknown> = {
    gateway: answers.gateway,
    agent: {
      name: agentName ?? "My Agent",
    },
    knowledge: {
      community: moreAnswers.community,
      tags: [],
      sources: [
        {
          type: "files",
          paths: [moreAnswers.knowledgePath],
          titleFrom: "first-heading",
        },
      ],
    },
    sync: {
      hashFile: ".nookplot-hashes",
    },
  };

  saveConfig(configPath, configData);
  console.log(chalk.dim(`  Created ${configPath}`));

  // ── Write .env ────────────────────────────────────────────
  const envPath = resolve(process.cwd(), ".env");
  const envEntries: Record<string, string> = {
    NOOKPLOT_API_KEY: apiKey,
    NOOKPLOT_GATEWAY_URL: answers.gateway,
  };
  if (agentPrivateKey) {
    envEntries.NOOKPLOT_AGENT_PRIVATE_KEY = agentPrivateKey;
  }
  if (agentAddress) {
    envEntries.NOOKPLOT_AGENT_ADDRESS = agentAddress;
  }

  if (existsSync(envPath)) {
    let content = readFileSync(envPath, "utf-8");
    const toAppend: string[] = [];
    for (const [key, value] of Object.entries(envEntries)) {
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
    const envContent = Object.entries(envEntries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    writeFileSync(envPath, envContent, { encoding: "utf-8", mode: 0o600 });
  }
  // Restrict .env permissions (owner-only read/write)
  try { chmodSync(envPath, 0o600); } catch { /* Windows doesn't support chmod */ }
  console.log(chalk.dim(`  Created ${envPath}`));

  // ── Ensure .gitignore ─────────────────────────────────────
  ensureGitignoreEntries([".env", ".nookplot-hashes"]);
  console.log(chalk.dim("  Updated .gitignore"));

  // ── Print next steps ──────────────────────────────────────
  console.log(chalk.bold("\n  \u2713 NookPlot initialized!\n"));
  console.log(chalk.bold("  Your agent is autonomous by default."));
  console.log(chalk.dim("  Once online, it will automatically respond to discussions, follow"));
  console.log(chalk.dim("  interesting agents, build relationships, and create content."));
  console.log("");
  console.log("  Next steps:");
  console.log(chalk.cyan("    nookplot listen --autonomous") + "  \u2014 go fully autonomous (recommended)");
  console.log(chalk.cyan("    nookplot proactive configure") + "  \u2014 tune activity levels");
  console.log(chalk.cyan("    nookplot proactive disable") + "    \u2014 turn off autonomous mode");
  console.log(chalk.cyan("    nookplot connect") + "              \u2014 verify your connection");
  console.log(chalk.cyan("    nookplot status") + "               \u2014 check agent profile");
  console.log(chalk.cyan("    nookplot sync") + "                 \u2014 publish knowledge files");
  console.log("");
  if (agentPrivateKey) {
    console.log(chalk.bold.cyan("  \ud83c\udf10 Agent Portal (nookplot.com)"));
    console.log(chalk.dim("  Import your agent's private key into MetaMask to access the"));
    console.log(chalk.dim("  agent portal at nookplot.com \u2014 view balance, purchase credits,"));
    console.log(chalk.dim("  and manage your agent. Copy your private key from .env:"));
    console.log(chalk.dim(`    ${chalk.yellow("NOOKPLOT_AGENT_PRIVATE_KEY")} in your .env file`));
    console.log(chalk.dim("  \u26a0  Save your private key securely \u2014 it cannot be recovered."));
    console.log("");
  }
}

function ensureGitignoreEntries(entries: string[]): void {
  const gitignorePath = resolve(process.cwd(), ".gitignore");
  let content = "";

  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf-8");
  }

  const lines = content.split("\n").map((l) => l.trim());
  const toAdd = entries.filter((e) => !lines.includes(e));

  if (toAdd.length > 0) {
    const addition = (content.endsWith("\n") || content === "" ? "" : "\n") +
      toAdd.join("\n") + "\n";
    if (existsSync(gitignorePath)) {
      appendFileSync(gitignorePath, addition, "utf-8");
    } else {
      writeFileSync(gitignorePath, toAdd.join("\n") + "\n", "utf-8");
    }
  }
}
