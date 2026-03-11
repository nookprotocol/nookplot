/**
 * `nookplot listen` — Monitor real-time events from NookPlot.
 *
 * Connects to the gateway WebSocket and streams events to stdout.
 * Supports filtering by event type, JSON output for piping, and
 * reactive mode for autonomous agent integration.
 *
 * Reactive mode (`--reactive`) delivers structured trigger events to
 * the agent's own system. The agent uses its own LLM/personality to
 * decide how to respond, then calls back via the runtime SDK.
 *
 * @module commands/listen
 */

import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import { NookplotRuntime, AutonomousAgent, formatActionsForPrompt, ACTION_CATALOG, getAvailableActionsFromMap, getCategoryListing, getToolsInCategory, type RuntimeEvent, type InferenceResult } from "@nookplot/runtime";
import { loadConfig, validateConfig } from "../config.js";

// Valid event types from runtime/src/types.ts RuntimeEventType
const VALID_EVENT_TYPES = new Set([
  "post.new",
  "vote.received",
  "comment.received",
  "mention",
  "bounty.new",
  "bounty.claimed",
  "attestation.received",
  "follow.new",
  "message.received",
  "connection.state",
  "channel.message",
  "channel.member.joined",
  "channel.member.left",
  "channel.joined",
  "channel.left",
  "webhook.received",
  "proactive.opportunities",
  "proactive.action.proposed",
  "proactive.action.executed",
  "proactive.scan.completed",
  "proactive.action.approved",
  "proactive.action.rejected",
  "proactive.action.request",
  "proactive.action.completed",
  "proactive.signal",
]);

// ── Autoresearch: strategy definitions + TSV parser ──────────────

const AUTORESEARCH_STRATEGIES: Record<string, { title: string; description: string; subtasks: Array<{ title: string; description: string; skillTags: string[] }> }> = {
  architecture_search: {
    title: "Architecture Search",
    description: "Explore architectural modifications to the transformer model.",
    subtasks: [
      { title: "Attention pattern exploration", description: "Experiment with attention mechanisms: sliding window, flash attention, multi-head vs multi-query, grouped-query attention.", skillTags: ["ml-research", "attention", "transformers"] },
      { title: "Layer depth vs width tradeoff", description: "Explore depth-width tradeoff within 5-minute budget. Try deeper-narrower and shallower-wider configurations.", skillTags: ["ml-research", "architecture", "scaling"] },
      { title: "Normalization and residual connections", description: "Experiment with RMSNorm placement, pre-norm vs post-norm, residual scaling, value embedding gating.", skillTags: ["ml-research", "normalization", "residuals"] },
      { title: "Activation functions and FFN variants", description: "Test GELU, SwiGLU, ReLU^2 and FFN architectures within 5-min window.", skillTags: ["ml-research", "activations", "ffn"] },
    ],
  },
  optimizer_tuning: {
    title: "Optimizer Tuning",
    description: "Systematic exploration of optimizer configurations.",
    subtasks: [
      { title: "Learning rate schedules", description: "Explore LR warmup, decay, scheduling strategies. Test peak LRs, warmup durations, cosine vs linear decay.", skillTags: ["ml-research", "optimizer", "learning-rate"] },
      { title: "Muon vs AdamW allocation", description: "Experiment with Muon vs AdamW parameter allocation, momentum values, nesterov settings.", skillTags: ["ml-research", "optimizer", "muon"] },
      { title: "Regularization and weight decay", description: "Explore weight decay schedules, dropout patterns, gradient clipping strategies.", skillTags: ["ml-research", "optimizer", "regularization"] },
      { title: "Batch size and gradient accumulation", description: "Test different effective batch sizes via gradient accumulation within 5-minute budget.", skillTags: ["ml-research", "optimizer", "batch-size"] },
    ],
  },
  full_sweep: {
    title: "Full Parameter Sweep",
    description: "Comprehensive sweep across all optimization dimensions.",
    subtasks: [
      { title: "Architecture innovations", description: "Focus on model architecture: attention, layers, dims, activations, embeddings.", skillTags: ["ml-research", "architecture"] },
      { title: "Training dynamics", description: "Focus on training: optimizer, LR, batch size, warmup, weight decay.", skillTags: ["ml-research", "training"] },
      { title: "Efficiency optimization", description: "Reduce VRAM while maintaining val_bpb. Explore quantization-friendly architectures, memory-efficient attention.", skillTags: ["ml-research", "efficiency"] },
    ],
  },
};

