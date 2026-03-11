/**
 * Venice AI inference provider — OpenAI-compatible API with uncensored models.
 *
 * Supports provider-specific parameters (web search, thinking, etc.) via
 * `providerParams` → `venice_parameters` on the request body.
 *
 * @module services/inference/veniceProvider
 */

import OpenAI from "openai";
import { InferenceProvider } from "./provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

/** Curated subset of Venice models for the /v1/inference/models listing. */
const MODELS: ModelInfo[] = [
  {
    provider: "venice",
    model: "llama-3.3-70b",
    displayName: "Llama 3.3 70B (Venice)",
    contextWindow: 128_000,
    promptPricePerMToken: 700,
    completionPricePerMToken: 2800,
  },
  {
    provider: "venice",
    model: "deepseek-v3.2",
    displayName: "DeepSeek V3.2 (Venice)",
    contextWindow: 160_000,
    promptPricePerMToken: 400,
    completionPricePerMToken: 1000,
  },
  {
    provider: "venice",
    model: "qwen3-235b-a22b-instruct-2507",
    displayName: "Qwen3 235B (Venice)",
    contextWindow: 128_000,
    promptPricePerMToken: 150,
    completionPricePerMToken: 750,
  },
  {
    provider: "venice",
    model: "venice-uncensored",
    displayName: "Venice Uncensored",
    contextWindow: 32_000,
    promptPricePerMToken: 200,
    completionPricePerMToken: 900,
  },
  {
    provider: "venice",
    model: "qwen3-coder-480b-a35b-instruct",
    displayName: "Qwen3 Coder 480B (Venice)",
    contextWindow: 256_000,
    promptPricePerMToken: 750,
    completionPricePerMToken: 3000,
  },
];

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";

export class VeniceProvider extends InferenceProvider {
  readonly name = "venice";

  listModels(): ModelInfo[] {
    return MODELS;
  }

  /** Accept any model string — Venice proxies many models. */
  isValidModel(_model: string): boolean {
    return true;
  }

  async chat(request: InferenceRequest, apiKey: string): Promise<InferenceResponse> {
    const client = new OpenAI({
      apiKey,
      baseURL: VENICE_BASE_URL,
    });

    const messages = request.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    };

    // Venice-specific params flow through as extra body fields
    const extraBody = request.providerParams
      ? { venice_parameters: request.providerParams }
      : undefined;

    const response = await client.chat.completions.create(
      extraBody ? { ...params, ...extraBody } as typeof params : params,
    );

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
      baseURL: VENICE_BASE_URL,
    });

    const messages = request.messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };

    const extraBody = request.providerParams
      ? { venice_parameters: request.providerParams }
      : undefined;

    const stream = await client.chat.completions.create(
      extraBody ? { ...params, ...extraBody } as typeof params : params,
    );

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
