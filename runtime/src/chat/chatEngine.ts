/**
 * ChatEngine — Central conversational brain for multi-terminal agents.
 *
 * Loads the agent's soul document, builds personality-driven system prompts,
 * recalls memory context, runs an agentic tool-use loop, and stores
 * conversation history. All terminals (stdin, Telegram, Discord, HTTP)
 * call `engine.chat(message, context)` and get back a response.
 *
 * @module chat/chatEngine
 */

import { readFile } from "node:fs/promises";
import type { NookplotRuntime } from "../index.js";
import type { InferenceMessage } from "../types.js";
import {
  ACTION_CATALOG,
  formatActionsForPrompt,
  getCategoryListing,
  getToolsInCategory,
} from "../actionCatalog.js";
import { CORE_ACTIONS } from "../signalActionMap.js";
import { sanitizeForPrompt, UNTRUSTED_CONTENT_INSTRUCTION } from "../contentSafety.js";
import { hooks as defaultHooks, type HookRegistry } from "../hooks.js";
import {
  BasicConversationMemory,
  CompactionMemory,
  type ConversationMemory,
  type CompactionConfig,
} from "../conversation/index.js";

// ── Types ────────────────────────────────────────────────────

/** Result of the boot-time intelligence check. */
export interface IntelligenceStatus {
  ready: boolean;
  source: "subscription" | "credits" | "byok" | "local" | "none";
  provider?: string;
  model?: string;
  /** Credits remaining (if subscription/credits available) */
  creditsRemaining?: number;
  /** Estimated conversations remaining at current model cost */
  conversationsRemaining?: number;
  /** Subscription plan name (if subscribed) */
  plan?: string;
  /** Days until credits run out at current usage rate */
  estimatedDaysRemaining?: number;
  /** Earning potential info */
  earningPotential?: {
    miningPerDay: number;
    breakEvenDays: number;
    selfSustainingAfterDays: number;
  };
  /** Guidance messages for the operator */
  messages: string[];
}

export interface ChatEngineOptions {
  /** User-provided LLM function (BYOK mode). If set, bypasses runtime.economy.inference(). */
  generateResponse?: (messages: InferenceMessage[]) => Promise<string>;
  /** LLM model identifier. Default: "claude-sonnet-4-20250514" */
  model?: string;
  /** Inference provider. Default: "nookplot" */
  provider?: string;
  /** LLM temperature. Default: 0.7 */
  temperature?: number;
  /** Max tokens per LLM call. Default: 1024 */
  maxTokens?: number;
  /** Path to soul.json file. Default: "./soul.json" */
  soulPath?: string;
  /** Enable memory recall/store in conversations. Default: true */
  enableMemory?: boolean;
  /** Enable Nookplot tool use in conversations. Default: true */
  enableTools?: boolean;
  /** Max tool calls per conversation turn. Default: 5 */
  maxToolCalls?: number;
  /** Log verbose output. Default: false */
  verbose?: boolean;
  /**
   * Opt in to turn-boundary-aware compaction. When omitted, history grows
   * with the legacy 20-message cap (`BasicConversationMemory`). Provide a
   * `compactFn` (and usually a `store`) here to enable `CompactionMemory`.
   */
  compaction?: Omit<CompactionConfig, "sessionId">;
}

export interface ChatContext {
  /** Source platform for this message. */
  platform: "terminal" | "telegram" | "discord" | "http" | string;
  /** External user ID (e.g. Telegram user ID). */
  senderId?: string;
  /** Display name of the sender. */
  senderName?: string;
  /** Channel/chat ID for multi-channel platforms. */
  channelId?: string;
}

/** Parsed soul document (subset we use for prompting). */
interface SoulConfig {
  name: string;
  tagline?: string;
  description?: string;
  traits?: string[];
  communicationStyle?: string;
  communicationTone?: string;
  verbosity?: string;
  quirks?: string[];
  /** Free-form persona addendum — rendered verbatim under "Additional persona guidance". */
  additionalInstructions?: string;
  mission: string;
  domains?: string[];
  goals?: string[];
  boundaries?: string[];
}

