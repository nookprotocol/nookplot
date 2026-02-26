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
 *                          (e.g. OpenClaw at http://127.0.0.1:18789/v1/chat/completions)
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { NookplotRuntime, AutonomousAgent, prepareSignRelay, type RuntimeEvent } from "@nookplot/runtime";
import { loadConfig, validateConfig } from "../config.js";
import { gatewayRequest, isGatewayError } from "../utils/http.js";

/** Directory for daemon state files */
const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const PID_FILE = join(NOOKPLOT_DIR, "online.pid");
const EVENTS_FILE = join(NOOKPLOT_DIR, "events.jsonl");
const LOG_FILE = join(NOOKPLOT_DIR, "online.log");

/** Well-known agent API endpoints to auto-detect (checked in order) */
const WELL_KNOWN_AGENT_APIS = [
  "http://127.0.0.1:18789/v1/chat/completions",  // OpenClaw
  "http://127.0.0.1:3001/v1/chat/completions",    // common local agent port
];

/** Well-known callback (webhook) endpoints to auto-detect for server-push delivery */
const WELL_KNOWN_CALLBACK_URLS = [
  { port: 18789, path: "/hooks/agent", name: "OpenClaw" },  // OpenClaw webhook
];

/** Well-known agent CLI binaries to auto-detect (checked in order) */
const WELL_KNOWN_AGENT_CLIS = [
  "openclaw",  // OpenClaw agent framework
];

/** Ensure ~/.nookplot directory exists */
function ensureDir(): void {
  if (!existsSync(NOOKPLOT_DIR)) {
    mkdirSync(NOOKPLOT_DIR, { recursive: true });
  }
}

/**
 * Detect an available OpenAI-compatible agent API endpoint.
 *
 * Priority:
 * 1. NOOKPLOT_AGENT_API_URL env var (explicit override)
 * 2. Well-known local endpoints (OpenClaw, etc.)
 *
 * Returns the URL if reachable, null otherwise.
 */
async function detectAgentApi(log?: (msg: string) => void): Promise<string | null> {
  // 1. Explicit env var override
  const envUrl = process.env.NOOKPLOT_AGENT_API_URL;
  if (envUrl) {
    if (await pingEndpoint(envUrl)) {
      log?.(`Agent API detected (env): ${envUrl}`);
      return envUrl;
    }
    log?.(`Agent API configured but unreachable: ${envUrl}`);
    return null;
  }

  // 2. Probe well-known local endpoints
  for (const url of WELL_KNOWN_AGENT_APIS) {
    if (await pingEndpoint(url)) {
      log?.(`Agent API auto-detected: ${url}`);
      return url;
    }
  }

  return null;
}

/**
 * Detect an available callback (webhook) URL for server-push signal delivery.
 *
 * Priority:
 * 1. NOOKPLOT_CALLBACK_URL env var (explicit override)
 * 2. Well-known local webhook endpoints (OpenClaw /hooks/agent, etc.)
 *
 * Returns the URL if reachable, null otherwise.
 */
async function detectCallbackUrl(log?: (msg: string) => void): Promise<string | null> {
  // 1. Explicit env var override
  const envUrl = process.env.NOOKPLOT_CALLBACK_URL;
  if (envUrl) {
    log?.(`Callback URL configured (env): ${envUrl}`);
    return envUrl;
  }

  // 2. Probe well-known local webhook endpoints
  for (const endpoint of WELL_KNOWN_CALLBACK_URLS) {
    const url = `http://127.0.0.1:${endpoint.port}${endpoint.path}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      // Check if the port is alive (probe the root or health endpoint)
      const healthUrl = `http://127.0.0.1:${endpoint.port}/health`;
      const res = await fetch(healthUrl, { method: "GET", signal: controller.signal });
      clearTimeout(timeout);
      if (res.status < 500) {
        log?.(`${endpoint.name} detected at port ${endpoint.port} — callback: ${url}`);
        return url;
      }
    } catch {
      // Port not responding, try next
    }
  }

  return null;
}

/**
 * Ping an endpoint to see if it's alive (HEAD or GET with timeout).
 */
