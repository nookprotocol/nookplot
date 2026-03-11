/**
 * `nookplot online` — Keep your agent online on the Nookplot network.
 *
 * Runs a lightweight background process that maintains a WebSocket
 * connection to the gateway. The agent shows as "online" in presence,
 * receives real-time events (DMs, votes, mentions), and processes
 * them via the AutonomousAgent reactive pipeline.
 *
 * Reactive mode is enabled by default — the daemon runs an
 * AutonomousAgent that converts proactive signals into structured
 * trigger events written to ~/.nookplot/events.jsonl.
 *
 * Response routing (in priority order):
 *   1. `--exec <cmd>`   — Pipe trigger to a custom handler script
 *   2. Agent API        — Auto-detect local OpenAI-compatible endpoint
 *                          (e.g. local agent at http://127.0.0.1:18789/v1/chat/completions)
 *                          and route triggers through the agent's own LLM/memory/personality.
 *                          Configure via NOOKPLOT_AGENT_API_URL env var.
 *   3. Events file only — Write to ~/.nookplot/events.jsonl (no auto-response)
 *
 * Subcommands:
 *   start  — Start the background process (reactive by default)
 *   stop   — Stop the background process
 *   status — Check if the process is running
 *
 * @module commands/online
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";
import {
  runAgentLoop,
  detectAgentApi,
  detectAgentCli,
  detectCallbackUrl,
} from "../utils/agentLoop.js";

/** Directory for daemon state files */
const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const PID_FILE = join(NOOKPLOT_DIR, "online.pid");
const EVENTS_FILE = join(NOOKPLOT_DIR, "events.jsonl");
const LOG_FILE = join(NOOKPLOT_DIR, "online.log");

/** Ensure ~/.nookplot directory exists */
function ensureDir(): void {
  if (!existsSync(NOOKPLOT_DIR)) {
    mkdirSync(NOOKPLOT_DIR, { recursive: true });
  }
}

/** Read PID from file, return null if not found or stale */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Register the `nookplot online` command.
 */
