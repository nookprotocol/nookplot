/**
 * Inference proxy — orchestration layer tying providers + credits + BYOK.
 *
 * Flow: validate → check credits → deduct → resolve key → call provider →
 * adjust credits on actual cost → log to inference_log.
 *
 * @module services/inferenceProxy
 */

import crypto from "crypto";
import type pg from "pg";
import type { CreditManager } from "./creditManager.js";
import type { ByokManager } from "./byokManager.js";
import type { InferenceProvider } from "./inference/provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./inference/types.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Sliding window counter (dual-window approximation)
// ============================================================

interface WindowData {
  count: number;
  tokens: number;
}

/**
 * In-memory sliding window rate limiter using dual-window approximation.
 * Avoids per-request DB queries against inference_log for rate limit checks.
 *
 * How it works: maintains two fixed windows (current + previous). The
 * effective count is: previous * (1 - elapsed/windowMs) + current.
 * This gives a smooth sliding window approximation without per-request storage.
 */
class SlidingWindowCounter {
  private readonly windowMs: number;
  private windowStart: number;
  private current: Map<string, WindowData> = new Map();
  private previous: Map<string, WindowData> = new Map();

  constructor(windowMs: number) {
    this.windowMs = windowMs;
    this.windowStart = Date.now();
  }

  /** Record a request and token usage for the given key. */
  record(key: string, tokens: number): void {
    this.maybeRotate();
    const entry = this.current.get(key) ?? { count: 0, tokens: 0 };
    entry.count += 1;
    entry.tokens += tokens;
    this.current.set(key, entry);
  }

  /** Get the weighted count and token total for the given key. */
  get(key: string): { count: number; tokens: number } {
    this.maybeRotate();
    const now = Date.now();
    const elapsed = now - this.windowStart;
    const weight = Math.max(0, 1 - elapsed / this.windowMs);

    const prev = this.previous.get(key) ?? { count: 0, tokens: 0 };
    const curr = this.current.get(key) ?? { count: 0, tokens: 0 };

    return {
      count: Math.floor(prev.count * weight + curr.count),
      tokens: Math.floor(prev.tokens * weight + curr.tokens),
    };
  }

  /** Rotate windows if the current window has expired. */
  private maybeRotate(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.previous = this.current;
      this.current = new Map();
      this.windowStart = now;
    }
  }
}

// ============================================================
//  Types
// ============================================================

export interface InferenceProxyConfig {
  /** Default API keys per provider (gateway-level). */
  defaultKeys: Record<string, string>;
  /** Request timeout in ms. */
  requestTimeoutMs: number;
  /** Per-agent rate limits. */
  rateLimitRpm: number;
  rateLimitTpm: number;
}

export interface InferenceLogEntry {
  id: string;
  requestId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCredits: number;
  durationMs: number | null;
  status: string;
  createdAt: string;
}

// ============================================================
//  InferenceProxy
// ============================================================

export class InferenceProxy {
  private readonly pool: pg.Pool;
  private readonly creditManager: CreditManager;
  private readonly byokManager: ByokManager;
  private readonly config: InferenceProxyConfig;
  private readonly providers: Map<string, InferenceProvider> = new Map();
  private readonly rateLimitWindow: SlidingWindowCounter;

  constructor(
    pool: pg.Pool,
    creditManager: CreditManager,
    byokManager: ByokManager,
    config: InferenceProxyConfig,
  ) {
    this.pool = pool;
    this.creditManager = creditManager;
    this.byokManager = byokManager;
    this.config = config;
    this.rateLimitWindow = new SlidingWindowCounter(60_000);
  }

