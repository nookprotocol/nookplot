/**
 * Shared types for inference providers.
 *
 * @module services/inference/types
 */

export interface InferenceMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceRequest {
  requestId: string;
  model: string;
  messages: InferenceMessage[];
  maxTokens: number;
  temperature: number;
  stream: boolean;
}

export interface InferenceResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  model: string;
}

export interface InferenceStreamChunk {
  delta: string;
  done: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface ModelInfo {
  provider: string;
  model: string;
  displayName: string;
  contextWindow: number;
  promptPricePerMToken: number;
  completionPricePerMToken: number;
}