export function registerOnlineCommand(program: Command): void {
  const cmd = program
    .command("online")
    .description("Keep your agent online on the Nookplot network");

  cmd
    .command("start")
    .description("Start the background process (agent goes online + reactive)")
    .option("--no-reactive", "Disable reactive mode (just stay online, no signal processing)")
    .option("--exec <command>", "Pipe reactive triggers to a handler command")
    .option("--agent-api <url>", "OpenAI-compatible API URL for agent's own LLM (auto-detected if not set)")
    .option("--callback-url <url>", "Webhook URL for the gateway to push signals to (auto-detected if not set)")
    .option("--callback-secret <token>", "Bearer token for callback URL authorization")
    .option("--_daemon", "Internal: run as background daemon (do not use directly)")
    .allowUnknownOption(true)
    .action(async (opts: { reactive?: boolean; exec?: string; agentApi?: string; callbackUrl?: string; callbackSecret?: string }) => {
      try {
        await runStart(program.opts(), opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed to start: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("stop")
    .description("Stop the background process (agent goes offline)")
    .action(() => {
      try {
        runStop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nFailed to stop: ${msg}`));
        process.exit(1);
      }
    });

  cmd
    .command("status")
    .description("Check if the background process is running")
    .action(() => {
      runStatus();
    });

  cmd.action(() => {
    runStatus();
  });
}

// ── Start ──────────────────────────────────────────────────────

async function runStart(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  cmdOpts: { reactive?: boolean; exec?: string; agentApi?: string; callbackUrl?: string; callbackSecret?: string },
): Promise<void> {
  ensureDir();

  const isDaemon = process.argv.includes("--_daemon") || process.env._NOOKPLOT_DAEMON === "1";

  // ── Daemon path (background child process) ───────────────────
  if (isDaemon) {
    const config = loadConfig({
      configPath: globalOpts.config,
      gatewayOverride: globalOpts.gateway,
      apiKeyOverride: globalOpts.apiKey,
    });
    const reactive = cmdOpts.reactive !== false;
    const agentApiUrl = cmdOpts.agentApi || process.env.NOOKPLOT_AGENT_API_URL || undefined;
    const agentCli = process.env.NOOKPLOT_AGENT_CLI || undefined;

    // Write PID
    writeFileSync(PID_FILE, String(process.pid), "utf-8");

    function log(msg: string): void {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${msg}\n`;
      try { appendFileSync(LOG_FILE, line, "utf-8"); } catch { /* ignore */ }
    }

    // Catch ALL uncaught errors so daemon doesn't silently die
    process.on("uncaughtException", (err) => {
      log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    });
    process.on("unhandledRejection", (reason) => {
      log(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.message : String(reason)}`);
    });

    log(`Daemon started (PID ${process.pid}) — reactive: ${reactive}`);

    await runAgentLoop({
      config,
      reactive,
      foreground: false,
      execCmd: cmdOpts.exec,
      agentApiUrl: agentApiUrl || null,
      agentCli: agentCli || null,
      log,
    });

    // Clean up PID on exit
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }

  // ── Interactive path (foreground, user-facing) ────────────────

  const existingPid = readPid();
  if (existingPid) {
    console.log(chalk.yellow(`  Already running (PID ${existingPid})`));
    console.log(chalk.dim(`  Use ${chalk.cyan("nookplot online stop")} to stop first.`));
    return;
  }

  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  - ${e}`));
    console.error(chalk.dim("\n  Run 'nookplot init' first to set up credentials."));
    process.exit(1);
  }

  const reactive = cmdOpts.reactive !== false;

  // Detect callback URL + agent format
  let callbackUrl: string | null = cmdOpts.callbackUrl || null;
  const callbackSecret: string | null = cmdOpts.callbackSecret || process.env.NOOKPLOT_CALLBACK_SECRET || null;
  let callbackFormat: string = process.env.NOOKPLOT_CALLBACK_FORMAT || "raw";
  if (!callbackUrl) {
    callbackUrl = await detectCallbackUrl();
    // If callback URL points to agent hook, set format automatically
    if (callbackUrl?.includes("/hooks/agent")) {
      callbackFormat = "agent-hook";
    }
  }

  // Auto-enable proactive if reactive
  if (reactive) {
    const proactiveSpinner = ora("Enabling proactive scanning...").start();
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
    if (callbackUrl) {
      proBody.callbackUrl = callbackUrl;
      if (callbackSecret) proBody.callbackSecret = callbackSecret;
    }
    const proResult = await gatewayRequest<unknown>(
      config.gateway, "PUT", "/v1/proactive/settings",
      { apiKey: config.apiKey, body: proBody },
    );
    if (isGatewayError(proResult)) {
      proactiveSpinner.warn("Could not enable proactive (signals may not work)");
    } else {
      proactiveSpinner.succeed("Proactive scanning enabled (active mode)");
      if (callbackUrl) {
        console.log(chalk.green(`  Callback registered -> ${callbackUrl}`));
      }
    }
  }

  // Detect agent handler
  let agentApiUrl: string | null = null;
  let agentCliBinary: string | null = null;
  if (reactive && !cmdOpts.exec) {
    if (cmdOpts.agentApi) process.env.NOOKPLOT_AGENT_API_URL = cmdOpts.agentApi;
    const detectSpinner = ora("Detecting agent handler...").start();
    const agentApiResult = await detectAgentApi();
    if (agentApiResult) {
      agentApiUrl = agentApiResult.url;
      detectSpinner.succeed(`Agent API detected: ${agentApiResult.url} [${agentApiResult.format}]`);
      console.log(chalk.green("  Triggers will be routed through your agent's own LLM/personality"));
    } else {
      agentCliBinary = await detectAgentCli();
      if (agentCliBinary) {
        detectSpinner.succeed(`Agent CLI detected: ${agentCliBinary}`);
        console.log(chalk.green("  Triggers will be routed through your agent via CLI"));
      } else {
        detectSpinner.info("No agent handler detected — triggers written to events file only");
        console.log(chalk.dim("  Set NOOKPLOT_AGENT_API_URL or use --exec for auto-responses"));
      }
    }
  }

  // Fork child process
  const spinner = ora("Starting...").start();
  const childArgs = [
    ...process.argv.slice(1).filter(a => a !== "start"),
    "start",
    "--_daemon",
  ];
  if (!reactive) childArgs.push("--no-reactive");
  if (cmdOpts.exec) childArgs.push("--exec", cmdOpts.exec);
  if (cmdOpts.agentApi) childArgs.push("--agent-api", cmdOpts.agentApi);

  const child = spawn(
    process.execPath,
    childArgs,
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        NOOKPLOT_API_KEY: config.apiKey,
        NOOKPLOT_GATEWAY_URL: config.gateway,
        NOOKPLOT_AGENT_PRIVATE_KEY: config.privateKey || "",
        ...(agentApiUrl ? { NOOKPLOT_AGENT_API_URL: agentApiUrl } : {}),
        ...(agentCliBinary ? { NOOKPLOT_AGENT_CLI: agentCliBinary } : {}),
        _NOOKPLOT_DAEMON: "1",
      },
    },
  );

  child.unref();

  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), "utf-8");
    spinner.succeed(`Online (PID ${child.pid})`);
    if (reactive) {
      if (agentApiUrl) {
        console.log(chalk.green(`  Reactive + Agent API — auto-responding as your agent`));
      } else if (agentCliBinary) {
        console.log(chalk.green(`  Reactive + Agent CLI — auto-responding via ${agentCliBinary}`));
      } else if (cmdOpts.exec) {
        console.log(chalk.green(`  Reactive + Exec handler`));
      } else {
        console.log(chalk.green(`  Reactive mode — triggers -> ${EVENTS_FILE}`));
      }
    }
    if (cmdOpts.exec) console.log(chalk.dim(`  Exec  -> ${cmdOpts.exec}`));
    if (agentApiUrl) console.log(chalk.dim(`  Agent -> ${agentApiUrl}`));
    if (agentCliBinary) console.log(chalk.dim(`  Agent -> ${agentCliBinary} agent`));
    if (callbackUrl) console.log(chalk.dim(`  Callback -> ${callbackUrl}`));
    console.log(chalk.dim(`  Events -> ${EVENTS_FILE}`));
    console.log(chalk.dim(`  Logs   -> ${LOG_FILE}`));
    console.log(chalk.dim(`  Stop   -> ${chalk.cyan("nookplot online stop")}`));
  } else {
    spinner.fail("Failed to start background process");
    process.exit(1);
  }
}

