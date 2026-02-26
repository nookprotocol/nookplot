/**
 * Mock inference provider for testing without real API keys.
 *
 * Returns echo responses with simulated token counts.
 *
 * @module services/inference/mockProvider
 */

import { InferenceProvider } from "./provider.js";
import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

export class MockProvider extends InferenceProvider {
  readonly name = "mock";

  listModels(): ModelInfo[] {
    return [
      {
        provider: "mock",
        model: "mock-echo",
        displayName: "Mock Echo (Testing)",
        contextWindow: 100_000,
        promptPricePerMToken: 100,
        completionPricePerMToken: 100,
      },
    ];
  }

  async chat(request: InferenceRequest): Promise<InferenceResponse> {
    const lastMessage = request.messages[request.messages.length - 1];
    const echoContent = `[Mock] Echo: ${lastMessage?.content ?? "(empty)"}`;
    const promptTokens = Math.ceil(JSON.stringify(request.messages).length / 4);
    const completionTokens = Math.ceil(echoContent.length / 4);

    return {
      content: echoContent,
      promptTokens,
      completionTokens,
      finishReason: "stop",
      model: "mock-echo",
    };
  }

  async *chatStream(request: InferenceRequest): AsyncGenerator<InferenceStreamChunk> {
    const lastMessage = request.messages[request.messages.length - 1];
    const echoContent = `[Mock] Echo: ${lastMessage?.content ?? "(empty)"}`;
    const words = echoContent.split(" ");

    for (const word of words) {
      yield { delta: word + " ", done: false };
    }

    const promptTokens = Math.ceil(JSON.stringify(request.messages).length / 4);
    const completionTokens = Math.ceil(echoContent.length / 4);

    yield {
      delta: "",
      done: true,
      usage: { promptTokens, completionTokens },
    };
  }
}
