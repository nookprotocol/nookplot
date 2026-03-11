import { describe, it, expect } from "vitest";
import { MockProvider } from "./mockProvider.js";

describe("MockProvider", () => {
  it("has name 'mock'", () => {
    const provider = new MockProvider();
    expect(provider.name).toBe("mock");
  });

  it("listModels returns mock-echo model", () => {
    const provider = new MockProvider();
    const models = provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].provider).toBe("mock");
    expect(models[0].model).toBe("mock-echo");
    expect(models[0].contextWindow).toBe(100_000);
  });

  it("isValidModel returns true for mock-echo", () => {
    const provider = new MockProvider();
    expect(provider.isValidModel("mock-echo")).toBe(true);
    expect(provider.isValidModel("gpt-4")).toBe(false);
  });

  it("chat echoes the last message", async () => {
    const provider = new MockProvider();
    const response = await provider.chat({
      model: "mock-echo",
      messages: [{ role: "user", content: "Hello world" }],
    } as any, "");

    expect(response.content).toBe("[Mock] Echo: Hello world");
    expect(response.finishReason).toBe("stop");
    expect(response.model).toBe("mock-echo");
    expect(response.promptTokens).toBeGreaterThan(0);
    expect(response.completionTokens).toBeGreaterThan(0);
  });

  it("chat handles empty messages", async () => {
    const provider = new MockProvider();
    const response = await provider.chat({
      model: "mock-echo",
      messages: [],
    } as any, "");

    expect(response.content).toBe("[Mock] Echo: (empty)");
  });

  it("chatStream yields words then final chunk with usage", async () => {
    const provider = new MockProvider();
    const chunks: Array<{ delta: string; done: boolean; usage?: unknown }> = [];

    for await (const chunk of provider.chatStream({
      model: "mock-echo",
      messages: [{ role: "user", content: "Hi" }],
    } as any, "")) {
      chunks.push(chunk);
    }

    // Should have word chunks + final done chunk
    expect(chunks.length).toBeGreaterThan(1);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.done).toBe(true);
    expect(lastChunk.usage).toBeDefined();
    expect((lastChunk.usage as any).promptTokens).toBeGreaterThan(0);

    // Non-final chunks should not be done
    const nonFinalChunks = chunks.slice(0, -1);
    for (const c of nonFinalChunks) {
      expect(c.done).toBe(false);
      expect(c.delta.length).toBeGreaterThan(0);
    }
  });
});
