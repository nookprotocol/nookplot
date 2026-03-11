import { describe, it, expect, vi, beforeEach } from "vitest";
import { MiniMaxProvider } from "./minimaxProvider.js";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const TEST_GROUP_ID = "group_123";
const TEST_API_KEY = "mm_test_key";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "MiniMax-M1",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 100,
    temperature: 0.7,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
//  Basic properties
// ---------------------------------------------------------------------------

describe("MiniMaxProvider — basics", () => {
  it("has name 'minimax'", () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);
    expect(provider.name).toBe("minimax");
  });

  it("listModels returns MiniMax-M1", () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);
    const models = provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].model).toBe("MiniMax-M1");
    expect(models[0].contextWindow).toBe(1_000_000);
  });

  it("isValidModel returns true for MiniMax-M1", () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);
    expect(provider.isValidModel("MiniMax-M1")).toBe(true);
    expect(provider.isValidModel("gpt-4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  chat
// ---------------------------------------------------------------------------

describe("MiniMaxProvider — chat", () => {
  it("returns parsed response on success", async () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: "Hello back!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: "MiniMax-M1",
      }),
    }));

    const result = await provider.chat(makeRequest(), TEST_API_KEY);

    expect(result.content).toBe("Hello back!");
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
    expect(result.finishReason).toBe("stop");

    // Verify fetch was called with correct URL containing GroupId
    const fetchCall = (fetch as any).mock.calls[0];
    expect(fetchCall[0]).toContain("GroupId=group_123");
    expect(fetchCall[1].headers.Authorization).toBe("Bearer mm_test_key");
  });

  it("throws on non-OK response", async () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
    }));

    await expect(provider.chat(makeRequest(), TEST_API_KEY))
      .rejects.toThrow("MiniMax API error: 429");
  });

  it("handles missing fields gracefully", async () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}), // No choices/usage
    }));

    const result = await provider.chat(makeRequest(), TEST_API_KEY);
    expect(result.content).toBe("");
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  chatStream
// ---------------------------------------------------------------------------

describe("MiniMaxProvider — chatStream", () => {
  it("yields deltas then final chunk with usage", async () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);

    const lines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}],"usage":null}',
      'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      "data: [DONE]",
    ].join("\n") + "\n";

    const encoder = new TextEncoder();
    // ReadableStream is available globally in Node 18+ but not in TS ES2022 lib
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RS = (globalThis as any).ReadableStream as { new(init: { start(c: { enqueue(v: Uint8Array): void; close(): void }): void }): unknown };
    const stream = new RS({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      body: stream,
    }));

    const chunks: Array<{ delta: string; done: boolean; usage?: unknown }> = [];
    for await (const chunk of provider.chatStream(makeRequest(), TEST_API_KEY)) {
      chunks.push(chunk);
    }

    // "Hello", " world", then [DONE] final chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].delta).toBe("Hello");
    expect(chunks[0].done).toBe(false);
    expect(chunks[1].delta).toBe(" world");

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.done).toBe(true);
    expect((lastChunk.usage as any).promptTokens).toBe(10);
  });

  it("throws on non-OK stream response", async () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    }));

    const gen = provider.chatStream(makeRequest(), TEST_API_KEY);
    await expect(gen.next()).rejects.toThrow("MiniMax API error: 500");
  });

  it("throws when response body is null", async () => {
    const provider = new MiniMaxProvider(TEST_GROUP_ID);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      body: null,
    }));

    const gen = provider.chatStream(makeRequest(), TEST_API_KEY);
    await expect(gen.next()).rejects.toThrow("no body");
  });
});