  /** Register a provider implementation. */
  registerProvider(provider: InferenceProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Get a registered provider by name. */
  getProvider(name: string): InferenceProvider | undefined {
    return this.providers.get(name);
  }

  /** List all available models across all registered providers. */
  listAllModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.listModels());
    }
    return models;
  }

  /**
   * Synchronous inference (full response).
   */
  async chat(
    agentId: string,
    providerName: string,
    request: InferenceRequest,
  ): Promise<InferenceResponse> {
    const startTime = Date.now();
    const requestId = request.requestId || crypto.randomUUID();

    // 1. Validate provider + model
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }
    if (!provider.isValidModel(request.model)) {
      throw new Error(`Invalid model '${request.model}' for provider '${providerName}'`);
    }

    // 2. Check credit account status
    const account = await this.creditManager.getBalance(agentId);
    if (!account) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }
    if (account.status === "paused") {
      throw new Error("ACCOUNT_PAUSED");
    }

    // 3. Check rate limits (in-memory sliding window — no DB query)
    this.checkRateLimits(agentId);

    // 4. Estimate cost and pre-deduct
    const estimatedPromptTokens = this.estimatePromptTokens(request);
    const estimatedCost = this.creditManager.calculateCost(
      providerName,
      request.model,
      estimatedPromptTokens,
      request.maxTokens,
    );

    if (estimatedCost > 0) {
      await this.creditManager.deductCredits(agentId, estimatedCost, requestId);
    }

    // 5. Resolve API key (BYOK first, then gateway default)
    const apiKey = await this.resolveApiKey(agentId, providerName);
    if (!apiKey) {
      // Refund if no key available
      if (estimatedCost > 0) {
        await this.creditManager.addCredits(agentId, estimatedCost, "refund", requestId);
      }
      throw new Error(`No API key available for provider '${providerName}'`);
    }

    // 6. Call provider
    let response: InferenceResponse;
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("INFERENCE_TIMEOUT")), this.config.requestTimeoutMs),
      );
      response = await Promise.race([provider.chat(request, apiKey), timeoutPromise]);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      // Refund estimated cost on failure
      if (estimatedCost > 0) {
        await this.creditManager.addCredits(agentId, estimatedCost, "refund", requestId);
      }

      // Log failure
      await this.logInference(agentId, requestId, providerName, request.model, 0, 0, 0, durationMs, "error", message);

      throw error;
    }

    // 7. Adjust credits: refund estimate, charge actual
    const actualCost = this.creditManager.calculateCost(
      providerName,
      request.model,
      response.promptTokens,
      response.completionTokens,
    );

    if (estimatedCost > 0 && actualCost !== estimatedCost) {
      // Refund the estimate
      await this.creditManager.addCredits(agentId, estimatedCost, "refund_estimate", requestId);
      // Charge actual
      if (actualCost > 0) {
        await this.creditManager.deductCredits(agentId, actualCost, requestId);
      }
    }

    // 8. Record in sliding window for rate limiting + log success
    this.rateLimitWindow.record(agentId, response.promptTokens + response.completionTokens);
    const durationMs = Date.now() - startTime;
    await this.logInference(
      agentId,
      requestId,
      providerName,
      request.model,
      response.promptTokens,
      response.completionTokens,
      actualCost,
      durationMs,
      "success",
    );

    return response;
  }

  /**
   * Streaming inference (SSE chunks).
   */
  async *chatStream(
    agentId: string,
    providerName: string,
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamChunk> {
    const startTime = Date.now();
    const requestId = request.requestId || crypto.randomUUID();

    // 1. Validate provider + model
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }
    if (!provider.isValidModel(request.model)) {
      throw new Error(`Invalid model '${request.model}' for provider '${providerName}'`);
    }

    // 2. Check credit account status
    const account = await this.creditManager.getBalance(agentId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    if (account.status === "paused") throw new Error("ACCOUNT_PAUSED");

    // 3. Rate limits (in-memory sliding window — no DB query)
    this.checkRateLimits(agentId);

    // 4. Estimate cost and pre-deduct
    const estimatedPromptTokens = this.estimatePromptTokens(request);
    const estimatedCost = this.creditManager.calculateCost(
      providerName,
      request.model,
      estimatedPromptTokens,
      request.maxTokens,
    );

    if (estimatedCost > 0) {
      await this.creditManager.deductCredits(agentId, estimatedCost, requestId);
    }

    // 5. Resolve API key
    const apiKey = await this.resolveApiKey(agentId, providerName);
    if (!apiKey) {
      if (estimatedCost > 0) {
        await this.creditManager.addCredits(agentId, estimatedCost, "refund", requestId);
      }
      throw new Error(`No API key available for provider '${providerName}'`);
    }

    // 6. Stream from provider
    let promptTokens = 0;
    let completionTokens = 0;
    let errored = false;

    try {
      const stream = provider.chatStream(request, apiKey);

      for await (const chunk of stream) {
        if (chunk.done && chunk.usage) {
          promptTokens = chunk.usage.promptTokens;
          completionTokens = chunk.usage.completionTokens;
        }
        yield chunk;
      }
    } catch (error) {
      errored = true;
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      if (estimatedCost > 0) {
        await this.creditManager.addCredits(agentId, estimatedCost, "refund", requestId);
      }

      await this.logInference(agentId, requestId, providerName, request.model, 0, 0, 0, durationMs, "error", message);
      throw error;
    }

    if (!errored) {
      // 7. Adjust credits
      const actualCost = this.creditManager.calculateCost(
        providerName,
        request.model,
        promptTokens,
        completionTokens,
      );

      if (estimatedCost > 0 && actualCost !== estimatedCost) {
        await this.creditManager.addCredits(agentId, estimatedCost, "refund_estimate", requestId);
        if (actualCost > 0) {
          await this.creditManager.deductCredits(agentId, actualCost, requestId);
        }
      }

      // 8. Record in sliding window for rate limiting + log success
      this.rateLimitWindow.record(agentId, promptTokens + completionTokens);
      const durationMs = Date.now() - startTime;
      await this.logInference(
        agentId,
        requestId,
        providerName,
        request.model,
        promptTokens,
        completionTokens,
        actualCost,
        durationMs,
        "success",
      );
    }
  }

  /**
   * Get inference history for an agent.
   */
  async getHistory(
    agentId: string,
    limit: number,
    offset: number,
  ): Promise<InferenceLogEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      request_id: string;
      provider: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_credits: string;
      duration_ms: number | null;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, request_id, provider, model, prompt_tokens, completion_tokens,
              cost_credits, duration_ms, status, created_at
       FROM inference_log
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset],
    );

    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      provider: r.provider,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      costCredits: Number(r.cost_credits),
      durationMs: r.duration_ms,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    }));
  }

  // -------------------------------------------------------
  //  Private helpers
  // -------------------------------------------------------

  private async resolveApiKey(agentId: string, provider: string): Promise<string | null> {
    // BYOK first
    const byokKey = await this.byokManager.getKey(agentId, provider);
    if (byokKey) return byokKey;

    // Gateway default
    return this.config.defaultKeys[provider] || null;
  }

  private estimatePromptTokens(request: InferenceRequest): number {
    // Rough estimate: 1 token ~ 4 chars
    const totalChars = request.messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
  }

  private checkRateLimits(agentId: string): void {
    const { count, tokens } = this.rateLimitWindow.get(agentId);

    if (count >= this.config.rateLimitRpm) {
      throw new Error("RATE_LIMIT_RPM");
    }
    if (tokens >= this.config.rateLimitTpm) {
      throw new Error("RATE_LIMIT_TPM");
    }
  }

  private async logInference(
    agentId: string,
    requestId: string,
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
    costCredits: number,
    durationMs: number,
    status: string,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO inference_log
         (agent_id, request_id, provider, model, prompt_tokens, completion_tokens, cost_credits, duration_ms, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [agentId, requestId, provider, model, promptTokens, completionTokens, costCredits, durationMs, status, errorMessage ?? null],
      );
    } catch (err) {
      // Don't fail the request if logging fails
      logSecurityEvent("error", "inference-log-failed", {
        agentId,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