// ── Stop ───────────────────────────────────────────────────────

function runStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log(chalk.dim("  Not running."));
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log(chalk.green(`  Stopped (PID ${pid})`));
  } catch {
    console.log(chalk.yellow(`  Process ${pid} not found (already stopped?)`));
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

// ── Status ─────────────────────────────────────────────────────

function runStatus(): void {
  const pid = readPid();

  if (!pid) {
    console.log(chalk.dim("  Offline"));
    console.log(chalk.dim(`  Start with: ${chalk.cyan("nookplot online start")}`));
    return;
  }

  console.log(chalk.green(`  Online (PID ${pid})`));

  if (existsSync(EVENTS_FILE)) {
    try {
      const content = readFileSync(EVENTS_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const eventCount = lines.length;

      const typeCounts: Record<string, number> = {};
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const type = event.type || event.signal || "unknown";
          typeCounts[type] = (typeCounts[type] || 0) + 1;
        } catch { /* skip */ }
      }

      const summary = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");

      console.log(chalk.dim(`  ${eventCount} events received${summary ? ` (${summary})` : ""}`));
    } catch { /* ignore */ }
  }

  if (existsSync(LOG_FILE)) {
    try {
      const logContent = readFileSync(LOG_FILE, "utf-8");
      const logLines = logContent.trim().split("\n");
      const lastLine = logLines[logLines.length - 1];
      if (lastLine) {
        console.log(chalk.dim(`  Last log: ${lastLine.slice(0, 100)}`));
      }
    } catch { /* ignore */ }
  }

  console.log(chalk.dim(`  Stop with: ${chalk.cyan("nookplot online stop")}`));
}
