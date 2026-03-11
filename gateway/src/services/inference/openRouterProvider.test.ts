import { describe, it, expect, vi } from "vitest";
import { OpenRouterProvider } from "./openRouterProvider.js";

// Mock the OpenAI SDK
const mockCreate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  })),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 100,
    temperature: 0.7,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
//  Basic properties
// ---------------------------------------------------------------------------

describe("OpenRouterProvider — basics", () => {
  it("has name 'openrouter'", () => {
    const provider = new OpenRouterProvider();
    expect(provider.name).toBe("openrouter");
  });

  it("listModels returns curated model list", () => {
    const provider = new OpenRouterProvider();
    const models = provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(5);
    expect(models.every((m) => m.provider === "openrouter")).toBe(true);
    expect(models.map((m) => m.model)).toContain("anthropic/claude-sonnet-4");
    expect(models.map((m) => m.model)).toContain("openai/gpt-4o");
    expect(models.map((m) => m.model)).toContain("deepseek/deepseek-r1");
  });

  it("isValidModel always returns true", () => {
    const provider = new OpenRouterProvider();
    expect(provider.isValidModel("anthropic/claude-sonnet-4")).toBe(true);
    expect(provider.isValidModel("some-unknown/model-xyz")).toBe(true);
    expect(provider.isValidModel("anything")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  chat
// ---------------------------------------------------------------------------

describe("OpenRouterProvider — chat", () => {
  it("returns parsed response", async () => {
    const provider = new OpenRouterProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Hi there!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
      model: "anthropic/claude-sonnet-4",
    });

    const result = await provider.chat(makeRequest(), "sk-FAKE-or-test");

    expect(result.content).toBe("Hi there!");
    expect(result.promptTokens).toBe(8);
    expect(result.completionTokens).toBe(3);
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("anthropic/claude-sonnet-4");
  });

  it("handles missing content gracefully", async () => {
    const provider = new OpenRouterProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {}, finish_reason: null }],
      usage: {},
      model: "anthropic/claude-sonnet-4",
    });

    const result = await provider.chat(makeRequest(), "sk-FAKE-or-test");
    expect(result.content).toBe("");
    expect(result.promptTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  chatStream
// ---------------------------------------------------------------------------

describe("OpenRouterProvider — chatStream", () => {
  it("yields deltas then final chunk with usage", async () => {
    const provider = new OpenRouterProvider();

    const streamData = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: " world" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: () => {
        let idx = 0;
        return {
          next: () => {
            if (idx < streamData.length) {
              return Promise.resolve({ value: streamData[idx++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    });

    const chunks: Array<{ delta: string; done: boolean; usage?: unknown }> = [];
    for await (const chunk of provider.chatStream(makeRequest(), "sk-FAKE-or-test")) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].delta).toBe("Hello");
    expect(chunks[0].done).toBe(false);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.done).toBe(true);
    expect((lastChunk.usage as any).promptTokens).toBe(10);
  });
});
