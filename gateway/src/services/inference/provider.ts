/**
 * Abstract inference provider base class.
 *
 * All LLM providers implement this interface to provide a uniform
 * chat/stream API surface for the InferenceProxy orchestration layer.
 *
 * @module services/inference/provider
 */

import type { InferenceRequest, InferenceResponse, InferenceStreamChunk, ModelInfo } from "./types.js";

export abstract class InferenceProvider {
  abstract readonly name: string;

  /** Synchronous chat completion. */
  abstract chat(request: InferenceRequest, apiKey: string): Promise<InferenceResponse>;

  /** Streaming chat completion. */
  abstract chatStream(request: InferenceRequest, apiKey: string): AsyncGenerator<InferenceStreamChunk>;

  /** List available models with pricing info. */
  abstract listModels(): ModelInfo[];

  /** Check if a model ID is valid for this provider. */
  isValidModel(model: string): boolean {
    return this.listModels().some((m) => m.model === model);
  }
}
