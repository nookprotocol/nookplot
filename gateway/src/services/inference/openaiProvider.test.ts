import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "./openaiProvider.js";

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
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 100,
    temperature: 0.7,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
//  Basic properties
// ---------------------------------------------------------------------------

describe("OpenAIProvider — basics", () => {
  it("has name 'openai'", () => {
    const provider = new OpenAIProvider();
    expect(provider.name).toBe("openai");
  });

  it("listModels returns GPT models", () => {
    const provider = new OpenAIProvider();
    const models = provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.map(m => m.model)).toContain("gpt-4o");
    expect(models.map(m => m.model)).toContain("gpt-4o-mini");
    expect(models.map(m => m.model)).toContain("o3-mini");
  });

  it("isValidModel validates correctly", () => {
    const provider = new OpenAIProvider();
    expect(provider.isValidModel("gpt-4o")).toBe(true);
    expect(provider.isValidModel("claude-3")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  chat
// ---------------------------------------------------------------------------

describe("OpenAIProvider — chat", () => {
  it("returns parsed response", async () => {
    const provider = new OpenAIProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Hi there!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
      model: "gpt-4o",
    });

    const result = await provider.chat(makeRequest(), "sk-test");

    expect(result.content).toBe("Hi there!");
    expect(result.promptTokens).toBe(8);
    expect(result.completionTokens).toBe(3);
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("gpt-4o");
  });

  it("handles missing content gracefully", async () => {
    const provider = new OpenAIProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {}, finish_reason: null }],
      usage: {},
      model: "gpt-4o",
    });

    const result = await provider.chat(makeRequest(), "sk-test");
    expect(result.content).toBe("");
    expect(result.promptTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  chatStream
// ---------------------------------------------------------------------------

describe("OpenAIProvider — chatStream", () => {
  it("yields deltas then final chunk with usage", async () => {
    const provider = new OpenAIProvider();

    const streamData = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: " world" }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    // Mock the async iterator that OpenAI SDK returns for streaming
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
    for await (const chunk of provider.chatStream(makeRequest(), "sk-test")) {
      chunks.push(chunk);
    }

    // "Hello", " world" content chunks + final done chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].delta).toBe("Hello");
    expect(chunks[0].done).toBe(false);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.done).toBe(true);
    expect((lastChunk.usage as any).promptTokens).toBe(10);
  });
});