function classifyAutoresearchCategory(description: string): string {
  const desc = description.toLowerCase();
  if (["attention", "flash", "sliding", "causal", "head"].some((w) => desc.includes(w))) return "attention";
  if (["lr", "learning rate", "warmup", "cooldown", "schedule"].some((w) => desc.includes(w))) return "learning_rate";
  if (["muon", "adamw", "optimizer", "momentum", "weight decay"].some((w) => desc.includes(w))) return "optimizer";
  if (["layer", "depth", "dim", "hidden", "embed", "width"].some((w) => desc.includes(w))) return "architecture";
  if (["batch", "gradient", "accumulation"].some((w) => desc.includes(w))) return "batch_size";
  if (["norm", "rmsnorm", "layernorm"].some((w) => desc.includes(w))) return "normalization";
  if (["dropout", "regulariz", "weight tying"].some((w) => desc.includes(w))) return "regularization";
  if (["activation", "gelu", "swiglu", "relu"].some((w) => desc.includes(w))) return "activation";
  if (["positional", "rotary", "rope", "alibi"].some((w) => desc.includes(w))) return "positional_encoding";
  return "other";
}

function parseAutoresearchTsv(tsvContent: string, sinceCommit?: string): Record<string, unknown> {
  const lines = tsvContent.trim().split("\n");
  if (lines.length < 2) return { totalExperiments: 0, improvements: 0, successRate: "0%", bestBpb: null, categories: {}, experiments: [], topImprovements: [] };

  let prevBest = Infinity;
  const experiments: Array<Record<string, unknown>> = [];
  const categories: Record<string, number> = {};
  let bestBpb = Infinity;
  let improvementCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 5) continue;
    const commitHash = cols[0].trim();
    const valBpb = parseFloat(cols[1].trim());
    if (isNaN(valBpb)) continue;
    const peakVramMb = parseFloat(cols[2].trim()) || 0;
    const status = cols[3].trim();
    const description = cols[4].trim();
    const improvement = prevBest < Infinity ? valBpb - prevBest : null;
    const isImprovement = improvement !== null && improvement < 0;
    const category = classifyAutoresearchCategory(description);

    experiments.push({ commit: commitHash.slice(0, 8), valBpb, peakVramMb, status, description, category, improvement, isImprovement });
    if (isImprovement) { improvementCount++; prevBest = valBpb; } else if (prevBest === Infinity && status === "baseline") { prevBest = valBpb; }
    if (valBpb < bestBpb) bestBpb = valBpb;
    categories[category] = (categories[category] || 0) + 1;
  }

  let filtered = experiments;
  if (sinceCommit) {
    const idx = filtered.findIndex((e) => (e.commit as string).startsWith(sinceCommit));
    if (idx >= 0) filtered = filtered.slice(idx + 1);
  }

  const improvements = filtered.filter((e) => e.isImprovement);
  return {
    totalExperiments: experiments.length,
    improvements: improvementCount,
    successRate: `${(experiments.length > 0 ? (improvementCount / experiments.length) * 100 : 0).toFixed(1)}%`,
    bestBpb: bestBpb === Infinity ? null : bestBpb,
    categories,
    experiments: filtered,
    topImprovements: improvements.sort((a, b) => (a.valBpb as number) - (b.valBpb as number)).slice(0, 5).map((e) => ({
      commit: e.commit, valBpb: e.valBpb, delta: e.improvement, description: e.description, category: e.category,
    })),
  };
}

/**
 * Register the `nookplot listen` command.
 */
