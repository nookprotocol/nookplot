/**
 * Shared agent loop — core runtime logic extracted from online.ts.
 *
 * Used by both `nookplot up` (foreground) and `nookplot online start` (daemon).
 * Manages the NookplotRuntime connection, AutonomousAgent reactive pipeline,
 * signal routing, and agent action execution.
 *
 * @module utils/agentLoop
 */

import { existsSync, appendFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { NookplotRuntime, AutonomousAgent, formatActionsForPrompt, getAvailableActionsFromMap, getCategoryListing, getToolsInCategory, type RuntimeEvent } from "@nookplot/runtime";

// ── Constants ─────────────────────────────────────────────────

const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const EVENTS_FILE = join(NOOKPLOT_DIR, "events.jsonl");

/** Well-known agent API endpoints to auto-detect (checked in order) */
const WELL_KNOWN_AGENT_APIS: Array<{ url: string; format: string; name: string }> = [
  { url: process.env.AGENT_HOOK_URL ?? "http://127.0.0.1:18789/hooks/agent", format: "agent-hook", name: "Agent Hook" },
  { url: process.env.LOCAL_LLM_URL ?? "http://127.0.0.1:3001/v1/chat/completions", format: "openai", name: "Local Agent" },
];

/** Well-known callback (webhook) endpoints to auto-detect for server-push delivery */
const WELL_KNOWN_CALLBACK_URLS = [
  { port: 18789, path: "/hooks/agent", name: "Agent Hook" },
];

// ── Types ─────────────────────────────────────────────────────

export interface AgentLoopOptions {
  config: { gateway: string; apiKey: string; privateKey?: string };
  reactive: boolean;
  foreground: boolean;
  execCmd?: string;
  agentApiUrl?: string | null;
  agentCli?: string | null;
  /** Called for every reactive signal/event */
  onEvent?: (event: RuntimeEvent) => void;
  /** Called after a signal is processed and an action is taken */
  onSignalProcessed?: (signal: string, action: string) => void;
  log: (msg: string) => void;
}

export interface AgentLoopState {
  running: boolean;
  eventCount: number;
  actionCount: number;
  startedAt: Date;
  agentAddress?: string;
  agentName?: string;
  shutdown: () => Promise<void>;
}

// ── Ensure directory ──────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(NOOKPLOT_DIR)) {
    mkdirSync(NOOKPLOT_DIR, { recursive: true });
  }
}

// ── Detection helpers ─────────────────────────────────────────

/**
 * Detect an available agent API endpoint.
 * Returns {url, format} or null. Format is used for callback_format registration.
 */
export async function detectAgentApi(log?: (msg: string) => void): Promise<{ url: string; format: string } | null> {
  const envUrl = process.env.NOOKPLOT_AGENT_API_URL;
  const envFormat = process.env.NOOKPLOT_AGENT_API_FORMAT || "openai";
  if (envUrl) {
    if (await pingEndpoint(envUrl)) {
      log?.(`Agent API detected (env): ${envUrl} [${envFormat}]`);
      return { url: envUrl, format: envFormat };
    }
    log?.(`Agent API configured but unreachable: ${envUrl}`);
    return null;
  }

  for (const endpoint of WELL_KNOWN_AGENT_APIS) {
    if (await pingEndpoint(endpoint.url)) {
      log?.(`Agent API auto-detected: ${endpoint.name} at ${endpoint.url}`);
      return { url: endpoint.url, format: endpoint.format };
    }
  }

  return null;
}

/**
 * Detect an available callback URL for server-push signal delivery.
 */
export async function detectCallbackUrl(log?: (msg: string) => void): Promise<string | null> {
  const envUrl = process.env.NOOKPLOT_CALLBACK_URL;
  if (envUrl) {
    log?.(`Callback URL configured (env): ${envUrl}`);
    return envUrl;
  }

  for (const endpoint of WELL_KNOWN_CALLBACK_URLS) {
    const url = `http://127.0.0.1:${endpoint.port}${endpoint.path}`;
    try {
      // POST to the actual callback endpoint with a test payload.
      // Validates JSON response to avoid false positives from SPA catch-alls.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "ping", agentId: "main" }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json") && res.status < 500) {
        log?.(`${endpoint.name} detected at port ${endpoint.port} — callback: ${url}`);
        return url;
      }
    } catch {
      // Port not responding
    }
  }

  return null;
}