// ── Chat Actions (subset of CORE_ACTIONS suitable for conversations) ──

const CHAT_ACTIONS: string[] = [
  // Discovery & knowledge
  "search_knowledge", "recall_memory", "store_memory", "read_feed",
  "find_agents", "discover", "leaderboard",
  // Communication
  "send_dm", "send_channel_message",
  // Identity
  "my_profile", "check_balance", "check_reputation",
  // Content
  "publish_insight", "post_content", "comment_on_content",
  // Social
  "follow", "vote",
  // Building
  "create_project", "commit_files", "list_project_files", "read_project_file",
  // Coordination
  "available_subtasks", "claim_subtask",
  // Meta
  "browse_tools",
];

// ── ChatEngine ───────────────────────────────────────────────

export class ChatEngine {
  private runtime: NookplotRuntime;
  private options: Required<
    Pick<ChatEngineOptions, "model" | "provider" | "temperature" | "maxTokens" | "soulPath" | "enableMemory" | "enableTools" | "maxToolCalls" | "verbose">
  > & Pick<ChatEngineOptions, "generateResponse">;

  private soul: SoulConfig | null = null;
  private conversationHistories: Map<string, ConversationMemory> = new Map();
  private loadedCategories: Set<string> = new Set();
  private readonly compactionConfig?: Omit<CompactionConfig, "sessionId">;

  constructor(runtime: NookplotRuntime, options: ChatEngineOptions = {}) {
    this.runtime = runtime;
    this.options = {
      generateResponse: options.generateResponse,
      model: options.model ?? "claude-sonnet-4-20250514",
      provider: options.provider ?? "nookplot",
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens ?? 1024,
      soulPath: options.soulPath ?? "./soul.json",
      enableMemory: options.enableMemory ?? true,
      enableTools: options.enableTools ?? true,
      maxToolCalls: options.maxToolCalls ?? 5,
      verbose: options.verbose ?? false,
    };
    this.compactionConfig = options.compaction;
  }

  /**
   * Construct the per-session memory implementation. Defaults to
   * `BasicConversationMemory` with the legacy 20-message cap so existing
   * callers see no behavior change. Provide `options.compaction` to swap in
   * `CompactionMemory`.
   */
  private makeMemory(sessionKey: string): ConversationMemory {
    if (this.compactionConfig) {
      const hooksRef: HookRegistry =
        (this.runtime as { hooks?: HookRegistry }).hooks ?? defaultHooks;
      return new CompactionMemory({
        ...this.compactionConfig,
        sessionId: sessionKey,
        hooks: this.compactionConfig.hooks ?? hooksRef,
      });
    }
    return new BasicConversationMemory({ sessionId: sessionKey, maxMessages: 20 });
  }

  /** Agent display name (from soul or fallback). */
  get agentName(): string {
    return this.soul?.name ?? "Agent";
  }

  // ── Soul Loading ─────────────────────────────────────────

  /**
   * Load soul document from a local JSON file.
   * Extracts identity, personality, and purpose for the system prompt.
   */
  async loadSoul(soulPath?: string): Promise<void> {
    const path = soulPath ?? this.options.soulPath;
    try {
      const raw = await readFile(path, "utf-8");
      const doc = JSON.parse(raw);
      this.soul = {
        name: doc.identity?.name ?? "Agent",
        tagline: doc.identity?.tagline,
        description: doc.identity?.description,
        traits: doc.personality?.traits,
        communicationStyle: doc.personality?.communication?.style,
        communicationTone: doc.personality?.communication?.tone,
        verbosity: doc.personality?.communication?.verbosity,
        quirks: doc.personality?.quirks,
        additionalInstructions:
          typeof doc.personality?.additional_instructions === "string"
            ? doc.personality.additional_instructions.slice(0, 2000)
            : undefined,
        mission: doc.purpose?.mission ?? "Be helpful and conversational.",
        domains: doc.purpose?.domains,
        goals: doc.purpose?.goals,
        boundaries: doc.autonomy?.boundaries,
      };
      if (this.options.verbose) {
        console.log(`[chat] Loaded soul: ${this.soul.name} — "${this.soul.tagline ?? this.soul.mission}"`);
      }
    } catch {
      if (this.options.verbose) {
        console.log(`[chat] No soul.json found at ${path} — using defaults`);
      }
      this.soul = {
        name: "Agent",
        mission: "Be helpful and conversational.",
      };
    }
  }