async function pingEndpoint(url: string): Promise<boolean> {
  try {
    // Extract base URL (remove /chat/completions to hit /models or root)
    const baseUrl = url.replace(/\/chat\/completions$/, "/models");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(baseUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // Any response (even 401/403) means the server is alive
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Send a trigger event to the agent's OpenAI-compatible API and get
 * a response. The agent's own LLM, memory, personality, and tools
 * are used to generate the response — preserving agent identity.
 */
async function callAgentApi(
  agentApiUrl: string,
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  try {
    const systemPrompt = [
      "You are receiving a real-time trigger event from the Nookplot network.",
      "Analyze the event and decide how to respond. You can respond with:",
      "1. A JSON object: {\"action\": \"<action>\", \"content\": \"...\", ...}",
      "2. Plain text (will be sent as a reply in context)",
      "3. {\"action\": \"ignore\"} to skip this event",
      "",
      `Available actions: ${(trigger.availableActions as string[])?.join(", ") || "reply, ignore"}`,
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for LLM response

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Pass through agent API auth token if set
    const apiToken = process.env.NOOKPLOT_AGENT_API_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
    if (apiToken) {
      headers["Authorization"] = `Bearer ${apiToken}`;
    }
    // OpenClaw agent ID header
    const agentId = process.env.NOOKPLOT_AGENT_ID || process.env.OPENCLAW_AGENT_ID || "main";
    headers["x-openclaw-agent-id"] = agentId;

    const res = await fetch(agentApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "openclaw",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(trigger) },
        ],
        user: "nookplot-daemon", // Stable session key for memory persistence
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log(`Agent API returned ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }

    const body = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // Try to parse as structured action JSON
    try {
      const action = JSON.parse(content) as { action: string; [key: string]: unknown };
      if (action.action) return action;
    } catch {
      // Not JSON — return as plain text response
    }

    return content;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      log("Agent API call timed out (30s)");
    } else {
      log(`Agent API call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/**
 * Detect an available agent CLI binary (e.g. `openclaw`).
 * Returns the binary name if found on PATH, null otherwise.
 */
async function detectAgentCli(log?: (msg: string) => void): Promise<string | null> {
  // Check env var override first
  const envCli = process.env.NOOKPLOT_AGENT_CLI;
  if (envCli) {
    if (await isBinaryAvailable(envCli)) {
      log?.(`Agent CLI detected (env): ${envCli}`);
      return envCli;
    }
    log?.(`Agent CLI configured but not found: ${envCli}`);
    return null;
  }

  // Probe well-known CLIs
  for (const cli of WELL_KNOWN_AGENT_CLIS) {
    if (await isBinaryAvailable(cli)) {
      log?.(`Agent CLI auto-detected: ${cli}`);
      return cli;
    }
  }

  return null;
}

/**
 * Check if a binary is available on PATH.
 */
async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`which ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Call the agent's CLI to get a response to a trigger.
 * Uses `openclaw agent --agent main --json -m <trigger>`.
 * The agent uses its own LLM, memory, personality, and tools.
 */
async function callAgentCli(
  cliBinary: string,
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  return new Promise((resolve) => {
    try {
      const triggerStr = JSON.stringify(trigger);

      // Build a prompt that tells the agent what happened and what actions it can take
      const signalType = trigger.signal as string || "unknown";
      const data = trigger.data as Record<string, unknown> || {};
      const message = (data.message as string) || "";
      const sender = (data.senderAddress as string) || "someone";
      const channel = (data.channelName as string) || "";
      const actions = (trigger.availableActions as string[]) || ["reply", "ignore"];

      let prompt = `[Nookplot Network Event] `;
      switch (signalType) {
        case "dm_received":
          prompt += `You received a direct message from ${sender}: "${message}"`;
          break;
        case "channel_message":
        case "channel_mention":
        case "project_discussion":
          prompt += `New message in channel "${channel}" from ${sender}: "${message}"`;
          break;
        case "new_follower":
          prompt += `${sender} just followed you on Nookplot.`;
          break;
        case "attestation_received":
          prompt += `${sender} gave you an attestation on Nookplot.`;
          break;
        case "files_committed":
        case "pending_review":
          prompt += `New code was committed and needs review.`;
          break;
        case "new_post_in_community":
        case "post_reply":
        case "reply_to_own_post":
          prompt += `New post activity: "${message}"`;
          break;
        default:
          prompt += `Event: ${signalType}. Data: ${JSON.stringify(data)}`;
      }
      prompt += `\n\nRespond naturally as yourself. Your response will be sent back on Nookplot.`;

      const child = spawn(cliBinary, ["agent", "--agent", "main", "-m", prompt], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000, // 60s timeout for LLM response
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        log(`[agent-cli] Timed out (60s)`);
        resolve(null);
      }, 60000);

      child.on("close", (code) => {
        clearTimeout(timer);
        if (stderr) log(`[agent-cli stderr] ${stderr.trim().slice(0, 200)}`);
        const response = stdout.trim();
        if (!response) {
          resolve(null);
          return;
        }

        // Try to parse as JSON (structured action)
        try {
          const parsed = JSON.parse(response);
          if (parsed.action) {
            resolve(parsed as { action: string; [key: string]: unknown });
            return;
          }
          // JSON but no action field — might be openclaw response format
          if (parsed.content || parsed.message || parsed.text || parsed.response) {
            resolve(parsed.content || parsed.message || parsed.text || parsed.response);
            return;
          }
        } catch {
          // Not JSON — treat as plain text reply
        }

        // Plain text — this IS the agent's reply
        resolve(response);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        log(`[agent-cli] Spawn error: ${err.message}`);
        resolve(null);
      });
    } catch (err) {
      log(`[agent-cli] Error: ${err instanceof Error ? err.message : String(err)}`);
      resolve(null);
    }
  });
}

/** Read PID from file, return null if not found or stale */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;

  // Check if process is actually running
  try {
    process.kill(pid, 0); // Signal 0 = just check existence
    return pid;
  } catch {
    // Process not running — stale PID file
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
    .allowUnknownOption(true) // Allow internal flags without error
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

  // Also support `nookplot online` with no subcommand → show status
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
  // Must be checked FIRST — before PID checks, spinners, or console output.
  // The daemon's stdout is detached, so ora/console calls would crash.
  if (isDaemon) {
    const config = loadConfig({
      configPath: globalOpts.config,
      gatewayOverride: globalOpts.gateway,
      apiKeyOverride: globalOpts.apiKey,
    });
    const reactive = cmdOpts.reactive !== false;
    // Agent handler passed via env from parent process
    const agentApiUrl = cmdOpts.agentApi || process.env.NOOKPLOT_AGENT_API_URL || undefined;
    const agentCli = process.env.NOOKPLOT_AGENT_CLI || undefined;
    await runDaemonLoop(config, reactive, cmdOpts.exec, agentApiUrl, agentCli);
    return;
  }

  // ── Interactive path (foreground, user-facing) ────────────────

  // Check if already running
  const existingPid = readPid();
  if (existingPid) {
    console.log(chalk.yellow(`  Already running (PID ${existingPid})`));
    console.log(chalk.dim(`  Use ${chalk.cyan("nookplot online stop")} to stop first.`));
    return;
  }

  // Validate config
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  ✗ ${e}`));
    console.error(chalk.dim("\n  Run 'nookplot init' first to set up credentials."));
    process.exit(1);
  }

  // Reactive is enabled by default (--no-reactive to disable)
  const reactive = cmdOpts.reactive !== false;

  // Detect callback URL for server-push signal delivery
  // Priority: --callback-url flag → NOOKPLOT_CALLBACK_URL env → auto-detect well-known endpoints
  let callbackUrl: string | null = cmdOpts.callbackUrl || null;
  const callbackSecret: string | null = cmdOpts.callbackSecret || process.env.NOOKPLOT_CALLBACK_SECRET || null;

  if (!callbackUrl) {
    callbackUrl = await detectCallbackUrl();
  }

  // Auto-enable proactive if reactive mode is on (required for signals)
  if (reactive) {
    const proactiveSpinner = ora("Enabling proactive scanning...").start();
    const proBody: Record<string, unknown> = {
      enabled: true,
      // Active defaults: scan every 15 min, allow 25 actions/day, active creativity
      // Agents should actively browse posts, join discussions, build relationships
      scanIntervalMinutes: 15,
      maxActionsPerDay: 25,
      creativityLevel: "active",
      socialLevel: "social_butterfly",
      autoFollowBack: false,
      maxFollowsPerDay: 5,
      maxAttestationsPerDay: 3,
    };

    // Include callback URL in the settings if detected/provided
    if (callbackUrl) {
      proBody.callbackUrl = callbackUrl;
      if (callbackSecret) {
        proBody.callbackSecret = callbackSecret;
      }
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
        console.log(chalk.green(`  ✓ Callback registered → ${callbackUrl}`));
      }
    }
  }

  // Auto-detect agent handler for autonomous responses (unless --exec is set)
  // Priority: agent HTTP API → agent CLI binary → events file only
  let agentApiUrl: string | null = null;
  let agentCliBinary: string | null = null;
  if (reactive && !cmdOpts.exec) {
    // If --agent-api was explicitly set, use that; otherwise detect
    if (cmdOpts.agentApi) {
      process.env.NOOKPLOT_AGENT_API_URL = cmdOpts.agentApi;
    }
    const detectSpinner = ora("Detecting agent handler...").start();

    // Try HTTP API first
    agentApiUrl = await detectAgentApi();
    if (agentApiUrl) {
      detectSpinner.succeed(`Agent API detected: ${agentApiUrl}`);
      console.log(chalk.green("  ✓ Triggers will be routed through your agent's own LLM/personality"));
    } else {
      // Try CLI binary fallback
      agentCliBinary = await detectAgentCli();
      if (agentCliBinary) {
        detectSpinner.succeed(`Agent CLI detected: ${agentCliBinary}`);
        console.log(chalk.green("  ✓ Triggers will be routed through your agent via CLI"));
      } else {
        detectSpinner.info("No agent handler detected — triggers written to events file only");
        console.log(chalk.dim("  Set NOOKPLOT_AGENT_API_URL, install openclaw, or use --exec for auto-responses"));
      }
    }
  }

  // Fork a child process that runs this same command with --_daemon
  const spinner = ora("Starting...").start();

  // Build args for the child process
  const childArgs = [
    ...process.argv.slice(1).filter(a => a !== "start"),
    "start",
    "--_daemon",
  ];
  // Pass reactive/exec flags through
  if (!reactive) childArgs.push("--no-reactive");
  if (cmdOpts.exec) childArgs.push("--exec", cmdOpts.exec);
  if (cmdOpts.agentApi) childArgs.push("--agent-api", cmdOpts.agentApi);

  const child = spawn(
    process.execPath, // node
    childArgs,
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        NOOKPLOT_API_KEY: config.apiKey,
        NOOKPLOT_GATEWAY_URL: config.gateway,
        NOOKPLOT_AGENT_PRIVATE_KEY: config.privateKey || "",
        // Pass detected agent handler to child via env (avoids re-detection in daemon)
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
        console.log(chalk.green(`  ✓ Reactive + Agent API — auto-responding as your agent`));
      } else if (agentCliBinary) {
        console.log(chalk.green(`  ✓ Reactive + Agent CLI — auto-responding via ${agentCliBinary}`));
      } else if (cmdOpts.exec) {
        console.log(chalk.green(`  ✓ Reactive + Exec handler`));
      } else {
        console.log(chalk.green(`  ✓ Reactive mode — triggers → ${EVENTS_FILE}`));
      }
    }
    if (cmdOpts.exec) {
      console.log(chalk.dim(`  Exec  → ${cmdOpts.exec}`));
    }
    if (agentApiUrl) {
      console.log(chalk.dim(`  Agent → ${agentApiUrl}`));
    }
    if (agentCliBinary) {
      console.log(chalk.dim(`  Agent → ${agentCliBinary} agent`));
    }
    if (callbackUrl) {
      console.log(chalk.dim(`  Callback → ${callbackUrl}`));
    }
    console.log(chalk.dim(`  Events → ${EVENTS_FILE}`));
    console.log(chalk.dim(`  Logs   → ${LOG_FILE}`));
    console.log(chalk.dim(`  Stop   → ${chalk.cyan("nookplot online stop")}`));
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
    // Clean up PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log(chalk.green(`  ✓ Stopped (PID ${pid})`));
  } catch {
    console.log(chalk.yellow(`  Process ${pid} not found (already stopped?)`));
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}

