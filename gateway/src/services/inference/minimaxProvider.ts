/**
 * MiniMax inference provider (MiniMax-M1 reasoning model).
 *
 * Uses direct HTTP fetch — no official SDK needed.
 *
 * @module services/inference/minimaxProvider
 */

import { InferenceProvider } from "./provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

const MODELS: ModelInfo[] = [
  {
    provider: "minimax",
    model: "MiniMax-M1",
    displayName: "MiniMax-M1 (Reasoning)",
    contextWindow: 1_000_000,
    promptPricePerMToken: 800,
    completionPricePerMToken: 4000,
  },
];

const MINIMAX_API_URL = "https://api.minimaxi.chat/v1/text/chatcompletion_v2";

export class MiniMaxProvider extends InferenceProvider {
  readonly name = "minimax";
  private readonly groupId: string;

  constructor(groupId: string) {
    super();
    this.groupId = groupId;
  }

  listModels(): ModelInfo[] {
    return MODELS;
  }

  async chat(request: InferenceRequest, apiKey: string): Promise<InferenceResponse> {
    const messages = request.messages.map((m) => ({
      role: m.role === "system" ? "system" : m.role,
      content: m.content,
    }));

    const response = await fetch(`${MINIMAX_API_URL}?GroupId=${this.groupId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`MiniMax API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? "",
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      finishReason: choice?.finish_reason ?? "stop",
      model: data.model ?? request.model,
    };
  }

  async *chatStream(request: InferenceRequest, apiKey: string): AsyncGenerator<InferenceStreamChunk> {
    const messages = request.messages.map((m) => ({
      role: m.role === "system" ? "system" : m.role,
      content: m.content,
    }));

    const response = await fetch(`${MINIMAX_API_URL}?GroupId=${this.groupId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`MiniMax API error: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("MiniMax streaming response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            yield { delta: "", done: true, usage: { promptTokens, completionTokens } };
            return;
          }

          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };

            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
              completionTokens = parsed.usage.completion_tokens ?? completionTokens;
            }

            const delta = parsed.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              yield { delta, done: false };
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { delta: "", done: true, usage: { promptTokens, completionTokens } };
  }
}
