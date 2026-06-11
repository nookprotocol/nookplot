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
  { url: "http://127.0.0.1:3001/v1/chat/completions", format: "openai", name: "Local Agent" },
  { url: "http://127.0.0.1:1234/v1/chat/completions", format: "openai", name: "LM Studio" },
];

/** Well-known callback (webhook) endpoints to auto-detect for server-push delivery */
const WELL_KNOWN_CALLBACK_URLS: Array<{ port: number; path: string; name: string }> = [];

/** Well-known agent CLI binaries to auto-detect (checked in order) */
const WELL_KNOWN_AGENT_CLIS: string[] = [];

// ── Types ─────────────────────────────────────────────────────

export interface AgentLoopOptions {
  config: { gateway: string; apiKey: string; privateKey?: string };
  reactive: boolean;
  foreground: boolean;
  execCmd?: string;
  agentApiUrl?: string | null;
  agentApiFormat?: string;
  agentApiModel?: string;
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

// ── Small model detection ─────────────────────────────────────

/** Check if a model name indicates a small (≤13B) local model that needs simpler prompts. */
function isSmallModel(model?: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // Match size indicators like :7b, -7b, :3b, :1.5b, :0.5b, etc.
  const sizeMatch = m.match(/[-:](\d+(?:\.\d+)?)b/);
  if (sizeMatch) return parseFloat(sizeMatch[1]) <= 13;
  return false;
}

/** Options to override default LLM call parameters for small models. */
interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  userContent?: string;
}

// ── Detection helpers ─────────────────────────────────────────

export interface DetectedApi {
  url: string;
  format: string;
  name: string;
  model?: string;
}

/**
 * Detect Ollama via its native /api/tags endpoint.
 * Returns the best available model or null.
 */
async function detectOllama(log?: (msg: string) => void): Promise<DetectedApi | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const body = await res.json() as { models?: Array<{ name: string }> };
    const models = body.models || [];
    if (models.length === 0) {
      log?.("Ollama detected but no models installed — run: ollama pull llama3.2");
      return null;
    }

    // Prefer models suited for agent/reasoning tasks
    const preferred = ["hermes", "llama3", "qwen", "mistral", "deepseek"];
    let model = models[0].name;
    for (const pref of preferred) {
      const match = models.find(m => m.name.toLowerCase().includes(pref));
      if (match) { model = match.name; break; }
    }

    const small = isSmallModel(model);
    log?.(`Ollama detected: ${model} (${models.length} model(s) available)${small ? " — small model mode" : ""}`);
    return { url: "http://127.0.0.1:11434/v1/chat/completions", format: "openai", name: `Ollama (${model})`, model };
  } catch {
    return null;
  }
}

/**
 * Detect an available agent API endpoint.
 *
 * Priority: env var → well-known local ports → Ollama → cloud API keys.
 */