  // ── Intelligence Check ──────────────────────────────────

  /**
   * Check if this agent has a working inference source configured.
   *
   * Call this at boot to detect the agent's intelligence status and show
   * onboarding guidance. Returns structured status with earning projections.
   */
  async checkIntelligence(): Promise<IntelligenceStatus> {
    const messages: string[] = [];

    // Path 1: Custom generateResponse callback (local Ollama, etc.)
    if (this.options.generateResponse) {
      messages.push("Intelligence: custom callback configured (local/external LLM).");
      messages.push("Credit cost: zero (you provide your own compute).");
      return {
        ready: true,
        source: "local",
        model: this.options.model,
        messages,
      };
    }

    // Path 2-4: Gateway-mediated inference — check credits/subscription/BYOK
    try {
      const balance = await this.runtime.economy.getBalance();
      const credits = balance.credits.available;

      // Check BYOK keys
      let hasByok = false;
      try {
        const byokResult = await this.runtime.connection.request<{
          providers: Array<{ provider: string }>;
        }>("GET", "/v1/byok");
        hasByok = (byokResult.providers?.length ?? 0) > 0;
      } catch {
        // BYOK check failed — proceed without it
      }

      // Check subscription status
      let plan = "free";
      let inferenceTokensRemaining = 0;
      try {
        const subResult = await this.runtime.connection.request<{
          plan: string;
          inferenceTokensRemaining: number;
        }>("GET", "/v1/subscriptions/status");
        plan = subResult.plan;
        inferenceTokensRemaining = subResult.inferenceTokensRemaining;
      } catch {
        // No subscription info — treat as free
      }

      // Estimate conversations remaining
      const conversationsRemaining = credits > 0
        ? Math.floor(credits / this.estimateCreditCostPerConversation())
        : 0;

      // Earning potential: conservative estimate from mining
      const miningPerDay = 15_000; // ~15K credits/day from Tier 1+2 mining
      const dailyCost = this.estimateDailyCost();
      const breakEvenDays = dailyCost > 0 ? Math.ceil(miningPerDay > 0 ? dailyCost / miningPerDay : Infinity) : 0;

      // Determine status
      if (plan !== "free" && inferenceTokensRemaining > 0) {
        // Has an active subscription with tokens
        const daysAtCurrentRate = dailyCost > 0 ? Math.floor(credits / dailyCost) : 999;
        messages.push(`Intelligence: ${plan} subscription active.`);
        messages.push(`Credits: ${credits.toLocaleString()} (≈${conversationsRemaining} conversations remaining)`);
        messages.push(`Inference tokens: ${inferenceTokensRemaining.toLocaleString()} remaining this month`);
        if (daysAtCurrentRate < 30) {
          messages.push(`⚠ At current usage, credits last ~${daysAtCurrentRate} days. Consider mining to earn more.`);
        }
        messages.push(`Earning potential: ~${miningPerDay.toLocaleString()} credits/day from mining.`);
        if (breakEvenDays > 0) {
          messages.push(`Break-even: ~${breakEvenDays} days of active mining.`);
        }

        return {
          ready: true,
          source: "subscription",
          provider: this.options.provider,
          model: this.options.model,
          creditsRemaining: credits,
          conversationsRemaining,
          plan,
          estimatedDaysRemaining: daysAtCurrentRate,
          earningPotential: {
            miningPerDay,
            breakEvenDays,
            selfSustainingAfterDays: breakEvenDays * 2,
          },
          messages,
        };
      }

      if (hasByok) {
        messages.push("Intelligence: BYOK key configured (you pay the provider directly).");
        messages.push(`Credits: ${credits.toLocaleString()} (used for gateway proxy fee, minimal).`);
        messages.push("Earning potential: ~15K credits/day from mining — net positive from day 1.");

        return {
          ready: true,
          source: "byok",
          provider: this.options.provider,
          model: this.options.model,
          creditsRemaining: credits,
          conversationsRemaining: credits > 0 ? 99999 : 0, // BYOK has minimal credit cost
          earningPotential: {
            miningPerDay,
            breakEvenDays: 1,
            selfSustainingAfterDays: 1,
          },
          messages,
        };
      }

      if (credits > 0) {
        // Has credits but no subscription — can still use inference via credits
        messages.push(`Intelligence: pay-per-use (${credits.toLocaleString()} credits available).`);
        messages.push(`≈${conversationsRemaining} conversations remaining at current credit balance.`);
        messages.push("");
        messages.push("To extend your agent's lifespan:");
        messages.push("  • Subscribe:  nookplot subscribe starter   (75K credits/month)");
        messages.push("  • Add key:    nookplot byok add openrouter <key>");
        messages.push("  • Mine:       your agent earns ~15K credits/day from mining challenges");

        return {
          ready: true,
          source: "credits",
          provider: this.options.provider,
          model: this.options.model,
          creditsRemaining: credits,
          conversationsRemaining,
          plan: "pay-per-use",
          estimatedDaysRemaining: dailyCost > 0 ? Math.floor(credits / dailyCost) : 999,
          earningPotential: {
            miningPerDay,
            breakEvenDays: dailyCost > 0 ? Math.ceil(dailyCost / miningPerDay) : 0,
            selfSustainingAfterDays: dailyCost > 0 ? Math.ceil((dailyCost / miningPerDay) * 2) : 0,
          },
          messages,
        };
      }

      // No intelligence source configured
      messages.push("⚠ No inference configured. Your agent has knowledge but cannot think.");
      messages.push("");
      messages.push("Choose an intelligence source:");
      messages.push("  1. Subscribe (nookplot inference)");
      messages.push("     nookplot subscribe starter    — 75K credits/month, ≈380 Sonnet conversations");
      messages.push("     nookplot subscribe builder    — 500K credits/month, ≈2,500 conversations");
      messages.push("     nookplot subscribe pro        — 2.5M credits/month, ≈12,500 conversations");
      messages.push("");
      messages.push("  2. BYOK (bring your own API key)");
      messages.push("     nookplot byok add openrouter <key>   — use any model via OpenRouter");
      messages.push("     nookplot byok add anthropic <key>    — direct Anthropic access");
      messages.push("     nookplot byok add ollama http://localhost:11434  — local model, zero cost");
      messages.push("");
      messages.push("  3. Local model (Ollama)");
      messages.push("     Set NOOKPLOT_LLM_PROVIDER=ollama and NOOKPLOT_OLLAMA_URL=http://localhost:11434 in .env");
      messages.push("     Or pass { provider: \"ollama\", model: \"llama3.3:70b\" } to ChatEngine");
      messages.push("");
      messages.push("  4. Custom callback");
      messages.push("     Pass { generateResponse: yourFunction } to ChatEngine constructor");
      messages.push("");
      messages.push("Your agent can earn its own inference costs:");
      messages.push("  • Mining challenges:  ~15,000 credits/day");
      messages.push("  • Bounty completion:  variable (10K-500K per bounty)");
      messages.push("  • Service listings:   set your own price");
      messages.push(`  • Break-even:         ~${breakEvenDays > 0 ? breakEvenDays : 3} days of mining to cover Starter plan`);

      return {
        ready: false,
        source: "none",
        creditsRemaining: 0,
        conversationsRemaining: 0,
        earningPotential: {
          miningPerDay,
          breakEvenDays: breakEvenDays > 0 ? breakEvenDays : 3,
          selfSustainingAfterDays: breakEvenDays > 0 ? breakEvenDays * 2 : 6,
        },
        messages,
      };
    } catch {
      // Can't reach gateway — likely offline or misconfigured
      messages.push("⚠ Cannot reach gateway to check intelligence status.");
      messages.push("If using a local model, pass { generateResponse: fn } to ChatEngine.");
      return {
        ready: false,
        source: "none",
        messages,
      };
    }
  }

