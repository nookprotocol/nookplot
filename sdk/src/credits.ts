/**
 * Inference client — thin HTTP wrapper around gateway credit + inference endpoints.
 *
 * @module credits
 */

import type {
  CreditAccountInfo,
  CreditTransaction,
  CreditUsageSummary,
  InferenceMessage,
  InferenceOptions,
  InferenceResult,
  InferenceModel,
  InferenceLogEntry,
  ByokStatus,
} from "./types.js";

export class InferenceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(gatewayUrl: string, apiKey: string) {
    this.baseUrl = gatewayUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  // -------------------------------------------------------
  //  Credits
  // -------------------------------------------------------

  async getBalance(): Promise<CreditAccountInfo> {
    return this.get("/v1/credits/balance");
  }

  async topUp(amount: number): Promise<{ balanceAfter: number; amountAdded: number }> {
    return this.post("/v1/credits/top-up", { amount });
  }

  async getUsage(days = 30): Promise<CreditUsageSummary> {
    return this.get(`/v1/credits/usage?days=${days}`);
  }

  async getTransactions(limit = 20, offset = 0): Promise<{ transactions: CreditTransaction[]; limit: number; offset: number }> {
    return this.get(`/v1/credits/transactions?limit=${limit}&offset=${offset}`);
  }

  async setAutoConvert(percentage: number): Promise<{ autoConvertPct: number }> {
    return this.post("/v1/credits/auto-convert", { percentage });
  }

  // -------------------------------------------------------
  //  Inference
  // -------------------------------------------------------

  async chat(
    provider: string,
    model: string,
    messages: InferenceMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResult> {
    return this.post("/v1/inference/chat", {
      provider,
      model,
      messages,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
    });
  }

  async *streamChat(
    provider: string,
    model: string,
    messages: InferenceMessage[],
    options?: InferenceOptions,
  ): AsyncGenerator<{ delta: string; done: boolean; usage?: { promptTokens: number; completionTokens: number } }> {
    const response = await fetch(`${this.baseUrl}/v1/inference/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        provider,
        model,
        messages,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Inference stream failed (${response.status}): ${errorBody}`);
    }

    if (!response.body) {
      throw new Error("No response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          if (payload === "[DONE]") return;

          try {
            yield JSON.parse(payload);
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<InferenceModel[]> {
    const data = await this.get<{ models: InferenceModel[] }>("/v1/inference/models");
    return data.models;
  }

  async getHistory(limit = 20, offset = 0): Promise<{ history: InferenceLogEntry[]; limit: number; offset: number }> {
    return this.get(`/v1/inference/history?limit=${limit}&offset=${offset}`);
  }

  // -------------------------------------------------------
  //  BYOK
  // -------------------------------------------------------

  async storeByokKey(provider: string, apiKey: string): Promise<{ provider: string; stored: boolean }> {
    return this.post("/v1/byok", { provider, apiKey });
  }

  async removeByokKey(provider: string): Promise<{ provider: string; removed: boolean }> {
    return this.delete(`/v1/byok/${provider}`);
  }

  async listByokProviders(): Promise<ByokStatus[]> {
    const data = await this.get<{ providers: ByokStatus[] }>("/v1/byok");
    return data.providers;
  }

  // -------------------------------------------------------
  //  HTTP helpers
  // -------------------------------------------------------

  private async get<T = Record<string, unknown>>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gateway request failed (${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  private async post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gateway request failed (${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  private async delete<T = Record<string, unknown>>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gateway request failed (${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }
}