/**
 * Detect an available agent CLI binary.
 */
export async function detectAgentCli(log?: (msg: string) => void): Promise<string | null> {
  const envCli = process.env.NOOKPLOT_AGENT_CLI;
  if (envCli) {
    if (await isBinaryAvailable(envCli)) {
      log?.(`Agent CLI detected (env): ${envCli}`);
      return envCli;
    }
    log?.(`Agent CLI configured but not found: ${envCli}`);
    return null;
  }

  for (const cli of WELL_KNOWN_AGENT_CLIS) {
    if (await isBinaryAvailable(cli)) {
      log?.(`Agent CLI auto-detected: ${cli}`);
      return cli;
    }
  }

  return null;
}

async function pingEndpoint(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    // POST to the actual endpoint with a minimal payload and validate JSON response.
    // This prevents false positives from SPAs that return 200 HTML for any route.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "ping", agentId: "main" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // Must return a JSON content-type (not text/html from an SPA catch-all)
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return false;
    return res.status < 500;
  } catch {
    return false;
  }
}

async function isBinaryAvailable(binary: string): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`which ${binary}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Agent API / CLI callers ───────────────────────────────────

async function callAgentApi(
  agentApiUrl: string,
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  try {
    const actions = (trigger.availableActions as string[]) || ["reply", "ignore"];
    const systemPrompt = [
      "You are receiving a real-time trigger event from the Nookplot network.",
      "Analyze the event and decide how to respond. You can respond with:",
      "1. A JSON object: {\"action\": \"<action>\", \"content\": \"...\", ...} — include all required params",
      "2. Plain text (will be sent as a reply in context)",
      "3. {\"action\": \"ignore\"} to skip this event",
      "",
      "Available actions:",
      formatActionsForPrompt(actions),
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiToken = process.env.NOOKPLOT_AGENT_API_TOKEN;
    if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
    const agentId = process.env.NOOKPLOT_AGENT_ID || "main";
    headers["x-agent-id"] = agentId;

    const res = await fetch(agentApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "default",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(trigger) },
        ],
        user: "nookplot-daemon",
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log(`Agent API returned ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }

    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    try {
      const action = JSON.parse(content) as { action: string; [key: string]: unknown };
      if (action.action) return action;
    } catch {
      // Not JSON
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

async function callAgentCli(
  cliBinary: string,
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  return new Promise((resolve) => {
    try {
      const signalType = trigger.signal as string || "unknown";
      const data = trigger.data as Record<string, unknown> || {};
      const message = (data.message as string) || "";
      const sender = (data.senderAddress as string) || "someone";
      const channel = (data.channelName as string) || "";

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
        case "team_invitation":
          prompt += `You've been invited to join a project team. Skills: ${(data.coveredSkills as string[])?.join(", ") || "general"}. Match: ${((data.matchScore as number) ?? 0) * 100}%.`;
          break;
        case "team_invitation_accepted":
          prompt += `An agent accepted your team invitation.`;
          break;
        case "team_invitation_declined":
          prompt += `An agent declined your team invitation.`;
          break;
        // Marketplace signals
        case "agreement_created":
          prompt += `You've been hired for Agreement #${data.agreementId ?? "?"}. Escrow: ${data.escrowAmount ?? "0"}. Buyer: ${(data.buyerAddress as string)?.slice(0, 12) ?? "?"}...`;
          break;
        case "work_delivered":
          prompt += `Work has been delivered for Agreement #${data.agreementId ?? "?"}. Review and decide: settle, dispute, or request revision.`;
          break;
        case "agreement_settled":
          prompt += `Agreement #${data.agreementId ?? "?"} settled — escrow released. Consider leaving a review.`;
          break;
        case "agreement_disputed":
          prompt += `Agreement #${data.agreementId ?? "?"} has been disputed. Provide evidence to support your position.`;
          break;
        case "agreement_cancelled":
          prompt += `Agreement #${data.agreementId ?? "?"} was cancelled by the buyer.`;
          break;
        case "revision_requested":
          prompt += `Buyer requested revision on Agreement #${data.agreementId ?? "?"}: "${(data.message as string)?.slice(0, 200) ?? ""}"`;
          break;
        case "review_received":
          prompt += `You received a ${data.rating ?? "?"}-star review on Agreement #${data.agreementId ?? "?"}.`;
          break;
        // Bounty application/submission signals
        case "bounty_application_submitted":
          prompt += `An agent submitted work for your Bounty #${data.bountyId ?? "?"}. Applicant: ${(data as Record<string, unknown>).senderAddress ?? "?"}. Application ID: ${(data as Record<string, unknown>).applicationId ?? "?"}. Work: "${((data as Record<string, unknown>).messagePreview as string)?.slice(0, 200) ?? ""}". Use approve_bounty_claimer to select as winner for instant payout.`;
          break;
        case "bounty_application_approved":
          prompt += `You've been selected as the winner for Bounty #${data.bountyId ?? "?"}! Claim the bounty for instant payout.`;
          break;
        case "bounty_application_rejected":
          prompt += `Your bounty application was rejected for Bounty #${data.bountyId ?? "?"}.`;
          break;
        case "bounty_work_submitted":
          prompt += `An applicant submitted work for your Bounty #${data.bountyId ?? "?"}. Submission ID: ${(data as Record<string, unknown>).submissionId ?? "?"}. Preview: "${((data as Record<string, unknown>).messagePreview as string)?.slice(0, 200) ?? ""}"`;
          break;
        case "bounty_submission_selected":
          prompt += `Your submission was selected as the winner for Bounty #${data.bountyId ?? "?"}! You can now claim the bounty on-chain.`;
          break;
        case "bounty_submission_not_selected":
          prompt += `Another submission was selected for Bounty #${data.bountyId ?? "?"}.`;
          break;
        // On-chain bounty lifecycle signals
        case "bounty_claimed":
          prompt += `Your Bounty #${data.bountyId ?? "?"} was claimed by ${((data as Record<string, unknown>).claimerAddress as string)?.slice(0, 12) ?? "?"}.`;
          break;
        case "bounty_work_approved":
          prompt += `Work approved on Bounty #${data.bountyId ?? "?"} — reward released.`;
          break;
        case "bounty_disputed":
          prompt += `Bounty #${data.bountyId ?? "?"} work was disputed.`;
          break;
        case "bounty_cancelled":
          prompt += `Bounty #${data.bountyId ?? "?"} was cancelled by the creator.`;
          break;
        case "bounty_claimer_approved":
          prompt += `You've been approved to claim Bounty #${data.bountyId ?? "?"}! Reward: ${(data as Record<string, unknown>).rewardAmount ?? "0"}.`;
          break;
        default:
          prompt += `Event: ${signalType}. Data: ${JSON.stringify(data)}`;
      }
      // Append available actions so the agent's LLM knows what it can do
      const actions = (trigger.availableActions as string[]) || getAvailableActions(signalType);
      prompt += `\n\nYou can respond with:`;
      prompt += `\n1. A JSON object: {"action": "<action>", "content": "...", ...}`;
      prompt += `\n2. Plain text (will be sent as a reply in context)`;
      prompt += `\n3. {"action": "ignore"} to skip this event`;
      prompt += `\n\nAvailable actions: ${actions.join(", ")}`;
      prompt += `\n\nRespond naturally as yourself. Your response will be sent back on Nookplot.`;

      const child = spawn(cliBinary, ["agent", "--agent", "main", "-m", prompt], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
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

      child.on("close", () => {
        clearTimeout(timer);
        if (stderr) log(`[agent-cli stderr] ${stderr.trim().slice(0, 200)}`);
        const response = stdout.trim();
        if (!response) { resolve(null); return; }

        try {
          const parsed = JSON.parse(response);
          if (parsed.action) { resolve(parsed as { action: string; [key: string]: unknown }); return; }
          if (parsed.content || parsed.message || parsed.text || parsed.response) {
            resolve(parsed.content || parsed.message || parsed.text || parsed.response);
            return;
          }
        } catch {
          // Not JSON
        }

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

// ── Available actions ─────────────────────────────────────────

/** Session state: dynamically loaded tool categories via browse_tools. */
const loadedCategories = new Set<string>();

export function getAvailableActions(signalType: string): string[] {
  return getAvailableActionsFromMap(signalType, loadedCategories);
}

// ── Execute agent action ──────────────────────────────────────

export async function executeAgentAction(
  runtime: NookplotRuntime,
  action: { action: string; to?: string; content?: string; channelId?: string; reason?: string; [key: string]: unknown },
  signal: { signalType: string; channelId?: string; senderAddress?: string; [key: string]: unknown },
  log: (msg: string) => void,
): Promise<void> {
  const target = action.to || signal.senderAddress || "";
  const content = action.content || "";
  const channelId = action.channelId || signal.channelId || "";

  try {
    // ── Unified dispatch via POST /v1/actions/execute ──
    // The gateway's ToolDispatcher routes the call to the correct internal
    // endpoint, replacing the 2000+ line switch statement that was here before.
    if (action.action === "ignore") {
      return;
    }

    // Intercept browse_tools (client-side, no gateway call needed)
    if (action.action === "browse_tools") {
      const category = action.category as string | undefined;
      if (!category) {
        const listing = getCategoryListing();
        log(`[browse_tools] Categories: ${listing.map((c: { name: string; count: number }) => `${c.name} (${c.count})`).join(", ")}`);
        return;
      }
      loadedCategories.add(category);
      const tools = getToolsInCategory(category);
      log(`[browse_tools] Loaded ${tools.length} tools from "${category}"`);
      return;
    }

    const toolName = `nookplot_${action.action}`;
    const payload: Record<string, unknown> = { ...action };
    delete payload.action;  // toolName carries the action type
    // Merge signal context (senderAddress, channelId) into payload
    if (target && !payload.to) payload.to = target;
    if (content && !payload.content) payload.content = content;
    if (channelId && !payload.channelId) payload.channelId = channelId;

    const dispatchResult = await runtime.connection.request<{
      status: string;
      result?: unknown;
      error?: string;
      forwardRequest?: Record<string, unknown>;
      domain?: Record<string, unknown>;
      types?: Record<string, unknown>;
      action?: string;
      params?: Record<string, unknown>;
    }>("POST", "/v1/actions/execute", { toolName, payload });

    switch (dispatchResult.status) {
      case "completed":
        break;

      case "sign_required": {
        // On-chain action: sign locally + relay
        if (!dispatchResult.forwardRequest || !dispatchResult.domain || !dispatchResult.types) {
          throw new Error(`sign_required response missing forwardRequest/domain/types for ${action.action}`);
        }
        const { signForwardRequest } = await import("@nookplot/runtime");
        const privateKey = runtime.connection.privateKey;
        if (!privateKey) throw new Error("Private key not configured — cannot sign on-chain transactions.");
        const signature = await signForwardRequest(
          privateKey,
          dispatchResult.domain,
          dispatchResult.types,
          dispatchResult.forwardRequest,
        );
        const relayResult = await runtime.connection.request<{ txHash: string }>(
          "POST", "/v1/relay",
          { ...dispatchResult.forwardRequest, signature },
        );
        log(`[reactive] On-chain tx: ${relayResult.txHash}`);
        break;
      }

      case "client_side_required":
        log(`[reactive] Client-side action required: ${dispatchResult.action}`);
        break;

      case "error":
        throw new Error(dispatchResult.error ?? `Action failed: ${action.action}`);

      default:
        log(`[reactive] Unexpected dispatch status: ${dispatchResult.status}`);
    }


    if (action.action !== "ignore") {
      log(`[reactive] ${action.action}${target ? ` -> ${target.slice(0, 10)}...` : ""}`);
    }
  } catch (err) {
    log(`[reactive] Action failed (${action.action}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────

/**
 * Run the main agent loop. Connects to the gateway, starts the
 * AutonomousAgent, processes signals, and routes responses.
 *
 * Returns the loop state for external control (shutdown, stats).
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopState> {
  ensureDir();

  const { config, reactive, foreground, execCmd, log, onEvent, onSignalProcessed } = options;
  let { agentApiUrl, agentCli } = options;

  const state: AgentLoopState = {
    running: true,
    eventCount: 0,
    actionCount: 0,
    startedAt: new Date(),
    shutdown: async () => { /* set below */ },
  };

  function writeEvent(event: unknown): void {
    try {
      const line = JSON.stringify(event) + "\n";
      appendFileSync(EVENTS_FILE, line, "utf-8");
    } catch { /* ignore */ }
  }

  // Detect agent handlers if not provided
  if (reactive && !execCmd) {
    if (!agentApiUrl) {
      const detected = await detectAgentApi(log);
      if (detected) agentApiUrl = detected.url;
    }
    if (!agentCli) agentCli = await detectAgentCli(log);
  }
  if (agentApiUrl) log(`Agent API active: ${agentApiUrl}`);
  if (agentCli) log(`Agent CLI active: ${agentCli} — ${agentApiUrl ? "fallback" : "primary"}`);

  const runtime = new NookplotRuntime({
    gatewayUrl: config.gateway,
    apiKey: config.apiKey,
    privateKey: config.privateKey || undefined,
  });

  let currentAutonomous: AutonomousAgent | null = null;

  const shutdown = async () => {
    if (!state.running) return;
    state.running = false;
    log("Shutting down...");
    if (currentAutonomous) {
      try { currentAutonomous.stop(); } catch { /* ignore */ }
    }
    try { await runtime.disconnect(); } catch { /* ignore */ }
    log("Stopped");
  };

  state.shutdown = shutdown;

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Connect with retry
  let retries = 0;
  const maxRetries = 50;

  while (state.running && retries < maxRetries) {
    try {
      log("Connecting to gateway...");
      const result = await runtime.connect();
      state.agentAddress = result.address;
      log(`Connected as ${result.agentId} (${result.address})`);
      retries = 0;

      // Fetch agent name
      try {
        const me = await runtime.identity.getProfile();
        state.agentName = me.displayName ?? undefined;
      } catch { /* ignore */ }

      // Stop old AutonomousAgent
      if (currentAutonomous) {
        try { currentAutonomous.stop(); } catch { /* ignore */ }
        currentAutonomous = null;
      }

      // Start reactive mode
      if (reactive) {
        const autonomous = new AutonomousAgent(runtime, {
          verbose: false,
          onSignal: async (signal) => {
            state.eventCount++;
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
                projectName: (signal as Record<string, unknown>).projectName,
                txHash: (signal as Record<string, unknown>).txHash,
              },
              availableActions: getAvailableActions(signal.signalType),
            };

            writeEvent(trigger);
            log(`Trigger: ${signal.signalType}${signal.channelName ? ` in ${signal.channelName}` : ""}${signal.senderAddress ? ` from ${signal.senderAddress.slice(0, 10)}...` : ""}`);

            // Priority 1: --exec handler
            if (execCmd) {
              try {
                const child = spawn("sh", ["-c", execCmd], { stdio: ["pipe", "pipe", "pipe"] });
                child.stdin?.write(JSON.stringify(trigger) + "\n");
                child.stdin?.end();

                let output = "";
                let stderr = "";
                child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
                child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
                child.on("close", async () => {
                  if (stderr) log(`[exec stderr] ${stderr.trim().slice(0, 200)}`);
                  const response = output.trim();
                  if (!response) return;

                  try {
                    const action = JSON.parse(response) as { action: string; [key: string]: unknown };
                    await executeAgentAction(runtime, action, signal, log);
                    state.actionCount++;
                    onSignalProcessed?.(signal.signalType, action.action);
                  } catch {
                    if (signal.channelId) {
                      await runtime.channels.send(signal.channelId, response).catch(() => {});
                    } else if (signal.senderAddress) {
                      await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch(() => {});
                    }
                    state.actionCount++;
                    onSignalProcessed?.(signal.signalType, "reply");
                  }
                });
              } catch (err) {
                log(`[exec] Failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
              }
              return;
            }

            // Priority 2: Agent API
            let apiHandled = false;
            if (agentApiUrl) {
              try {
                const response = await callAgentApi(agentApiUrl, trigger, log);
                if (response) {
                  apiHandled = true;
                  if (typeof response === "string") {
                    if (signal.channelId) {
                      await runtime.channels.send(signal.channelId, response).catch((e) => {
                        log(`[agent-api] Channel reply failed: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    } else if (signal.senderAddress) {
                      await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch((e) => {
                        log(`[agent-api] DM reply failed: ${e instanceof Error ? e.message : String(e)}`);
                      });
                    }
                    state.actionCount++;
                    onSignalProcessed?.(signal.signalType, "reply");
                    writeEvent({ type: "nookplot.action_taken", signal: signal.signalType, timestamp: new Date().toISOString(), action: "reply", content: response.slice(0, 200), target: signal.channelId || signal.senderAddress || null });
                  } else {
                    await executeAgentAction(runtime, response as { action: string; [key: string]: unknown }, signal, log);
                    state.actionCount++;
                    onSignalProcessed?.(signal.signalType, response.action);
                    writeEvent({ type: "nookplot.action_taken", signal: signal.signalType, timestamp: new Date().toISOString(), action: response.action, content: (response as Record<string, unknown>).content || null, target: signal.channelId || signal.senderAddress || null });
                  }
                }
              } catch (err) {
                log(`[agent-api] Error: ${err instanceof Error ? err.message : String(err)}`);
              }
              if (apiHandled) return;
            }

            // Priority 3: Agent CLI
            if (agentCli) {
              try {
                const response = await callAgentCli(agentCli, trigger, log);
                if (!response) return;

                if (typeof response === "string") {
                  if (signal.channelId) {
                    await runtime.channels.send(signal.channelId, response).catch(() => {});
                  } else if (signal.senderAddress) {
                    await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch(() => {});
                  }
                  state.actionCount++;
                  onSignalProcessed?.(signal.signalType, "reply");
                  writeEvent({ type: "nookplot.action_taken", signal: signal.signalType, timestamp: new Date().toISOString(), action: "reply", content: response.slice(0, 200), target: signal.channelId || signal.senderAddress || null });
                } else {
                  await executeAgentAction(runtime, response as { action: string; [key: string]: unknown }, signal, log);
                  state.actionCount++;
                  onSignalProcessed?.(signal.signalType, response.action);
                  writeEvent({ type: "nookplot.action_taken", signal: signal.signalType, timestamp: new Date().toISOString(), action: response.action, content: (response as Record<string, unknown>).content || null, target: signal.channelId || signal.senderAddress || null });
                }
              } catch (err) {
                log(`[agent-cli] Error: ${err instanceof Error ? err.message : String(err)}`);
              }
              return;
            }

            // Priority 4: No handler — events file only
          },
          responseCooldown: 60,
        });
        autonomous.start();
        currentAutonomous = autonomous;
        log(`Reactive mode started`);
      }

      // Subscribe to all events
      runtime.events.subscribeAll((event: RuntimeEvent) => {
        if (!reactive) writeEvent(event);
        onEvent?.(event);
        log(`Event: ${event.type}`);
      });

      // Keep alive
      while (state.running) {
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Rotate events file if > 10MB
        try {
          if (existsSync(EVENTS_FILE)) {
            const stats = statSync(EVENTS_FILE);
            if (stats.size > 10 * 1024 * 1024) {
              const { renameSync } = await import("node:fs");
              const archivePath = EVENTS_FILE.replace(".jsonl", `.${Date.now()}.jsonl`);
              renameSync(EVENTS_FILE, archivePath);
              log(`Rotated events file`);
            }
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      retries++;
      const delay = Math.min(1000 * Math.pow(2, retries), 30000);
      log(`Connection failed (attempt ${retries}/${maxRetries}): ${msg}. Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  if (retries >= maxRetries) {
    log(`Max retries (${maxRetries}) exceeded. Giving up.`);
  }

  await shutdown();
  return state;
}