  /** Rough credit cost per conversation for current model. */
  private estimateCreditCostPerConversation(): number {
    // Credits per million tokens × estimated tokens per conversation
    // Average: ~2000 prompt + ~500 completion tokens
    const modelCosts: Record<string, number> = {
      "claude-sonnet-4-20250514": 197, // ~19700/M * 2500 tokens + 98500/M * 500 tokens ≈ 197
      "claude-haiku-4-5-20251001": 26,
      "gpt-4o": 74,
      "gpt-4o-mini": 4,
    };
    return modelCosts[this.options.model] ?? 100; // conservative default
  }

  /** Estimated daily credit cost (assuming ~50 conversations/day). */
  private estimateDailyCost(): number {
    return this.estimateCreditCostPerConversation() * 50;
  }

  // ── Core Chat Method ─────────────────────────────────────

  /**
   * Process a user message and return the agent's response.
   *
   * Runs an agentic loop: build prompt → call LLM → if tool call → execute → feed back → repeat.
   * Max iterations controlled by `maxToolCalls`.
   */
  async chat(message: string, context?: ChatContext): Promise<string> {
    // Ensure soul is loaded
    if (!this.soul) {
      await this.loadSoul();
    }

    // 1. Recall memory context
    let memoryContext = "";
    if (this.options.enableMemory) {
      try {
        const result = await this.runtime.memory.recall(message, { limit: 5 });
        const memories = result as unknown as Array<{ content: string }>;
        if (Array.isArray(memories) && memories.length > 0) {
          memoryContext = memories.map((m) => m.content).join("\n---\n");
        }
      } catch {
        // Memory recall failure shouldn't block the response
      }
    }

    // 2. Build system prompt
    const systemPrompt = this.buildSystemPrompt(memoryContext, context);

    // 3. Get per-session conversation memory (isolate concurrent users)
    const sessionKey = context?.senderId ?? "__default__";
    if (!this.conversationHistories.has(sessionKey)) {
      this.conversationHistories.set(sessionKey, this.makeMemory(sessionKey));
    }
    const memory = this.conversationHistories.get(sessionKey)!;

    // Add user message — memory implementation enforces its own cap/compaction.
    await memory.addMessage({ role: "user", content: message });

    // 4. Agentic loop
    let finalResponse = "";
    let toolCallCount = 0;

    while (toolCallCount <= this.options.maxToolCalls) {
      // Build messages for LLM
      const messages: InferenceMessage[] = [
        { role: "system", content: systemPrompt },
        ...memory.getContext(),
      ];

      // Call LLM
      const response = await this.callLLM(messages);

      // Check if response contains a tool call
      const actionMatch = response.match(/ACTION:\s*(\S+)/i);
      if (actionMatch && this.options.enableTools && toolCallCount < this.options.maxToolCalls) {
        const actionType = actionMatch[1].toLowerCase();

        // Parse params
        let payload: Record<string, unknown> = {};
        const paramsMatch = response.match(/PARAMS:\s*(\{[\s\S]*\})/i);
        if (paramsMatch) {
          try {
            payload = JSON.parse(paramsMatch[1]);
          } catch {
            if (this.options.verbose) console.log("[chat] Failed to parse PARAMS JSON");
          }
        }

        if (this.options.verbose) {
          console.log(`[chat] Tool call #${toolCallCount + 1}: ${actionType}`);
        }

        // Execute tool
        const toolResult = await this.executeTool(actionType, payload);

        // Record assistant response + tool result. The legacy convention is to
        // emit the tool result back as a `user` message (the chat path uses
        // string-parsed pseudo tool calls, not structured `toolCalls[]`). We
        // preserve that wire shape so existing prompts keep working — agents
        // using structured tool calls drive `addMessage` themselves.
        await memory.addMessage({ role: "assistant", content: response });
        await memory.addMessage({
          role: "user",
          content: `[Tool Result for ${actionType}]:\n${toolResult}`,
        });

        toolCallCount++;
        continue;
      }

      // No tool call — this is the final response
      // Strip any ACTION/PARAMS artifacts if present but tools disabled
      finalResponse = response.replace(/ACTION:\s*\S+\s*\n?/i, "").replace(/PARAMS:\s*\{[\s\S]*\}\s*/i, "").trim();
      if (!finalResponse) finalResponse = response.trim();
      break;
    }

    // 5. Add assistant response to conversation memory
    await memory.addMessage({ role: "assistant", content: finalResponse });

    // 6. Notify subscribers — observability + episodic-memory hook (fire-and-forget)
    //    NOTE: emit fires regardless of `enableMemory`. The episodic-memory write
    //    that used to live here is now installed by `installEpisodicMemoryHook`
    //    (auto-installed by NookplotRuntime.connect()). The hook itself respects
    //    `enableMemory` semantics — see episodicMemoryHook.ts.
    {
      const platform = context?.platform ?? "unknown";
      const sender = context?.senderName ?? context?.senderId ?? "user";
      const hooks: HookRegistry = (this.runtime as { hooks?: HookRegistry }).hooks ?? defaultHooks;
      hooks.emitFireAndForget("chat_turn_complete", {
        sender,
        platform,
        message,
        response: finalResponse,
        toolsUsed: toolCallCount > 0,
        toolCallCount,
        senderId: context?.senderId ?? null,
        channelId: context?.channelId ?? null,
        agentName: this.agentName,
        enableMemory: this.options.enableMemory,
      });
    }

    return finalResponse;
  }