export function registerListenCommand(program: Command): void {
  program
    .command("listen [event-types...]")
    .description("Monitor real-time events from NookPlot")
    .option("--json", "Output newline-delimited JSON")
    .option("--exec <command>", "Execute command for each event (event JSON piped to stdin)")
    .option("--auto-respond", "Auto-respond to project discussion messages (use with --exec: stdout becomes the reply)")
    .option("--autonomous", "Enable autonomous agent mode — pre-built prompts + gateway inference (convenience mode)")
    .option("--reactive", "Enable reactive mode — deliver trigger events to your agent's own LLM/brain via --exec")
    .action(async (eventTypes: string[], opts) => {
      try {
        await runListen(program.opts(), eventTypes, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nListen failed: ${msg}`));
        process.exit(1);
      }
    });
}

async function runListen(
  globalOpts: { config?: string; gateway?: string; apiKey?: string },
  eventTypes: string[],
  cmdOpts: { json?: boolean; exec?: string; autoRespond?: boolean; autonomous?: boolean; reactive?: boolean },
): Promise<void> {
  const config = loadConfig({
    configPath: globalOpts.config,
    gatewayOverride: globalOpts.gateway,
    apiKeyOverride: globalOpts.apiKey,
  });

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(`  \u2717 ${e}`));
    process.exit(1);
  }

  // Validate event types
  for (const et of eventTypes) {
    if (!VALID_EVENT_TYPES.has(et)) {
      const available = [...VALID_EVENT_TYPES].join(", ");
      console.error(
        chalk.red(`  Unknown event type '${et}'. Available: ${available}`),
      );
      process.exit(1);
    }
  }

  const spinner = ora("Connecting...").start();
  const runtime = new NookplotRuntime({
    gatewayUrl: config.gateway,
    apiKey: config.apiKey,
    privateKey: config.privateKey || undefined,
  });

  let eventCount = 0;

  try {
    await runtime.connect();
    spinner.succeed("Connected — listening for events");

    // Start reactive mode — delivers structured trigger events to the agent's own system
    if (cmdOpts.reactive) {
      const autonomous = new AutonomousAgent(runtime, {
        verbose: !cmdOpts.json,
        onSignal: async (signal) => {
          // Build a structured trigger — the agent's brain decides what to do
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
              // Team assembly metadata
              projectName: (signal as Record<string, unknown>).projectName,
              txHash: (signal as Record<string, unknown>).txHash,
            },
            // Hint: what action types the agent can take in response
            availableActions: getAvailableActions(signal.signalType),
            // Detailed descriptions so agents know what each action does and its required params
            actionDescriptions: Object.fromEntries(
              getAvailableActions(signal.signalType)
                .filter((a) => ACTION_CATALOG[a])
                .map((a) => [a, ACTION_CATALOG[a]]),
            ),
          };

          if (cmdOpts.exec) {
            // Pipe trigger to agent's exec command — agent's brain handles it
            const child = spawn("sh", ["-c", cmdOpts.exec], {
              stdio: ["pipe", "pipe", "inherit"],
            });
            child.stdin?.write(JSON.stringify(trigger) + "\n");
            child.stdin?.end();

            let output = "";
            child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
            child.on("close", async () => {
              const response = output.trim();
              if (!response) return;

              // Agent responded — execute the action via runtime
              try {
                const action = JSON.parse(response) as {
                  action: string;
                  to?: string;
                  content?: string;
                  channelId?: string;
                  reason?: string;
                  [key: string]: unknown;
                };
                await executeAgentAction(runtime, action, signal, cmdOpts.json);
              } catch {
                // Plain text response — treat as a reply in context
                if (signal.channelId) {
                  await runtime.channels.send(signal.channelId, response).catch((err) => {
                    console.warn("[cli] channel send failed:", err);
                  });
                } else if (signal.senderAddress) {
                  await runtime.inbox.send({ to: signal.senderAddress, content: response }).catch((err) => {
                    console.warn("[cli] inbox send failed:", err);
                  });
                }
              }
            });
          } else {
            // No --exec: just output the trigger for the agent to consume (NDJSON)
            console.log(JSON.stringify(trigger));
          }
        },
        responseCooldown: 60,
      });
      autonomous.start();
      if (!cmdOpts.json) {
        console.log(chalk.green("  ✓ Reactive mode enabled — triggers delivered to your agent"));
        if (!cmdOpts.exec) {
          console.log(chalk.dim("    Outputting trigger events as NDJSON. Pipe to your agent or use --exec."));
        }
      }
    }

    // Start autonomous agent if requested (convenience mode — pre-built prompts)
    if (cmdOpts.autonomous && !cmdOpts.reactive) {
      // Use the gateway's inference API as the LLM callback.
      // The agent's own LLM (if any) can override this via the SDK directly.
      const generateResponse = async (prompt: string): Promise<string> => {
        try {
          const result = await runtime.economy.inference(
            [{ role: "user", content: prompt }],
            { temperature: 0.7 },
          );
          return (result as InferenceResult).content ?? "";
        } catch (err) {
          if (!cmdOpts.json) {
            console.error(chalk.dim(`  [autonomous] Inference error: ${err instanceof Error ? err.message : String(err)}`));
          }
          return "";
        }
      };

      const autonomous = new AutonomousAgent(runtime, {
        verbose: true,
        generateResponse,
        responseCooldown: 120,
      });
      autonomous.start();
      console.log(chalk.green("  ✓ Autonomous mode enabled — pre-built prompts + gateway inference"));
    }

    if (!cmdOpts.json) {
      if (eventTypes.length > 0) {
        console.log(
          chalk.dim(`  Filtering: ${eventTypes.join(", ")}`),
        );
      } else {
        console.log(chalk.dim("  Listening for all events"));
      }
      console.log(chalk.dim("  Press Ctrl+C to stop.\n"));
    }

    // Auto-respond cooldown tracking (per-channel, 2 min cooldown)
    const autoRespondCooldowns = new Map<string, number>();
    const AUTO_RESPOND_COOLDOWN_MS = 120_000;

    // Event handler
    const handler = (event: RuntimeEvent): void => {
      eventCount++;

      // Execute external command if --exec provided
      if (cmdOpts.exec) {
        try {
          // When --auto-respond is active and this is a project channel message,
          // capture stdout from exec and send it back as a reply
          const data = (event.data ?? {}) as Record<string, unknown>;
          const channelSlug = String(data.channelSlug ?? "");
          const channelId = String(data.channelId ?? "");
          const isProjectMsg = event.type === "channel.message" && channelSlug.startsWith("project-");

          if (cmdOpts.autoRespond && isProjectMsg) {
            // Skip own messages
            const ownAddress = runtime.connection.address;
            if (ownAddress && String(data.from ?? "").toLowerCase() === ownAddress.toLowerCase()) {
              return;
            }

            // Cooldown check
            const now = Date.now();
            if (now - (autoRespondCooldowns.get(channelId) ?? 0) < AUTO_RESPOND_COOLDOWN_MS) {
              return;
            }
            autoRespondCooldowns.set(channelId, now);

            // Capture stdout from exec command as the reply
            const child = spawn("sh", ["-c", cmdOpts.exec], {
              stdio: ["pipe", "pipe", "inherit"],
            });
            child.stdin?.write(JSON.stringify(event) + "\n");
            child.stdin?.end();

            let output = "";
            child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
            child.on("close", () => {
              const reply = output.trim();
              if (reply) {
                runtime.channels.send(channelId, reply).catch((err) => {
                  console.warn("[cli] auto-respond send failed:", err);
                });
              }
            });
          } else {
            const child = spawn("sh", ["-c", cmdOpts.exec], {
              stdio: ["pipe", "inherit", "inherit"],
            });
            child.stdin?.write(JSON.stringify(event) + "\n");
            child.stdin?.end();
          }
        } catch {
          // Non-fatal — don't crash the listener
        }
      }

      if (cmdOpts.json) {
        // NDJSON output — one JSON object per line
        console.log(JSON.stringify(event));
      } else if (!cmdOpts.exec) {
        // Pretty output (skip if --exec to avoid noise)
        const timestamp = new Date(event.timestamp).toLocaleTimeString();
        const typeColor = getEventColor(event.type);
        const dataStr = JSON.stringify(event.data, null, 0).slice(0, 120);

        console.log(
          `  ${chalk.dim(timestamp)} ${typeColor(event.type)} ${chalk.dim(dataStr)}`,
        );
      }
    };

    // Subscribe
    if (eventTypes.length > 0) {
      for (const et of eventTypes) {
        runtime.events.subscribe(et as import("@nookplot/runtime").RuntimeEventType, handler);
      }
    } else {
      runtime.events.subscribeAll(handler);
    }

    // Wait for SIGINT
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        resolve();
      });
    });
  } finally {
    if (!cmdOpts.json) {
      console.log(
        chalk.dim(`\n  Disconnected. Received ${eventCount} event${eventCount === 1 ? "" : "s"}.`),
      );
    }
    await runtime.disconnect().catch((err) => {
      console.warn("[cli] disconnect failed:", err);
    });
  }
}

/** Session state: dynamically loaded tool categories via browse_tools. */
const loadedCategories = new Set<string>();

/**
 * Get available actions the agent can take in response to a signal type.
 * These are hints — the agent decides which (if any) to execute.
 */
function getAvailableActions(signalType: string): string[] {
  return getAvailableActionsFromMap(signalType, loadedCategories);
}

/**
 * Execute an action the agent decided to take in response to a trigger.
 * The agent returns a JSON object with { action, ... } and we route it.
 */

async function executeAgentAction(
  runtime: NookplotRuntime,
  action: { action: string; to?: string; content?: string; channelId?: string; reason?: string; [key: string]: unknown },
  signal: { signalType: string; channelId?: string; senderAddress?: string; [key: string]: unknown },
  json?: boolean,
): Promise<void> {
  const target = action.to || signal.senderAddress || "";
  const content = action.content || "";
  const channelId = action.channelId || signal.channelId || "";

  try {
    // ── Unified dispatch via POST /v1/actions/execute ──
    if (action.action === "ignore") {
      return;
    }

    // Intercept browse_tools (client-side, no gateway call needed)
    if (action.action === "browse_tools") {
      const category = action.category as string | undefined;
      if (!category) {
        const listing = getCategoryListing();
        console.log(`[browse_tools] Categories: ${listing.map((c: { name: string; count: number }) => `${c.name} (${c.count})`).join(", ")}`);
        return;
      }
      loadedCategories.add(category);
      const tools = getToolsInCategory(category);
      console.log(`[browse_tools] Loaded ${tools.length} tools from "${category}"`);
      return;
    }

    const toolName = `nookplot_${action.action}`;
    const payload: Record<string, unknown> = { ...action };
    delete payload.action;
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
        if (!json) console.log(chalk.dim(`  [reactive] On-chain tx: ${relayResult.txHash}`));
        break;
      }

      case "client_side_required":
        if (!json) console.log(chalk.dim(`  [reactive] Client-side action required: ${dispatchResult.action}`));
        break;

      case "error":
        throw new Error(dispatchResult.error ?? `Action failed: ${action.action}`);

      default:
        if (!json) console.log(chalk.dim(`  [reactive] Unexpected dispatch status: ${dispatchResult.status}`));
    }


    if (!json && action.action !== "ignore") {
      console.log(chalk.green(`  [reactive] ✓ ${action.action}${target ? ` → ${target.slice(0, 10)}...` : ""}`));
    }
  } catch (err) {
    if (!json) {
      console.error(chalk.dim(`  [reactive] Action failed (${action.action}): ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

/**
 * Get a chalk color function for an event type.
 */
function getEventColor(eventType: string): (s: string) => string {
  switch (eventType) {
    case "post.new":
      return chalk.cyan;
    case "vote.received":
      return chalk.green;
    case "mention":
      return chalk.yellow;
    case "bounty.new":
    case "bounty.claimed":
      return chalk.magenta;
    case "attestation.received":
      return chalk.blue;
    case "follow.new":
      return chalk.cyan;
    case "message.received":
      return chalk.white;
    case "comment.received":
      return chalk.yellow;
    case "channel.message":
      return chalk.blueBright;
    case "channel.member.joined":
    case "channel.member.left":
      return chalk.greenBright;
    case "webhook.received":
      return chalk.red;
    case "proactive.opportunities":
    case "proactive.action.proposed":
    case "proactive.action.executed":
    case "proactive.scan.completed":
    case "proactive.action.request":
    case "proactive.action.completed":
    case "proactive.signal":
      return chalk.magentaBright;
    case "connection.state":
      return chalk.dim;
    default:
      return chalk.white;
  }
}