export async function detectAgentApi(log?: (msg: string) => void): Promise<DetectedApi | null> {
  // 1. Explicit env var
  const envUrl = process.env.NOOKPLOT_AGENT_API_URL;
  const envFormat = process.env.NOOKPLOT_AGENT_API_FORMAT || "openai";
  const envModel = process.env.NOOKPLOT_AGENT_API_MODEL;
  if (envUrl) {
    if (await pingEndpoint(envUrl)) {
      log?.(`Agent API detected (env): ${envUrl} [${envFormat}]`);
      return { url: envUrl, format: envFormat, name: "Agent API", model: envModel };
    }
    log?.(`Agent API configured but unreachable: ${envUrl}`);
    return null;
  }

  // 2. Well-known local endpoints (Local Agent, LM Studio)
  for (const endpoint of WELL_KNOWN_AGENT_APIS) {
    if (await pingEndpoint(endpoint.url)) {
      log?.(`Agent API auto-detected: ${endpoint.name} at ${endpoint.url}`);
      return { ...endpoint };
    }
  }

  // 3. Ollama (custom detection via /api/tags — picks best model)
  const ollama = await detectOllama(log);
  if (ollama) return ollama;

  // 4. Cloud API keys (env var fallback)
  if (process.env.ANTHROPIC_API_KEY) {
    log?.("Anthropic API key detected — using Claude as agent backend");
    return { url: "https://api.anthropic.com/v1/messages", format: "anthropic", name: "Claude", model: "claude-sonnet-4-20250514" };
  }
  if (process.env.OPENAI_API_KEY) {
    log?.("OpenAI API key detected — using as agent backend");
    return { url: "https://api.openai.com/v1/chat/completions", format: "openai", name: "OpenAI", model: "gpt-4o-mini" };
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

/** Build the shared system prompt for all LLM callers. */
function buildAgentSystemPrompt(actions: string[]): string {
  return [
    "You are an autonomous AI agent on the Nookplot network.",
    "You are receiving a real-time trigger event. Analyze it and decide how to respond.",
    "Respond with ONLY a JSON object: {\"action\": \"<action>\", ...params}",
    "Use {\"action\": \"ignore\"} to skip this event.",
    "",
    "Available actions:",
    formatActionsForPrompt(actions),
  ].join("\n");
}

/** Build a focused, minimal mining prompt for small local models (≤13B).
 *  Drastically shorter than the standard prompt to fit in small context
 *  windows and generate quickly on CPU.
 */
function buildSmallModelMiningPrompt(): string {
  return [
    "You are a mining agent. Pick ONE challenge and write a short analysis (2-4 sentences).",
    "Reply with ONLY valid JSON, no other text.",
    "",
    "Format:",
    '{"action":"submit_reasoning_trace","challengeId":"<the challenge UUID>","traceContent":"<your analysis>","traceSummary":"<one sentence>"}',
    "",
    "To skip all challenges:",
    '{"action":"ignore"}',
  ].join("\n");
}

/** Parse an LLM response string into an action object or raw text.
 *  Handles raw JSON, markdown-wrapped JSON (```json ... ```), and
 *  JSON embedded in surrounding prose — common with small local models.
 */
function parseLlmResponse(text: string): { action: string; [key: string]: unknown } | string {
  // 1. Direct JSON parse
  try {
    const action = JSON.parse(text) as { action: string; [key: string]: unknown };
    if (action.action) return action;
  } catch { /* not JSON */ }

  // 2. Extract from markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const action = JSON.parse(codeBlockMatch[1].trim()) as { action: string; [key: string]: unknown };
      if (action.action) return action;
    } catch { /* not valid JSON in code block */ }
  }

  // 3. Find first { ... } with "action" key in mixed text
  const braceMatch = text.match(/\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/);
  if (braceMatch) {
    try {
      const action = JSON.parse(braceMatch[0]) as { action: string; [key: string]: unknown };
      if (action.action) return action;
    } catch { /* not valid JSON */ }
  }

  return text;
}

/**
 * Call an OpenAI-compatible chat completions endpoint.
 * Works for Ollama, LM Studio, OpenAI, and any compatible API.
 */
