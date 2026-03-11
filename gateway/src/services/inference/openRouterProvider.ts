/**
 * OpenRouter inference provider — unified API gateway for 300+ models.
 *
 * BYOK-only: agents bring their own OpenRouter API key.
 * OpenAI-SDK-compatible, so we reuse the `openai` package with a custom baseURL.
 *
 * @module services/inference/openRouterProvider
 */

import OpenAI from "openai";
import { InferenceProvider } from "./provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

/** Curated subset of popular models for the /v1/inference/models listing. */
const MODELS: ModelInfo[] = [
  {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    contextWindow: 200_000,
    promptPricePerMToken: 3000,
    completionPricePerMToken: 15000,
  },
  {
    provider: "openrouter",
    model: "anthropic/claude-haiku-4",
    displayName: "Claude Haiku 4",
    contextWindow: 200_000,
    promptPricePerMToken: 800,
    completionPricePerMToken: 4000,
  },
  {
    provider: "openrouter",
    model: "openai/gpt-4o",
    displayName: "GPT-4o (via OpenRouter)",
    contextWindow: 128_000,
    promptPricePerMToken: 2500,
    completionPricePerMToken: 10000,
  },
  {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    displayName: "GPT-4o Mini (via OpenRouter)",
    contextWindow: 128_000,
    promptPricePerMToken: 150,
    completionPricePerMToken: 600,
  },
  {
    provider: "openrouter",
    model: "google/gemini-2.5-pro-preview",
    displayName: "Gemini 2.5 Pro (via OpenRouter)",
    contextWindow: 1_000_000,
    promptPricePerMToken: 1250,
    completionPricePerMToken: 10000,
  },
  {
    provider: "openrouter",
    model: "google/gemini-2.5-flash-preview",
    displayName: "Gemini 2.5 Flash (via OpenRouter)",
    contextWindow: 1_000_000,
    promptPricePerMToken: 150,
    completionPricePerMToken: 600,
  },
  {
    provider: "openrouter",
    model: "meta-llama/llama-4-maverick",
    displayName: "Llama 4 Maverick (via OpenRouter)",
    contextWindow: 1_000_000,
    promptPricePerMToken: 500,
    completionPricePerMToken: 2500,
  },
  {
    provider: "openrouter",
    model: "deepseek/deepseek-r1",
    displayName: "DeepSeek R1 (via OpenRouter)",
    contextWindow: 64_000,
    promptPricePerMToken: 550,
    completionPricePerMToken: 2190,
  },
  {
    provider: "openrouter",
    model: "deepseek/deepseek-chat-v3",
    displayName: "DeepSeek V3 (via OpenRouter)",
    contextWindow: 64_000,
    promptPricePerMToken: 300,
    completionPricePerMToken: 880,
  },
];

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends InferenceProvider {
  readonly name = "openrouter";

  listModels(): ModelInfo[] {
    return MODELS;
  }

  /** Accept any model string — OpenRouter handles validation. */
  isValidModel(_model: string): boolean {
    return true;
  }

  async chat(request: InferenceRequest, apiKey: string): Promise<InferenceResponse> {
    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://nookplot.com",
        "X-Title": "Nookplot",
      },
    });

    const messages = request.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    const response = await client.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    });

    const choice = response.choices[0];

    return {
      content: choice?.message?.content ?? "",
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      finishReason: choice?.finish_reason ?? "stop",
      model: response.model,
    };
  }

  async *chatStream(request: InferenceRequest, apiKey: string): AsyncGenerator<InferenceStreamChunk> {
    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://nookplot.com",
        "X-Title": "Nookplot",
      },
    });

    const messages = request.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    const stream = await client.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      stream_options: { include_usage: true },
    });

    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      const done = chunk.choices[0]?.finish_reason !== null && chunk.choices[0]?.finish_reason !== undefined;

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }

      if (delta) {
        yield { delta, done: false };
      }

      if (done) {
        break;
      }
    }

    yield {
      delta: "",
      done: true,
      usage: { promptTokens, completionTokens },
    };
  }
}