  /** Clear conversation history (e.g. on platform switch or reset). */
  clearHistory(senderId?: string): void {
    if (senderId) {
      this.conversationHistories.delete(senderId);
    } else {
      this.conversationHistories.clear();
    }
    this.loadedCategories.clear();
  }

  // ── Private Methods ──────────────────────────────────────

  /**
   * Build the system prompt from soul document + memory context + tool list.
   */
  private buildSystemPrompt(memoryContext: string, context?: ChatContext): string {
    const parts: string[] = [];

    // Soul identity
    if (this.soul) {
      parts.push(`You are ${this.soul.name}.`);
      if (this.soul.tagline) parts.push(this.soul.tagline);
      if (this.soul.description) parts.push(this.soul.description);
      parts.push("");

      // Mission
      parts.push(`Mission: ${this.soul.mission}`);
      if (this.soul.domains?.length) {
        parts.push(`Domains: ${this.soul.domains.join(", ")}`);
      }
      if (this.soul.goals?.length) {
        parts.push(`Goals: ${this.soul.goals.join("; ")}`);
      }
      parts.push("");

      // Personality
      if (this.soul.traits?.length) {
        parts.push(`Personality traits: ${this.soul.traits.join(", ")}`);
      }
      if (this.soul.communicationStyle) {
        parts.push(`Communication style: ${this.soul.communicationStyle}`);
      }
      if (this.soul.communicationTone) {
        parts.push(`Tone: ${this.soul.communicationTone}`);
      }
      if (this.soul.verbosity) {
        parts.push(`Verbosity: ${this.soul.verbosity}`);
      }
      if (this.soul.quirks?.length) {
        parts.push(`Quirks: ${this.soul.quirks.join("; ")}`);
      }
      if (this.soul.additionalInstructions) {
        parts.push("");
        parts.push("Additional persona guidance from your operator:");
        parts.push(this.soul.additionalInstructions);
      }
      parts.push("");

      // Boundaries
      if (this.soul.boundaries?.length) {
        parts.push(`Boundaries: ${this.soul.boundaries.join("; ")}`);
      }
    }

    // Platform context
    if (context?.platform) {
      parts.push(`You are chatting on ${context.platform}.`);
    }

    // Memory context
    if (memoryContext) {
      parts.push("");
      parts.push("Relevant memories from previous conversations:");
      parts.push(memoryContext);
    }

    // Tool instructions
    if (this.options.enableTools) {
      parts.push("");
      parts.push(UNTRUSTED_CONTENT_INSTRUCTION);
      parts.push("");
      parts.push("You have access to Nookplot tools. To use one, respond ONLY with:");
      parts.push("ACTION: <tool_name>");
      parts.push("PARAMS: <json object>");
      parts.push("");
      parts.push("Do NOT mix tool calls with regular text. If you need to use a tool, respond with ONLY the ACTION/PARAMS block. After seeing the tool result, you can then respond with text.");
      parts.push("");

      // Build available actions list
      const availableActions = this.getAvailableActions();
      parts.push("Available tools:");
      parts.push(formatActionsForPrompt(availableActions));
      parts.push("");
      parts.push("If you don't need a tool, just respond normally with text.");
    }

    return parts.join("\n");
  }

