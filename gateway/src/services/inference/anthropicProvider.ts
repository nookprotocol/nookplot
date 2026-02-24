/**
 * Anthropic inference provider (Claude models).
 *
 * @module services/inference/anthropicProvider
 */

import Anthropic from "@anthropic-ai/sdk";
import { InferenceProvider } from "./provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

const MODELS: ModelInfo[] = [
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    promptPricePerMToken: 3000,
    completionPricePerMToken: 15000,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    promptPricePerMToken: 800,
    completionPricePerMToken: 4000,
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    contextWindow: 200_000,
    promptPricePerMToken: 15000,
    completionPricePerMToken: 75000,
  },
];

export class AnthropicProvider extends InferenceProvider {
  readonly name = "anthropic";

  listModels(): ModelInfo[] {
    return MODELS;
  }

  async chat(request: InferenceRequest, apiKey: string): Promise<InferenceResponse> {
    const client = new Anthropic({ apiKey });

    // Extract system message if present
    const systemMessage = request.messages.find((m) => m.role === "system")?.content;
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const response = await client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: systemMessage,
      messages,
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      content: textContent,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      finishReason: response.stop_reason ?? "end_turn",
      model: response.model,
    };
  }

  async *chatStream(request: InferenceRequest, apiKey: string): AsyncGenerator<InferenceStreamChunk> {
    const client = new Anthropic({ apiKey });

    const systemMessage = request.messages.find((m) => m.role === "system")?.content;
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const stream = client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: systemMessage,
      messages,
    });

    let promptTokens = 0;
    let completionTokens = 0;

    for await (const event of stream) {
      if (event.type === "message_start" && event.message.usage) {
        promptTokens = event.message.usage.input_tokens;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { delta: event.delta.text, done: false };
      } else if (event.type === "message_delta" && event.usage) {
        completionTokens = event.usage.output_tokens;
      }
    }

    yield {
      delta: "",
      done: true,
      usage: { promptTokens, completionTokens },
    };
  }
}
