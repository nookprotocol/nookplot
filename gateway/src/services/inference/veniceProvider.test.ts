import { describe, it, expect, vi } from "vitest";
import { VeniceProvider } from "./veniceProvider.js";

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
    requestId: "test-req-1",
    model: "llama-3.3-70b",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 100,
    temperature: 0.7,
    stream: false,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
//  Basic properties
// ---------------------------------------------------------------------------

describe("VeniceProvider — basics", () => {
  it("has name 'venice'", () => {
    const provider = new VeniceProvider();
    expect(provider.name).toBe("venice");
  });

  it("listModels returns curated model list", () => {
    const provider = new VeniceProvider();
    const models = provider.listModels();
    expect(models.length).toBe(5);
    expect(models.every((m) => m.provider === "venice")).toBe(true);
    expect(models.map((m) => m.model)).toContain("llama-3.3-70b");
    expect(models.map((m) => m.model)).toContain("deepseek-v3.2");
    expect(models.map((m) => m.model)).toContain("venice-uncensored");
    expect(models.map((m) => m.model)).toContain("qwen3-235b-a22b-instruct-2507");
    expect(models.map((m) => m.model)).toContain("qwen3-coder-480b-a35b-instruct");
  });

  it("isValidModel always returns true", () => {
    const provider = new VeniceProvider();
    expect(provider.isValidModel("llama-3.3-70b")).toBe(true);
    expect(provider.isValidModel("some-unknown-model")).toBe(true);
    expect(provider.isValidModel("anything")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  chat
// ---------------------------------------------------------------------------

describe("VeniceProvider — chat", () => {
  it("returns parsed response", async () => {
    const provider = new VeniceProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Hi there!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
      model: "llama-3.3-70b",
    });

    const result = await provider.chat(makeRequest(), "venice-test-key");

    expect(result.content).toBe("Hi there!");
    expect(result.promptTokens).toBe(8);
    expect(result.completionTokens).toBe(3);
    expect(result.finishReason).toBe("stop");
    expect(result.model).toBe("llama-3.3-70b");
  });

  it("handles missing content gracefully", async () => {
    const provider = new VeniceProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: {}, finish_reason: null }],
      usage: {},
      model: "llama-3.3-70b",
    });

    const result = await provider.chat(makeRequest(), "venice-test-key");
    expect(result.content).toBe("");
    expect(result.promptTokens).toBe(0);
  });

  it("passes providerParams as venice_parameters", async () => {
    const provider = new VeniceProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "search result" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: "llama-3.3-70b",
    });

    const request = makeRequest({
      providerParams: { enable_web_search: true, strip_thinking_response: true },
    });

    await provider.chat(request, "venice-test-key");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        venice_parameters: { enable_web_search: true, strip_thinking_response: true },
      }),
    );
  });

  it("does not include venice_parameters when providerParams is undefined", async () => {
    const provider = new VeniceProvider();

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
      model: "llama-3.3-70b",
    });

    await provider.chat(makeRequest(), "venice-test-key");

    const callArg = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    expect(callArg).not.toHaveProperty("venice_parameters");
  });
});

// ---------------------------------------------------------------------------
//  chatStream
// ---------------------------------------------------------------------------

describe("VeniceProvider — chatStream", () => {
  it("yields deltas then final chunk with usage", async () => {
    const provider = new VeniceProvider();

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
    for await (const chunk of provider.chatStream(makeRequest(), "venice-test-key")) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].delta).toBe("Hello");
    expect(chunks[0].done).toBe(false);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.done).toBe(true);
    expect((lastChunk.usage as any).promptTokens).toBe(10);
    expect((lastChunk.usage as any).completionTokens).toBe(5);
  });

  it("passes providerParams as venice_parameters in stream", async () => {
    const provider = new VeniceProvider();

    const streamData = [
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
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

    const request = makeRequest({
      providerParams: { enable_web_search: true },
    });

    // Consume the stream
    for await (const _chunk of provider.chatStream(request, "venice-test-key")) {
      // drain
    }

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        venice_parameters: { enable_web_search: true },
      }),
    );
  });
});