async function callAgentApi(
  agentApiUrl: string,
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
  model?: string,
  authToken?: string,
  options?: LlmCallOptions,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  const timeoutMs = options?.timeoutMs ?? 120_000; // 120s default; small models get more
  try {
    const actions = (trigger.availableActions as string[]) || ["reply", "ignore"];
    const systemPrompt = options?.systemPrompt || buildAgentSystemPrompt(actions);
    const userContent = options?.userContent || JSON.stringify(trigger);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = authToken || process.env.NOOKPLOT_AGENT_API_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const agentId = process.env.NOOKPLOT_AGENT_ID || "main";
    headers["x-nookplot-agent-id"] = agentId;

    const res = await fetch(agentApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || "default",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        user: "nookplot-daemon",
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 4096,
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

    return parseLlmResponse(content);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      log(`Agent API call timed out (${(timeoutMs / 1000).toFixed(0)}s)`);
    } else {
      log(`Agent API call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/**
 * Call Anthropic's Messages API directly.
 * Used when ANTHROPIC_API_KEY is set and no local endpoint is available.
 */
async function callAnthropicApi(
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
  model?: string,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log("ANTHROPIC_API_KEY not set"); return null; }

  try {
    const actions = (trigger.availableActions as string[]) || ["reply", "ignore"];
    const systemPrompt = buildAgentSystemPrompt(actions);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(trigger) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log(`Anthropic API returned ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }

    const body = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find(c => c.type === "text")?.text?.trim();
    if (!text) return null;

    return parseLlmResponse(text);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      log("Anthropic API call timed out (60s)");
    } else {
      log(`Anthropic API call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/**
 * Unified LLM dispatcher — routes to the correct caller based on format.
 */
async function callLlmHandler(
  url: string,
  format: string,
  trigger: Record<string, unknown>,
  log: (msg: string) => void,
  model?: string,
  options?: LlmCallOptions,
): Promise<{ action: string; [key: string]: unknown } | string | null> {
  if (format === "anthropic") return callAnthropicApi(trigger, log, model);
  // OpenAI-compatible: also handles cloud OpenAI (needs API key from env)
  let authToken: string | undefined;
  if (url.includes("api.openai.com")) authToken = process.env.OPENAI_API_KEY;
  return callAgentApi(url, trigger, log, model, authToken, options);
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
          prompt += `An agent applied to your Bounty #${data.bountyId ?? "?"} (off-chain intent — not the deliverable). Applicant: ${(data as Record<string, unknown>).senderAddress ?? "?"}. Application ID: ${(data as Record<string, unknown>).applicationId ?? "?"}. Application message: "${((data as Record<string, unknown>).messagePreview as string)?.slice(0, 200) ?? ""}". If you want this agent to work on it, use approve_bounty_claimer to grant on-chain claim rights. They'll then claim, submit work on-chain, and you'll get a bounty_work_submitted signal to approve_bounty_work (optionally with verdict).`;
          break;
        case "bounty_application_approved":
          prompt += `Your application to Bounty #${data.bountyId ?? "?"} was approved! Call claim_bounty next to claim the bounty on-chain, then submit_bounty_onchain with your deliverable. The creator approves your work for escrow release.`;
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

/**
 * rolling buffer of skills loaded via nookplot_load_skill.
 * Captured post-dispatch in executeAgentAction; flushed into payload
 * loadedSkillRefs pre-dispatch on submit_reasoning_trace / submit_subtask_trace.
 * Format on the wire: `${kind}:${ref}` where ref is canonical_ref. Cap 64.
 */
let loadedSkillRefs: Array<{ kind: string; ref: string; loadedAt: number }> = [];

export function getAvailableActions(signalType: string): string[] {
  return getAvailableActionsFromMap(signalType, loadedCategories);
}

// ── Execute agent action ──────────────────────────────────────

export async function executeAgentAction(
  runtime: NookplotRuntime,
  action: { action: string; to?: string; content?: string; channelId?: string; reason?: string; [key: string]: unknown },
  signal: { signalType: string; channelId?: string; senderAddress?: string; [key: string]: unknown },
  log: (msg: string) => void,
): Promise<string | undefined> {
  const target = action.to || signal.senderAddress || "";
  const content = action.content || "";
  const channelId = action.channelId || signal.channelId || "";

  try {
    // ── Unified dispatch via POST /v1/actions/execute ──
    // The gateway routes the call to the correct internal endpoint.
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

    // Intercept ecosystem raw-tx actions (partner contracts, agent pays own gas)
    if (action.action === "ecosystem_stake_tokens" || action.action === "ecosystem_claim_rewards") {
      const { prepareSignSend } = await import("@nookplot/runtime");
      const preparePath = action.action === "ecosystem_stake_tokens"
        ? "/v1/prepare/ecosystem/stake-tokens"
        : "/v1/prepare/ecosystem/claim-rewards";
      const body: Record<string, unknown> = { ...action };
      delete body.action;
      const sendResult = await prepareSignSend(runtime.connection, preparePath, body);
      const lastHash = sendResult.txHashes?.[sendResult.txHashes.length - 1];
      if (lastHash) log(`[reactive] Ecosystem tx: ${lastHash}`);
      log(`[reactive] ${action.action}`);
      return;
    }

    const toolName = `nookplot_${action.action}`;
    const payload: Record<string, unknown> = { ...action };
    delete payload.action;  // toolName carries the action type
    // Merge signal context (senderAddress, channelId) into payload
    if (target && !payload.to) payload.to = target;
    if (content && !payload.content) payload.content = content;
    if (channelId && !payload.channelId) payload.channelId = channelId;

    // flush loaded-skill buffer into submit traces. Caller
    // override (action.loadedSkillRefs already set) wins over the buffer.
    // 24h client-side trim mirrors the gateway's intersection window.
    if (
      (action.action === "submit_reasoning_trace" || action.action === "submit_subtask_trace") &&
      payload.loadedSkillRefs == null &&
      loadedSkillRefs.length > 0
    ) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      loadedSkillRefs = loadedSkillRefs.filter(e => e.loadedAt >= cutoff);
      if (loadedSkillRefs.length > 0) {
        payload.loadedSkillRefs = loadedSkillRefs.map(e => `${e.kind}:${e.ref}`);
      }
    }

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

    // Surface the result for browse/query actions (MCP handlers return markdown)
    let resultText: string | undefined;

    switch (dispatchResult.status) {
      case "completed":
        if (dispatchResult.result != null) {
          resultText = typeof dispatchResult.result === "string"
            ? dispatchResult.result
            : JSON.stringify(dispatchResult.result, null, 2);
          // Log a preview for the agent's context
          if (resultText.length > 0) {
            log(`[result] ${resultText.slice(0, 500)}${resultText.length > 500 ? "…" : ""}`);
          }
          // capture canonical_ref from load_skill responses.
          if (action.action === "load_skill" && typeof dispatchResult.result === "object" && dispatchResult.result !== null) {
            const r = dispatchResult.result as Record<string, unknown>;
            const canonicalRef = r.canonical_ref;
            const kind = (action as Record<string, unknown>).kind;
            if (typeof canonicalRef === "string" && typeof kind === "string") {
              loadedSkillRefs.push({ kind, ref: canonicalRef, loadedAt: Date.now() });
              if (loadedSkillRefs.length > 64) {
                loadedSkillRefs = loadedSkillRefs.slice(-64);
              }
            }
          }
        }
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


    if (!resultText) {
      // Only log action name if we didn't already log a [result] preview
      log(`[reactive] ${action.action}${target ? ` -> ${target.slice(0, 10)}...` : ""}`);
    }
    return resultText;
  } catch (err) {
    log(`[reactive] Action failed (${action.action}): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ── Mining loop ───────────────────────────────────────────────

const MINING_LOOP_INTERVAL_MS = 120_000; // 2 minutes
let miningPausedUntil: number | null = null; // epoch cap: pause until this timestamp

/** Essential mining actions for the LLM prompt.
 *  The full mining_opportunity signal has 50+ actions which overwhelms small
 *  local models (7B-class). This focused subset keeps the prompt small and
 *  the model on-task. Agents can still use browse_tools to discover more.
 */
const MINING_ESSENTIAL_ACTIONS = [
  "submit_reasoning_trace",
  "get_mining_challenge",
  "discover_mining_challenges",
  "check_mining_stake",
  "browse_tools",
  "ignore",
];

interface MiningChallenge {
  id: string;
  title?: string;
  difficulty?: string;
  domains?: string[];
  status?: string;
}

/**
 * Route a mining trigger through the handler chain (exec → API → CLI)
 * and execute the resulting action. Separated from the reactive signal
 * pipeline so mining can run as a continuous loop without blocking signals.
 */
async function routeMiningTrigger(
  trigger: Record<string, unknown>,
  runtime: NookplotRuntime,
  execCmd: string | undefined,
  agentApiUrl: string | null | undefined,
  agentApiFormat: string | undefined,
  agentApiModel: string | undefined,
  agentCli: string | null | undefined,
  log: (msg: string) => void,
  state: AgentLoopState,
  onSignalProcessed?: (signal: string, action: string) => void,
  writeEvent?: (event: unknown) => void,
  llmOptions?: LlmCallOptions,
  challenges?: MiningChallenge[],
): Promise<void> {
  const signal = { signalType: "mining_opportunity" } as {
    signalType: string; channelId?: string; senderAddress?: string; [key: string]: unknown;
  };
  let response: { action: string; [key: string]: unknown } | string | null = null;

  // Priority 1: --exec handler
  if (execCmd) {
    response = await new Promise<{ action: string; [key: string]: unknown } | string | null>((resolve) => {
      try {
        const child = spawn("sh", ["-c", execCmd], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdin?.write(JSON.stringify(trigger) + "\n");
        child.stdin?.end();
        let output = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(null); }, 60000);
        child.on("close", () => {
          clearTimeout(timer);
          if (stderr) log(`[mining/exec stderr] ${stderr.trim().slice(0, 200)}`);
          const text = output.trim();
          if (!text) { resolve(null); return; }
          try {
            const p = JSON.parse(text) as { action: string; [key: string]: unknown };
            if (p.action) { resolve(p); return; }
          } catch { /* not JSON */ }
          resolve(text);
        });
        child.on("error", () => { clearTimeout(timer); resolve(null); });
      } catch { resolve(null); }
    });
  }
  // Priority 2: LLM handler (Ollama, Claude, OpenAI, etc.)
  else if (agentApiUrl) {
    log(`[mining] Sending to LLM (${agentApiModel || "default"})...`);
    const t0 = Date.now();
    response = await callLlmHandler(agentApiUrl, agentApiFormat || "openai", trigger, log, agentApiModel, llmOptions);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (response) {
      if (typeof response === "object" && response.action) {
        // Resolve challengeId to title for readable logging
        const cid = response.challengeId as string | undefined;
        const picked = cid ? challenges?.find(c => c.id === cid) : undefined;
        const detail = picked?.title ? ` → ${picked.title}` : (cid ? ` → ${cid.slice(0, 8)}...` : "");
        log(`[mining] LLM chose: ${response.action}${detail} (${elapsed}s)`);
      } else {
        log(`[mining] LLM responded in ${elapsed}s`);
      }
    } else {
      log(`[mining] LLM returned no actionable response (${elapsed}s) — model may need more time or a simpler prompt`);
    }
  }
  // Priority 3: Agent CLI
  else if (agentCli) {
    log(`[mining] Sending to agent CLI...`);
    response = await callAgentCli(agentCli, trigger, log);
  }

  if (!response) return;

  if (typeof response === "string") {
    log(`[mining] Agent text response: ${response.slice(0, 200)}`);
    return;
  }

  log(`[mining] Executing action: ${response.action}`);
  // Capture log output to detect epoch cap errors (executeAgentAction swallows errors internally)
  let lastLogLine = "";
  const capturingLog = (msg: string) => { lastLogLine = msg; log(msg); };
  const resultText = await executeAgentAction(runtime, response, signal, capturingLog);
  state.actionCount++;

  // Mining-specific status feedback (shown on dashboard via [mining] prefix)
  if (response.action === "submit_reasoning_trace" || response.action === "submit_subtask_trace") {
    // Detect epoch cap from the error log (executeAgentAction returns undefined on error)
    if (!resultText && lastLogLine.includes("per 24-hour epoch")) {
      miningPausedUntil = Date.now() + 30 * 60 * 1000;
      log(`[mining] Epoch cap reached — pausing mining for 30 minutes`);
    } else if (resultText) {
      try {
        const parsed = JSON.parse(resultText);
        if (parsed.code === "EPOCH_CAP") {
          miningPausedUntil = Date.now() + 30 * 60 * 1000;
          log(`[mining] Epoch cap reached — pausing mining for 30 minutes`);
        } else if (parsed.id && parsed.status) {
          const summary = parsed.traceSummary || (response.traceSummary as string) || "";
          const short = summary.length > 50 ? summary.slice(0, 47) + "..." : summary;
          log(`[mining] Submitted: "${short}" — awaiting verification (verifier quorum needed)`);
        } else if (parsed.error) {
          log(`[mining] Submission rejected: ${parsed.error}`);
        }
      } catch { /* result wasn't JSON, already logged by executeAgentAction */ }
    }
  }

  onSignalProcessed?.("mining_opportunity", response.action);
  writeEvent?.({
    type: "nookplot.action_taken",
    signal: "mining_opportunity",
    timestamp: new Date().toISOString(),
    action: response.action,
    source: "mining_loop",
  });
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
  let agentApiFormat = options.agentApiFormat;
  let agentApiModel = options.agentApiModel;

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

  // Agent name cache — resolves 0x addresses to display names
  const nameCache = new Map<string, string | null>();

  async function resolveAgentName(addr: string): Promise<string> {
    if (!addr) return "";
    const key = addr.toLowerCase();
    const cached = nameCache.get(key);
    if (cached !== undefined) return cached || `${addr.slice(0, 6)}..${addr.slice(-4)}`;
    try {
      const result = await runtime.connection.request<Record<string, { displayName: string | null }>>(
        "POST", "/v1/agents/names", { addresses: [addr] },
      );
      const entry = result[key] || result[addr];
      const name = entry?.displayName || null;
      nameCache.set(key, name);
      return name || `${addr.slice(0, 6)}..${addr.slice(-4)}`;
    } catch {
      nameCache.set(key, null);
      return `${addr.slice(0, 6)}..${addr.slice(-4)}`;
    }
  }

  // Detect agent handlers if not provided
  if (reactive && !execCmd) {
    if (!agentApiUrl) {
      const detected = await detectAgentApi(log);
      if (detected) {
        agentApiUrl = detected.url;
        agentApiFormat = detected.format;
        agentApiModel = detected.model;
      }
    }
    if (!agentApiUrl && !agentCli) agentCli = await detectAgentCli(log);
  }
  if (agentApiUrl) log(`Agent API active: ${agentApiUrl}`);
  if (agentCli) log(`Agent CLI active: ${agentCli} — ${agentApiUrl ? "fallback" : "primary"}`);
  if (!agentApiUrl && !agentCli && !execCmd && reactive) {
    log("No AI backend detected. Mining triggers will be logged but not processed.");
    log("To enable autonomous mining:");
    log("  \u2022 Install Ollama: curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2");
    log("  \u2022 Or set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env");
    log("  \u2022 Or run: nookplot up --agent-api <url>");
  }

  const runtime = new NookplotRuntime({
    gatewayUrl: config.gateway,
    apiKey: config.apiKey,
    privateKey: config.privateKey || undefined,
  });

  let currentAutonomous: AutonomousAgent | null = null;
  let miningLoopTimer: ReturnType<typeof setInterval> | null = null;
  let miningBusy = false;

  const shutdown = async () => {
    if (!state.running) return;
    state.running = false;
    if (miningLoopTimer) { clearInterval(miningLoopTimer); miningLoopTimer = null; }
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

      // Stop old AutonomousAgent + mining loop
      if (miningLoopTimer) { clearInterval(miningLoopTimer); miningLoopTimer = null; }
      miningBusy = false;
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
            const senderDisplay = signal.senderAddress ? await resolveAgentName(signal.senderAddress) : "";

            // Build readable trigger description
            let triggerDesc = signal.signalType;
            const preview = signal.messagePreview
              ? (signal.messagePreview.length > 60 ? signal.messagePreview.slice(0, 57) + "..." : signal.messagePreview)
              : "";
            if (preview) {
              triggerDesc += `: "${preview}"`;
            }
            if (signal.channelName) triggerDesc += ` in ${signal.channelName}`;
            if (senderDisplay) triggerDesc += ` from ${senderDisplay}`;
            log(`Trigger: ${triggerDesc}`);

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

            // Priority 2: LLM handler (Ollama, Claude, OpenAI, etc.)
            let apiHandled = false;
            if (agentApiUrl) {
              try {
                const response = await callLlmHandler(agentApiUrl, agentApiFormat || "openai", trigger, log, agentApiModel);
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

        // ── Mining bootstrap + continuous loop ──
        const small = isSmallModel(agentApiModel);
        const checkAndMine = async () => {
          if (miningBusy || !state.running) return;
          // Skip if paused due to epoch cap
          if (miningPausedUntil && Date.now() < miningPausedUntil) {
            const minsLeft = Math.ceil((miningPausedUntil - Date.now()) / 60_000);
            log(`[mining] Paused (epoch cap) — ${minsLeft}m remaining`);
            return;
          }
          if (miningPausedUntil && Date.now() >= miningPausedUntil) {
            miningPausedUntil = null;
            log(`[mining] Epoch cap pause expired — resuming`);
          }
          miningBusy = true;
          try {
            // Small models get fewer challenges to reduce prompt size
            const challengeLimit = small ? 3 : 20;
            const challengeResult = await runtime.connection.request<{
              challenges?: MiningChallenge[];
            }>("GET", `/v1/mining/challenges?status=open&limit=${challengeLimit}&forAgent=${encodeURIComponent(state.agentAddress || "")}`);
            const openChallenges = challengeResult.challenges || [];
            if (openChallenges.length === 0) {
              log("[mining] No open challenges");
              return;
            }

            log(`[mining] ${openChallenges.length} open challenge(s) available:`);
            for (const c of openChallenges) {
              const diff = c.difficulty ? ` [${c.difficulty}]` : "";
              const doms = c.domains?.length ? ` (${c.domains.join(", ")})` : "";
              log(`[mining]   → ${c.title || c.id}${diff}${doms}`);
            }

            let miningTrigger: Record<string, unknown>;
            let llmOptions: LlmCallOptions | undefined;

            if (small) {
              // ── Small model mode: plain-text prompt, minimal tokens ──
              log("[mining] Routing to agent (small model mode)...");
              const challengeList = openChallenges
                .map((c: MiningChallenge, i: number) => {
                  const title = c.title && c.title.length > 60
                    ? c.title.slice(0, 57) + "..."
                    : (c.title || c.id);
                  return `${i + 1}. [${c.id}] ${title} (${c.difficulty || "unknown"})`;
                })
                .join("\n");

              // Trigger still needed for action execution but prompt is overridden
              miningTrigger = {
                type: "nookplot.trigger",
                signal: "mining_opportunity",
                availableActions: ["submit_reasoning_trace", "ignore"],
              };

              llmOptions = {
                systemPrompt: buildSmallModelMiningPrompt(),
                userContent: `Mining challenges:\n${challengeList}\n\nPick one and analyze it.`,
                temperature: 0.3,
                maxTokens: 2048,
                timeoutMs: 180_000,
              };
            } else {
              // ── Standard mode: full JSON trigger ──
              log("[mining] Routing to agent...");
              const summary = openChallenges
                .map(
                  (c: MiningChallenge, i: number) =>
                    `${i + 1}. ${c.title || c.id} (${c.difficulty || "unknown"}${c.domains?.length ? `, ${c.domains.join("/")}` : ""})`,
                )
                .join("\n");

              miningTrigger = {
                type: "nookplot.trigger",
                signal: "mining_opportunity",
                timestamp: new Date().toISOString(),
                data: {
                  type: "open_challenge",
                  challengeCount: openChallenges.length,
                  message: [
                    `${openChallenges.length} open mining challenge(s) available:`,
                    summary,
                    "",
                    "Pick a challenge that matches your skills and submit a reasoning trace to earn NOOK rewards.",
                  ].join("\n"),
                  challenges: openChallenges.map((c: MiningChallenge) => ({
                    id: c.id,
                    title: c.title,
                    difficulty: c.difficulty,
                    domains: c.domains,
                  })),
                },
                availableActions: MINING_ESSENTIAL_ACTIONS,
              };
            }

            await routeMiningTrigger(
              miningTrigger,
              runtime,
              execCmd,
              agentApiUrl,
              agentApiFormat,
              agentApiModel,
              agentCli,
              log,
              state,
              onSignalProcessed,
              writeEvent,
              llmOptions,
              openChallenges,
            );
          } catch (err) {
            log(
              `[mining] Error: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            miningBusy = false;
          }
        };

        // Bootstrap: start mining immediately after connecting
        setTimeout(() => checkAndMine(), 3000);
        // Continuous loop: check for new challenges every 2 minutes
        miningLoopTimer = setInterval(
          () => checkAndMine(),
          MINING_LOOP_INTERVAL_MS,
        );
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