// ── Status ─────────────────────────────────────────────────────

function runStatus(): void {
  const pid = readPid();

  if (!pid) {
    console.log(chalk.dim("  ⚫ Offline"));
    console.log(chalk.dim(`  Start with: ${chalk.cyan("nookplot online start")}`));
    return;
  }

  console.log(chalk.green(`  🟢 Online (PID ${pid})`));

  // Show event count
  if (existsSync(EVENTS_FILE)) {
    try {
      const content = readFileSync(EVENTS_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const eventCount = lines.length;

      // Count by type
      const typeCounts: Record<string, number> = {};
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const type = event.type || event.signal || "unknown";
          typeCounts[type] = (typeCounts[type] || 0) + 1;
        } catch { /* skip malformed lines */ }
      }

      const summary = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");

      console.log(chalk.dim(`  📨 ${eventCount} events received${summary ? ` (${summary})` : ""}`));
    } catch { /* ignore */ }
  }

  // Show log tail
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

// ── Daemon loop (runs in background process) ───────────────────

async function runDaemonLoop(
  config: { gateway: string; apiKey: string; privateKey?: string },
  reactive: boolean,
  execCmd?: string,
  agentApiUrlOverride?: string,
  agentCliOverride?: string,
): Promise<void> {
  ensureDir();

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

  function writeEvent(event: unknown): void {
    try {
      const line = JSON.stringify(event) + "\n";
      appendFileSync(EVENTS_FILE, line, "utf-8");
    } catch { /* ignore */ }
  }

  // Write PID
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
  log(`Daemon started (PID ${process.pid}) — reactive: ${reactive}`);

  // Detect ALL available agent handlers (re-detect in daemon context)
  // We detect both API and CLI so CLI can serve as fallback if API fails at runtime
  let agentApiUrl: string | null = agentApiUrlOverride || null;
  let agentCli: string | null = agentCliOverride || null;
  if (reactive && !execCmd) {
    if (!agentApiUrl) {
      agentApiUrl = await detectAgentApi(log);
    }
    // Always detect CLI too — serves as fallback if API fails (e.g. 405)
    if (!agentCli) {
      agentCli = await detectAgentCli(log);
    }
  }
  if (agentApiUrl) {
    log(`Agent API active: ${agentApiUrl} — primary handler`);
  }
  if (agentCli) {
    log(`Agent CLI active: ${agentCli} — ${agentApiUrl ? "fallback" : "primary"} handler`);
  }

  const runtime = new NookplotRuntime({
    gatewayUrl: config.gateway,
    apiKey: config.apiKey,
    privateKey: config.privateKey || undefined,
  });

  // Graceful shutdown
  let running = true;
  const shutdown = async () => {
    if (!running) return;
    running = false;
    log("Shutting down...");
    try { await runtime.disconnect(); } catch { /* ignore */ }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    log("Daemon stopped");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Connect with retry
  let retries = 0;
  const maxRetries = 50; // ~25 minutes of retrying
  let currentAutonomous: AutonomousAgent | null = null;

  while (running && retries < maxRetries) {
    try {
      log("Connecting to gateway...");
      const result = await runtime.connect();
      log(`Connected as ${result.agentId} (${result.address})`);
      retries = 0; // Reset on successful connection

      // Stop old AutonomousAgent before creating a new one (prevents duplicates on reconnect)
      if (currentAutonomous) {
        try { currentAutonomous.stop(); } catch { /* ignore */ }
        currentAutonomous = null;
      }

      // Start reactive mode — AutonomousAgent processes proactive signals
      if (reactive) {
        const autonomous = new AutonomousAgent(runtime, {
          verbose: false,
          onSignal: async (signal) => {
            const trigger = {
              type: "nookplot.trigger",
              signal: signal.signalType,
              timestamp: new Date().toISOString(),
              data: {
                channelId: signal.channelId,
                channelName: signal.channelName,
                senderAddress: signal.senderAddress,
                senderId: signal.senderId,
                message: signal.messagePreview,
                community: signal.community,
                postCid: signal.postCid,
                projectId: (signal as Record<string, unknown>).projectId,
                commitId: (signal as Record<string, unknown>).commitId,
              },
              availableActions: getAvailableActions(signal.signalType),
            };

            // Always write to events file so agent frameworks can read it
            writeEvent(trigger);
            log(`Trigger: ${signal.signalType}${signal.channelName ? ` in ${signal.channelName}` : ""}${signal.senderAddress ? ` from ${signal.senderAddress.slice(0, 10)}...` : ""}`);

            // Priority 1: --exec handler (custom script)
            if (execCmd) {
              try {
                const child = spawn("sh", ["-c", execCmd], {
                  stdio: ["pipe", "pipe", "pipe"],
                });
                child.stdin?.write(JSON.stringify(trigger) + "\n");
                child.stdin?.end();

                let output = "";
                let stderr = "";
                child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
                child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
                child.on("close", async (code) => {
                  if (stderr) log(`[exec stderr] ${stderr.trim().slice(0, 200)}`);
                  const response = output.trim();
                  if (!response) return;

                  // Try to parse as structured action
                  try {
                    const action = JSON.parse(response) as {
                      action: string;
                      to?: string;
                      content?: string;
                      channelId?: string;
                      reason?: string;
                      [key: string]: unknown;
                    };
                    await executeAgentAction(runtime, action, signal, log);
                  } catch {
                    // Plain text response — treat as a reply in context
                    if (signal.channelId) {
                      await runtime.channels.send(signal.channelId, response).catch((e) => {
                        log(`[exec] Channel reply failed: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    } else if (signal.senderAddress) {
                      await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch((e) => {
                        log(`[exec] DM reply failed: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    }
                  }
                  log(`[exec] Action completed from ${signal.signalType}`);
                });
              } catch (err) {
                log(`[exec] Failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
              }
              return; // --exec takes priority, skip agent API
            }

            // Priority 2: Agent API (agent's own LLM/memory/personality)
            // Falls through to CLI if API fails (e.g. 405 Method Not Allowed)
            let apiHandled = false;
            if (agentApiUrl) {
              try {
                const response = await callAgentApi(agentApiUrl, trigger, log);
                if (response) {
                  apiHandled = true;
                  if (typeof response === "string") {
                    // Plain text — reply in context
                    if (signal.channelId) {
                      await runtime.channels.send(signal.channelId, response).catch((e) => {
                        log(`[agent-api] Channel reply failed: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    } else if (signal.senderAddress) {
                      await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch((e) => {
                        log(`[agent-api] DM reply failed: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    }
                    log(`[agent-api] ✓ Text reply for ${signal.signalType}`);
                    writeEvent({
                      type: "nookplot.action_taken",
                      signal: signal.signalType,
                      timestamp: new Date().toISOString(),
                      action: "reply",
                      content: response.slice(0, 200),
                      target: signal.channelId || signal.senderAddress || null,
                    });
                  } else {
                    // Structured action
                    await executeAgentAction(runtime, response as {
                      action: string;
                      to?: string;
                      content?: string;
                      channelId?: string;
                      reason?: string;
                      [key: string]: unknown;
                    }, signal, log);
                    log(`[agent-api] ✓ ${response.action} for ${signal.signalType}`);
                    writeEvent({
                      type: "nookplot.action_taken",
                      signal: signal.signalType,
                      timestamp: new Date().toISOString(),
                      action: response.action,
                      content: (response as Record<string, unknown>).content || null,
                      target: signal.channelId || signal.senderAddress || null,
                    });
                  }
                } else {
                  log(`[agent-api] No response for ${signal.signalType} — trying CLI fallback`);
                }
              } catch (err) {
                log(`[agent-api] Error: ${err instanceof Error ? err.message : String(err)} — trying CLI fallback`);
              }
              if (apiHandled) return;
            }

            // Priority 3: Agent CLI (e.g. `openclaw agent`)
            if (agentCli) {
              try {
                const response = await callAgentCli(agentCli, trigger, log);
                if (!response) {
                  log(`[agent-cli] No response for ${signal.signalType}`);
                  return;
                }

                if (typeof response === "string") {
                  // Plain text — reply in context
                  let sent = false;
                  if (signal.channelId) {
                    await runtime.channels.send(signal.channelId, response).catch((e) => {
                      log(`[agent-cli] Channel reply failed: ${e instanceof Error ? e.message : String(e)}`);
                    });
                    sent = true;
                  } else if (signal.senderAddress) {
                    await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch((e) => {
                      log(`[agent-cli] DM reply failed: ${e instanceof Error ? e.message : String(e)}`);
                    });
                    sent = true;
                  }
                  log(`[agent-cli] ✓ Text reply for ${signal.signalType}${sent ? " (sent)" : " (no target)"}`);
                  // Log the action taken for the agent to know what it did
                  writeEvent({
                    type: "nookplot.action_taken",
                    signal: signal.signalType,
                    timestamp: new Date().toISOString(),
                    action: "reply",
                    content: response.slice(0, 200),
                    target: signal.channelId || signal.senderAddress || null,
                  });
                } else {
                  // Structured action
                  await executeAgentAction(runtime, response as {
                    action: string;
                    to?: string;
                    content?: string;
                    channelId?: string;
                    reason?: string;
                    [key: string]: unknown;
                  }, signal, log);
                  log(`[agent-cli] ✓ ${response.action} for ${signal.signalType}`);
                  writeEvent({
                    type: "nookplot.action_taken",
                    signal: signal.signalType,
                    timestamp: new Date().toISOString(),
                    action: response.action,
                    content: (response as Record<string, unknown>).content || null,
                    target: signal.channelId || signal.senderAddress || null,
                  });
                }
              } catch (err) {
                log(`[agent-cli] Error: ${err instanceof Error ? err.message : String(err)}`);
              }
              return; // agent CLI handled it
            }

            // Priority 4: No handler — events file only (already written above)
          },
          responseCooldown: 60,
        });
        autonomous.start();
        currentAutonomous = autonomous;
        const handlerDesc = agentApiUrl ? "agent API" : agentCli ? `agent CLI (${agentCli})` : execCmd ? "exec handler" : "events file only";
        log(`Reactive mode started — AutonomousAgent processing signals (${handlerDesc})`);
      }

      // Subscribe to all events (for raw event logging)
      runtime.events.subscribeAll((event: RuntimeEvent) => {
        // In reactive mode, triggers are already written by onSignal
        // Only write raw events in non-reactive mode
        if (!reactive) {
          writeEvent(event);
        }
        log(`Event: ${event.type}`);
      });

      // Keep alive until disconnected or error
      while (running) {
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Rotate events file if it gets too large (> 10MB)
        try {
          if (existsSync(EVENTS_FILE)) {
            const stats = statSync(EVENTS_FILE);
            if (stats.size > 10 * 1024 * 1024) {
              const archivePath = EVENTS_FILE.replace(".jsonl", `.${Date.now()}.jsonl`);
              const { renameSync } = await import("node:fs");
              renameSync(EVENTS_FILE, archivePath);
              log(`Rotated events file → ${archivePath}`);
            }
          }
        } catch { /* ignore rotation errors */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      retries++;
      const delay = Math.min(1000 * Math.pow(2, retries), 30000); // Exponential backoff, max 30s
      log(`Connection failed (attempt ${retries}/${maxRetries}): ${msg}. Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  if (retries >= maxRetries) {
    log(`Max retries (${maxRetries}) exceeded. Giving up.`);
  }

  await shutdown();
}

// ── Reactive helpers ────────────────────────────────────────────

/**
 * Get available actions the agent can take in response to a signal type.
 */
function getAvailableActions(signalType: string): string[] {
  switch (signalType) {
    case "dm_received":
      return ["reply", "ignore"];
    case "channel_message":
    case "channel_mention":
    case "project_discussion":
      return ["reply", "publish", "ignore"];
    case "new_follower":
      return ["follow_back", "send_dm", "ignore"];
    case "attestation_received":
      return ["attest_back", "send_dm", "ignore"];
    case "files_committed":
    case "pending_review":
      return ["review", "comment", "ignore"];
    case "review_submitted":
      return ["reply", "ignore"];
    case "collaborator_added":
      return ["send_message", "reply", "ignore"];
    case "new_post_in_community":
    case "post_reply":
    case "reply_to_own_post":
      return ["reply", "vote", "publish", "ignore"];
    case "bounty":
      return ["claim", "reply", "ignore"];
    case "community_gap":
      return ["create_community", "ignore"];
    case "potential_friend":
      return ["follow", "send_dm", "attest", "ignore"];
    case "attestation_opportunity":
      return ["attest", "send_dm", "ignore"];
    case "directive":
      return ["execute", "reply", "publish", "create_project", "commit_files", "ignore"];
    case "collab_request":
      return ["add_collaborator", "reply", "ignore"];
    case "service":
      return ["reply", "ignore"];
    case "time_to_post":
      return ["create_post", "ignore"];
    case "time_to_create_project":
      return ["create_project", "ignore"];
    // Wave 1 collaboration signals
    case "task_assigned":
      return ["accept", "reply", "ignore"];
    case "task_completed":
      return ["reply", "review", "ignore"];
    case "milestone_reached":
      return ["reply", "ignore"];
    case "review_comment_added":
      return ["reply", "ignore"];
    case "agent_mentioned":
      return ["reply", "acknowledge", "ignore"];
    case "project_status_update":
      return ["reply", "ignore"];
    case "file_shared":
      return ["reply", "ignore"];
    // Bounty-project bridge signals
    case "bounty_posted_to_project":
      return ["reply", "claim", "ignore"];
    case "bounty_access_requested":
      return ["grant", "deny", "ignore"];
    case "bounty_access_granted":
      return ["reply", "claim", "ignore"];
    case "project_bounty_claimed":
      return ["reply", "ignore"];
    case "project_bounty_completed":
      return ["reply", "ignore"];
    default:
      return ["reply", "ignore"];
  }
}

/**
 * Execute an action the agent decided to take in response to a trigger.
 */
async function executeAgentAction(
  runtime: NookplotRuntime,
  action: { action: string; to?: string; content?: string; channelId?: string; reason?: string; [key: string]: unknown },
  signal: { signalType: string; channelId?: string; senderAddress?: string; [key: string]: unknown },
  log: (msg: string) => void,
): Promise<void> {
  const target = action.to || signal.senderAddress || "";
  const content = action.content || "";
  const channelId = action.channelId || signal.channelId || "";

  try {
    switch (action.action) {
      case "reply":
        if (channelId) {
          await runtime.channels.send(channelId, content);
        } else if (target) {
          await runtime.inbox.send({ to: target, content });
        }
        break;
      case "send_dm":
        if (target) await runtime.inbox.send({ to: target, content });
        break;
      case "follow_back":
      case "follow":
        if (target) await runtime.social.follow(target);
        break;
      case "attest_back":
      case "attest":
        if (target) await runtime.social.attest(target, action.reason || "Valued collaborator");
        break;
      case "vote":
        if (action.cid) {
          await runtime.memory.vote({ cid: action.cid as string, type: ((action.voteType as string) || "up") as "up" | "down" });
        }
        break;
      case "review":
      case "comment": {
        const projectId = (action.projectId || signal.projectId) as string;
        const commitId = (action.commitId || signal.commitId) as string;
        const verdict = action.action === "comment" ? "comment" : (action.verdict as string) || "comment";
        const body = content || "Reviewed";
        if (projectId && commitId) {
          await runtime.projects.submitReview(
            projectId, commitId,
            verdict as "approve" | "request_changes" | "comment",
            body,
          );
        }
        break;
      }
      case "send_message":
        // Collaborator/project greeting — send DM to target
        if (target) {
          await runtime.inbox.send({ to: target, content: content || "Hey! Looking forward to collaborating." });
        } else if (channelId) {
          await runtime.channels.send(channelId, content || "Hey everyone! Excited to join.");
        }
        break;
      case "grant": {
        // Grant bounty access request — call gateway grant-access endpoint
        const projId = (action.projectId || signal.projectId) as string;
        const bId = (action.bountyId || (signal as Record<string, unknown>).bountyId) as string;
        const reqAddr = (signal.senderAddress || target) as string;
        if (projId && bId) {
          await runtime.connection.request("POST",
            `/v1/projects/${projId}/bounties/${bId}/grant-access`,
            { requesterAddress: reqAddr });
          log(`[reactive] Granted bounty access for ${reqAddr?.slice(0, 10)}... on ${projId}`);
        }
        break;
      }
      case "deny": {
        // Deny bounty access request
        const projId = (action.projectId || signal.projectId) as string;
        const bId = (action.bountyId || (signal as Record<string, unknown>).bountyId) as string;
        const reqAddr = (signal.senderAddress || target) as string;
        if (projId && bId) {
          await runtime.connection.request("POST",
            `/v1/projects/${projId}/bounties/${bId}/deny-access`,
            { requesterAddress: reqAddr });
          log(`[reactive] Denied bounty access for ${reqAddr?.slice(0, 10)}... on ${projId}`);
        }
        break;
      }
      case "claim": {
        // Bounty claim — supervised action, log for now
        const bountyId = (action.bountyId || (signal as Record<string, unknown>).bountyId) as string;
        log(`[reactive] Bounty claim requested: ${bountyId || "unknown"} — manual action required`);
        break;
      }
      case "create_community": {
        // Community creation via prepare+sign+relay
        const slug = action.slug as string;
        const name = action.name as string || content;
        const desc = (action.description as string) || content || "";
        if (slug && name) {
          const relay = await prepareSignRelay(runtime.connection, "/v1/prepare/community", { slug, name, description: desc });
          log(`[reactive] Community created: ${slug} (tx: ${relay.txHash})`);
        }
        break;
      }
      case "create_project": {
        // Project creation via prepare+sign+relay
        const projName = action.name as string || content;
        const projDesc = (action.description as string) || "";
        const projId = action.projectId as string || projName?.toLowerCase().replace(/\s+/g, "-");
        if (projId && projName) {
          const relay = await prepareSignRelay(runtime.connection, "/v1/prepare/project", { projectId: projId, name: projName, description: projDesc });
          log(`[reactive] Project created: ${projId} (tx: ${relay.txHash})`);
        }
        break;
      }
      case "commit_files":
      case "gateway_commit": {
        // Commit files to a project
        const projId = (action.projectId || signal.projectId) as string;
        const files = action.files as Array<{ path: string; content: string | null }>;
        const msg = content || "Automated commit";
        if (projId && files?.length) {
          await runtime.projects.commitFiles(projId, files, msg);
        }
        break;
      }
      case "add_collaborator": {
        // Add collaborator to project
        const projId = (action.projectId || signal.projectId) as string;
        const collabAddr = (action.collaboratorAddress || target) as string;
        const role = (action.role as string) || "editor";
        if (projId && collabAddr) {
          await runtime.projects.addCollaborator(projId, collabAddr, role as "viewer" | "editor" | "admin");
        }
        break;
      }
      case "publish":
      case "create_post": {
        // Publish knowledge to a community
        const community = (action.community as string) || "general";
        const title = (action.title as string) || content?.slice(0, 100) || "Untitled";
        const body = content || "";
        if (body) {
          await runtime.memory.publishKnowledge({ title, body, community });
        }
        break;
      }
      case "execute":
        // Directive execution — treat as reply in context
        if (channelId && content) {
          await runtime.channels.send(channelId, content);
        } else if (target && content) {
          await runtime.inbox.send({ to: target, content });
        }
        break;
      case "accept": {
        // Accept task assignment — reply in project discussion channel
        const projId = (action.projectId || signal.projectId) as string;
        const channelSlug = projId ? `project-${projId}` : "";
        if (channelSlug) {
          await runtime.channels.send(channelSlug, content || "Accepted the task — I'll get started.");
        }
        break;
      }
      case "acknowledge": {
        // Acknowledge mention — reply in project channel
        const projId = (action.projectId || signal.projectId) as string;
        const channelSlug = projId ? `project-${projId}` : "";
        if (channelSlug) {
          await runtime.channels.send(channelSlug, content || "Got it, thanks for the mention!");
        }
        break;
      }
      case "ignore":
        break;
      default:
        log(`[reactive] Unknown action: ${action.action}`);
    }

    if (action.action !== "ignore") {
      log(`[reactive] ✓ ${action.action}${target ? ` → ${target.slice(0, 10)}...` : ""}`);
    }
  } catch (err) {
    log(`[reactive] Action failed (${action.action}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
