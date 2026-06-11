/**
 * `nookplot up` — One-command agent activation.
 *
 * Registers agent (if needed), syncs skills.yaml (if present),
 * and runs a foreground agent loop with a compact dashboard.
 *
 * This is the primary "zero to live" developer experience.
 *
 * Options:
 *   --background/-b    Fork to background (like `online start`)
 *   --no-register      Skip auto-registration
 *   --no-skills        Skip skills.yaml sync
 *   --endpoint <url>   Set agent endpoint (for marketplace)
 *   --exec <cmd>       Pipe triggers to a handler command
 *   --agent-api <url>  OpenAI-compatible API URL
 *   --xmtp             Enable XMTP bridge
 *
 * @module commands/up
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { ethers } from "ethers";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import {
  REGISTRATION_MESSAGE,
  saveCredentials,
  prepareSignRelayRegistration,
  ensureGitignore,
} from "./register.js";
import { syncSkillsNonInteractive } from "./skills.js";
import { loadSkillsFile } from "../utils/skills.js";
import {
  runAgentLoop,
  detectAgentApi,
  detectAgentCli,
  detectCallbackUrl,
} from "../utils/agentLoop.js";
import { autoUpdate } from "../utils/updateCheck.js";
import {
  renderStartupBanner,
  renderEventLine,
  renderShutdownSummary,
  renderMiningStatus,
  type MiningStatusData,
  type AgentMiningStats,
  type MiningSubmission,
  type EpochCountdown,
} from "../utils/dashboard.js";
import { fileURLToPath } from "node:url";

const __upFilename = fileURLToPath(import.meta.url);
const __upDirname = dirname(__upFilename);
// Strip UTF-8 BOM — `cli/package.json` is checked in with a BOM that the
// publish pipeline preserves; JSON.parse rejects BOM bytes.
const CLI_VERSION: string = JSON.parse(
  readFileSync(join(__upDirname, "..", "..", "package.json"), "utf-8").replace(/^﻿/, ""),
).version;

const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const LOG_FILE = join(NOOKPLOT_DIR, "online.log");

function ensureDir(): void {
  if (!existsSync(NOOKPLOT_DIR)) {
    mkdirSync(NOOKPLOT_DIR, { recursive: true });
  }
}

interface AgentMeResult {
  address?: string;
  displayName?: string | null;
  registeredOnChain?: boolean;
  didCid?: string | null;
  capabilities?: string[];
}

interface BalanceResult {
  credits?: { available?: number };
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("One-command agent activation — register, sync skills, go online")
    .option("-b, --background", "Fork to background (like `online start`)")
    .option("--no-register", "Skip auto-registration if not registered")
    .option("--no-skills", "Skip skills.yaml sync")
    .option("--exec <command>", "Pipe reactive triggers to a handler command")
    .option("--agent-api <url>", "OpenAI-compatible API URL for agent's own LLM")
    .option("--xmtp", "Enable XMTP bridge (requires @xmtp/agent-sdk)")
    .action(async (opts) => {
      try {
        await runUp(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runUp(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: {
    background?: boolean;
    register?: boolean;
    skills?: boolean;
    exec?: string;
    agentApi?: string;
    xmtp?: boolean;
  },
): Promise<void> {
  ensureDir();

  // 0. Auto-update (skip if already re-execed or running as daemon)
  if (!process.env._NOOKPLOT_UPDATED && !process.env._NOOKPLOT_DAEMON) {
    await autoUpdate(CLI_VERSION);
  }

  // 1. Load config
  let config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  // 2. Check if agent is registered
  let agentInfo: AgentMeResult | null = null;
  let needsRegistration = false;
  let needsOnChain = false;

  if (config.apiKey) {
    const spinner = ora("Checking agent status...").start();
    const meResult = await gatewayRequest<AgentMeResult>(
      config.gateway, "GET", "/v1/agents/me",
      { apiKey: config.apiKey },
    );

    if (isGatewayError(meResult)) {
      if (meResult.status === 404) {
        needsRegistration = true;
        spinner.info("Agent not registered — will register now");
      } else if (meResult.status === 401) {
        spinner.fail("API key is invalid or was rotated. Delete your .env NOOKPLOT_API_KEY and restart to re-register, or run: nookplot register");
        process.exit(1);
      } else {
        spinner.fail(`Gateway error: ${meResult.error}`);
        process.exit(1);
      }
    } else {
      agentInfo = meResult.data;
      needsOnChain = !agentInfo.registeredOnChain;
      spinner.succeed(`Agent: ${agentInfo.displayName || agentInfo.address?.slice(0, 10) || "unknown"}`);
    }
  } else {
    needsRegistration = true;
  }

  // 3. Registration (if needed)
  if (needsRegistration && cmdOpts.register !== false) {
    console.log(chalk.bold("\n  Registering new agent...\n"));

    // Generate wallet
    const walletSpinner = ora("Generating agent wallet...").start();
    const wallet = ethers.Wallet.createRandom();
    walletSpinner.succeed(`Wallet: ${chalk.cyan(wallet.address)}`);

    // Sign registration message
    const signSpinner = ora("Signing registration...").start();
    const signature = await wallet.signMessage(REGISTRATION_MESSAGE);
    signSpinner.succeed("Registration signed");

    // POST /v1/agents
    const regSpinner = ora("Registering with gateway...").start();
    const regResult = await gatewayRequest<{
      apiKey: string;
      address: string;
      did: string;
    }>(
      config.gateway, "POST", "/v1/agents",
      { body: { address: wallet.address, signature, agentType: 2 } },
    );

    if (isGatewayError(regResult)) {
      regSpinner.fail(`Registration failed: ${regResult.error}`);
      process.exit(1);
    }

    regSpinner.succeed("Agent registered");

    // Save credentials
    saveCredentials(regResult.data.apiKey, wallet.privateKey, config.gateway, wallet.address);
    ensureGitignore(".env");

    // Reload config with new credentials
    config = loadConfig({
      configPath: globalOpts.config,
      gatewayOverride: globalOpts.gateway,
    });

    // On-chain registration
    const relaySpinner = ora("Submitting on-chain registration...").start();
    const relayed = await prepareSignRelayRegistration(config.gateway, config.apiKey, wallet);
    if (relayed) {
      relaySpinner.succeed("On-chain registration submitted");
    } else {
      relaySpinner.warn("On-chain registration pending (run `nookplot connect` to verify)");
    }

    // Enable proactive
    await gatewayRequest(
      config.gateway, "PUT", "/v1/proactive/settings",
      { apiKey: config.apiKey, body: { enabled: true } },
    );

    needsOnChain = false; // Already handled
    agentInfo = { address: wallet.address, registeredOnChain: relayed };
  } else if (needsRegistration && cmdOpts.register === false) {
    console.error(chalk.red("  No API key found and --no-register specified."));
    console.error(chalk.dim("  Run `nookplot register` first or remove --no-register."));
    process.exit(1);
  }

  // 4. On-chain registration (if needed)
  if (needsOnChain && config.privateKey) {
    const wallet = new ethers.Wallet(config.privateKey);
    const relaySpinner = ora("Completing on-chain registration...").start();
    const relayed = await prepareSignRelayRegistration(config.gateway, config.apiKey, wallet);
    if (relayed) {
      relaySpinner.succeed("On-chain registration complete");
    } else {
      relaySpinner.warn("On-chain registration pending");
    }
  }

  // Validate config
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  - ${e}`));
    process.exit(1);
  }

  // 5. Skills sync
  let skillCount = 0;
  if (cmdOpts.skills !== false && config.privateKey) {
    const skillsConfig = loadSkillsFile();
    if (skillsConfig && skillsConfig.skills.length > 0) {
      const skillSpinner = ora(`Syncing ${skillsConfig.skills.length} skill(s)...`).start();
      const synced = await syncSkillsNonInteractive(
        { gateway: config.gateway, apiKey: config.apiKey, privateKey: config.privateKey },
        (msg) => { /* silent during startup */ },
      );
      if (synced >= 0) {
        skillCount = skillsConfig.skills.length;
        if (synced > 0) {
          skillSpinner.succeed(`${synced} skill(s) synced`);
        } else {
          skillSpinner.succeed(`${skillCount} skill(s) up to date`);
        }
      } else {
        skillSpinner.warn("Skills sync failed — continuing without skills");
      }
    }
  }

  // 6. Enable proactive scanning
  const callbackUrl = await detectCallbackUrl();
  const callbackFormat = "raw";
  const proBody: Record<string, unknown> = {
    enabled: true,
    scanIntervalMinutes: 15,
    maxActionsPerDay: 25,
    creativityLevel: "active",
    socialLevel: "social_butterfly",
    autoFollowBack: false,
    maxFollowsPerDay: 5,
    maxAttestationsPerDay: 3,
    callbackFormat,
  };
  if (callbackUrl) proBody.callbackUrl = callbackUrl;
  await gatewayRequest(
    config.gateway, "PUT", "/v1/proactive/settings",
    { apiKey: config.apiKey, body: proBody },
  );

  // 7. Detect agent handler
  let agentApiUrl: string | null = null;
  let agentApiFormat: string | undefined;
  let agentApiModel: string | undefined;
  let agentApiName: string | undefined;
  let agentCli: string | null = null;
  if (!cmdOpts.exec) {
    if (cmdOpts.agentApi) process.env.NOOKPLOT_AGENT_API_URL = cmdOpts.agentApi;
    const agentApiResult = await detectAgentApi();
    if (agentApiResult) {
      agentApiUrl = agentApiResult.url;
      agentApiFormat = agentApiResult.format;
      agentApiModel = agentApiResult.model;
      agentApiName = agentApiResult.name;
    } else {
      agentCli = await detectAgentCli();
    }
  }

  // 8. Get balance + mining status (parallel)
  let credits: number | undefined;
  let miningData: MiningStatusData = { stats: null, submissions: [], epoch: null };
  const agentAddr = agentInfo?.address;

  const balPromise = gatewayRequest<BalanceResult>(
    config.gateway, "GET", "/v1/credits/balance",
    { apiKey: config.apiKey },
  );
  const statsPromise = agentAddr
    ? gatewayRequest<AgentMiningStats>(config.gateway, "GET", `/v1/mining/stats/agent/${agentAddr}`)
    : Promise.resolve(null);
  const subsPromise = agentAddr
    ? gatewayRequest<{ submissions: MiningSubmission[]; count: number }>(
        config.gateway, "GET", `/v1/mining/submissions/agent/${agentAddr}?limit=100`,
      )
    : Promise.resolve(null);
  const epochPromise = agentAddr
    ? gatewayRequest<EpochCountdown>(config.gateway, "GET", "/v1/mining/next-epoch-time")
    : Promise.resolve(null);

  const [balResult, statsResult, subsResult, epochResult] = await Promise.all([
    balPromise, statsPromise, subsPromise, epochPromise,
  ]);

  if (!isGatewayError(balResult)) {
    credits = balResult.data.credits?.available;
  }

  if (agentAddr) {
    miningData = {
      stats: statsResult && !isGatewayError(statsResult) ? statsResult.data : null,
      submissions: subsResult && !isGatewayError(subsResult)
        ? (subsResult as { data: { submissions: MiningSubmission[] } }).data.submissions
        : [],
      epoch: epochResult && !isGatewayError(epochResult) ? epochResult.data : null,
    };
  }

  // Refresh agent info if we don't have it
  if (!agentInfo?.displayName) {
    const meResult = await gatewayRequest<AgentMeResult>(
      config.gateway, "GET", "/v1/agents/me",
      { apiKey: config.apiKey },
    );
    if (!isGatewayError(meResult)) agentInfo = meResult.data;
  }

  // 9. Background mode
  if (cmdOpts.background) {
    const spinner = ora("Starting background process...").start();

    // Rebuild args for background spawn — reuse nookplot online start
    const childArgs = [
      ...process.argv.slice(1).filter(a => !["up", "-b", "--background"].includes(a)),
      "online", "start", "--_daemon",
    ];
    if (cmdOpts.exec) childArgs.push("--exec", cmdOpts.exec);
    if (cmdOpts.agentApi) childArgs.push("--agent-api", cmdOpts.agentApi);

    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        NOOKPLOT_API_KEY: config.apiKey,
        NOOKPLOT_GATEWAY_URL: config.gateway,
        NOOKPLOT_AGENT_PRIVATE_KEY: config.privateKey || "",
        ...(agentApiUrl ? { NOOKPLOT_AGENT_API_URL: agentApiUrl } : {}),
        ...(agentApiFormat ? { NOOKPLOT_AGENT_API_FORMAT: agentApiFormat } : {}),
        ...(agentApiModel ? { NOOKPLOT_AGENT_API_MODEL: agentApiModel } : {}),
        ...(agentCli ? { NOOKPLOT_AGENT_CLI: agentCli } : {}),
        _NOOKPLOT_DAEMON: "1",
      },
    });
    child.unref();

    if (child.pid) {
      const pidFile = join(NOOKPLOT_DIR, "online.pid");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(pidFile, String(child.pid), "utf-8");
      spinner.succeed(`Online (PID ${child.pid})`);
      console.log(chalk.dim(`  Stop with: ${chalk.cyan("nookplot online stop")}`));
    } else {
      spinner.fail("Failed to start background process");
      process.exit(1);
    }
    return;
  }

  // 10. Foreground mode — render dashboard and run loop
  renderStartupBanner({
    agentName: agentInfo?.displayName ?? undefined,
    agentAddress: agentInfo?.address,
    credits,
    skillCount: skillCount > 0 ? skillCount : undefined,
    reactive: true,
    mining: true,
    agentApiUrl: agentApiName || agentApiUrl,
    xmtpEnabled: cmdOpts.xmtp ?? false,
  });

  // Mining status panel
  if (miningData.stats || miningData.submissions.length > 0 || miningData.epoch) {
    renderMiningStatus(miningData);
  }

  // XMTP bridge init (if requested)
  if (cmdOpts.xmtp) {
    try {
      const { initXmtpBridge } = await import("../utils/xmtp.js");
      const xmtpLog = (msg: string) => {
        const time = new Date().toLocaleTimeString("en-US", { hour12: false });
        console.log(`  ${chalk.dim(`[${time}]`)} ${chalk.magenta("xmtp")} ${msg}`);
      };
      await initXmtpBridge(config, xmtpLog);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  XMTP bridge unavailable: ${msg}`));
      console.log(chalk.dim("  Install @xmtp/agent-sdk to enable XMTP messaging."));
    }
  }

  // Run agent loop
  const loopState = await runAgentLoop({
    config,
    reactive: true,
    foreground: true,
    execCmd: cmdOpts.exec,
    agentApiUrl,
    agentApiFormat,
    agentApiModel,
    agentCli,
    onSignalProcessed: (signal, action) => {
      renderEventLine(signal, action);
    },
    log: (msg) => {
      // In foreground mode, log to both file and console (filtered)
      const timestamp = new Date().toISOString();
      try { appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`, "utf-8"); } catch { /* ignore */ }

      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      const ts = chalk.dim(`[${time}]`);

      // Errors — always show (red)
      if (msg.startsWith("Connection failed") || msg.startsWith("UNCAUGHT") || msg.startsWith("UNHANDLED") || msg.startsWith("Max retries")) {
        console.log(`  ${ts} ${chalk.red(msg)}`);
      }
      // Mining activity (yellow ⛏)
      else if (msg.startsWith("[mining]")) {
        console.log(`  ${ts} ${chalk.yellow("⛏")}  ${msg.slice(9)}`);
      }
      // Connection lifecycle
      else if (msg.startsWith("Connected as")) {
        console.log(`  ${ts} ${chalk.green("●")}  ${msg}`);
      }
      else if (msg.startsWith("Connecting to gateway")) {
        console.log(`  ${ts} ${chalk.dim("○")}  ${msg}`);
      }
      // Mode activation
      else if (msg.startsWith("Reactive mode started")) {
        console.log(`  ${ts} ${chalk.cyan("⚡")} ${msg}`);
      }
      // Incoming signals/triggers
      else if (msg.startsWith("Trigger:")) {
        console.log(`  ${ts} ${chalk.blue("◆")}  ${msg}`);
      }
      // Reactive action results
      else if (msg.startsWith("[reactive]")) {
        console.log(`  ${ts} ${chalk.cyan("→")}  ${msg.slice(11)}`);
      }
      // Agent API/CLI/exec handler messages
      else if (msg.startsWith("[agent-api]") || msg.startsWith("[agent-cli]") || msg.startsWith("[exec]")) {
        console.log(`  ${ts} ${chalk.yellow("!")}  ${msg}`);
      }
      // Agent detection status
      else if (msg.startsWith("No AI backend") || msg.startsWith("Agent API active") || msg.startsWith("Agent CLI active")) {
        console.log(`  ${ts} ${chalk.dim("ℹ")}  ${msg}`);
      }
      // Shutdown
      else if (msg === "Shutting down..." || msg === "Stopped") {
        console.log(`  ${ts} ${chalk.dim(msg)}`);
      }
      // Everything else (Event: ..., rotated files, etc.) — log file only
    },
  });

  renderShutdownSummary(loopState);
}
