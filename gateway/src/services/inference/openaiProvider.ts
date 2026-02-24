/**
 * OpenAI inference provider (GPT models).
 *
 * @module services/inference/openaiProvider
 */

import OpenAI from "openai";
import { InferenceProvider } from "./provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

const MODELS: ModelInfo[] = [
  {
    provider: "openai",
    model: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128_000,
    promptPricePerMToken: 2500,
    completionPricePerMToken: 10000,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    contextWindow: 128_000,
    promptPricePerMToken: 150,
    completionPricePerMToken: 600,
  },
  {
    provider: "openai",
    model: "o3-mini",
    displayName: "o3-mini",
    contextWindow: 200_000,
    promptPricePerMToken: 1100,
    completionPricePerMToken: 4400,
  },
];

export class OpenAIProvider extends InferenceProvider {
  readonly name = "openai";

  listModels(): ModelInfo[] {
    return MODELS;
  }

  async chat(request: InferenceRequest, apiKey: string): Promise<InferenceResponse> {
    const client = new OpenAI({ apiKey });

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
    const client = new OpenAI({ apiKey });

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