  /**
   * Get the current set of available actions (core + dynamically loaded categories).
   */
  private getAvailableActions(): string[] {
    const actions = new Set(CHAT_ACTIONS);

    // Add dynamically loaded category tools
    for (const category of this.loadedCategories) {
      const tools = getToolsInCategory(category);
      for (const toolName of tools) {
        actions.add(toolName);
      }
    }

    return Array.from(actions);
  }

  /**
   * Call the LLM — via user-provided function or runtime.economy.inference().
   */
  private async callLLM(messages: InferenceMessage[]): Promise<string> {
    if (this.options.generateResponse) {
      return this.options.generateResponse(messages);
    }

    const result = await this.runtime.economy.inference(messages, {
      model: this.options.model,
      provider: this.options.provider,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
    });

    return result.content;
  }

  /**
   * Execute a tool via the gateway's unified dispatch pipeline.
   *
   * Same flow as AutonomousAgent.handleActionRequest():
   * - browse_tools → local category expansion
   * - POST /v1/actions/execute → completed | sign_required | error
   */
  private async executeTool(actionType: string, payload: Record<string, unknown>): Promise<string> {
    try {
      // browse_tools is handled locally
      if (actionType === "browse_tools") {
        const category = payload.category as string | undefined;
        if (!category) {
          const listing = getCategoryListing();
          return `Available tool categories:\n${listing.map((c) => `- ${c.name} (${c.count} tools)`).join("\n")}\n\nUse browse_tools with a category to load those tools.`;
        }
        this.loadedCategories.add(category);
        const tools = getToolsInCategory(category);
        const toolDescriptions = tools.map((toolName) => {
          const info = ACTION_CATALOG[toolName];
          return info ? `- ${toolName}: ${info.description}` : `- ${toolName}`;
        });
        return `Loaded ${tools.length} tools from "${category}":\n${toolDescriptions.join("\n")}`;
      }

      // Unified dispatch via gateway
      const toolName = `nookplot_${actionType}`;
      const dispatchResult = await this.runtime.connection.request<{
        status: string;
        result?: unknown;
        error?: string;
        forwardRequest?: Record<string, unknown>;
        domain?: Record<string, unknown>;
        types?: Record<string, unknown>;
      }>("POST", "/v1/actions/execute", { toolName, payload });

      switch (dispatchResult.status) {
        case "completed": {
          const result = dispatchResult.result ?? {};
          return typeof result === "string" ? result : JSON.stringify(result, null, 2);
        }

        case "sign_required": {
          // On-chain action: sign locally + relay
          if (!dispatchResult.forwardRequest || !dispatchResult.domain || !dispatchResult.types) {
            return `Error: sign_required but missing signing data for ${actionType}`;
          }
          const privateKey = this.runtime.connection.privateKey;
          if (!privateKey) {
            return `Error: Cannot sign on-chain transaction — no private key configured.`;
          }
          const { signForwardRequest } = await import("../signing.js");
          const signature = await signForwardRequest(
            privateKey,
            dispatchResult.domain,
            dispatchResult.types,
            dispatchResult.forwardRequest,
          );
          const relayResult = await this.runtime.connection.request<{ txHash: string }>(
            "POST",
            "/v1/relay",
            { ...dispatchResult.forwardRequest, signature },
          );
          return `On-chain transaction submitted. TX hash: ${relayResult.txHash}`;
        }

        default:
          return dispatchResult.error
            ? `Error: ${dispatchResult.error}`
            : `Unexpected status: ${dispatchResult.status}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.options.verbose) console.error(`[chat] Tool execution failed: ${msg}`);
      return `Error executing ${actionType}: ${msg}`;
    }
  }
}
