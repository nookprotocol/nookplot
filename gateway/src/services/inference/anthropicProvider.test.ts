import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "./anthropicProvider.js";

// Mock the Anthropic SDK
const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: (...args: unknown[]) => mockMessagesCreate(...args),
      stream: (...args: unknown[]) => mockMessagesStream(...args),
    },
  })),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-4-5-20250929",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
    maxTokens: 100,
    temperature: 0.7,
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
//  Basic properties
// ---------------------------------------------------------------------------

describe("AnthropicProvider — basics", () => {
  it("has name 'anthropic'", () => {
    const provider = new AnthropicProvider();
    expect(provider.name).toBe("anthropic");
  });

  it("listModels returns Claude models", () => {
    const provider = new AnthropicProvider();
    const models = provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
    const modelIds = models.map(m => m.model);
    expect(modelIds).toContain("claude-sonnet-4-5-20250929");
    expect(modelIds).toContain("claude-haiku-4-5-20251001");
    expect(modelIds).toContain("claude-opus-4-6");
  });

  it("isValidModel validates correctly", () => {
    const provider = new AnthropicProvider();
    expect(provider.isValidModel("claude-sonnet-4-5-20250929")).toBe(true);
    expect(provider.isValidModel("gpt-4o")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  chat
// ---------------------------------------------------------------------------

describe("AnthropicProvider — chat", () => {
  it("returns parsed response with system message extracted", async () => {
    const provider = new AnthropicProvider();

    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello! How can I help?" }],
      usage: { input_tokens: 12, output_tokens: 6 },
      stop_reason: "end_turn",
      model: "claude-sonnet-4-5-20250929",
    });

    const result = await provider.chat(makeRequest(), "sk-FAKE-ant-test");

    expect(result.content).toBe("Hello! How can I help?");
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(6);
    expect(result.finishReason).toBe("end_turn");

    // Verify system message was extracted and passed separately
    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.system).toBe("You are helpful.");
    // Non-system messages should not include system role
    expect(callArgs.messages.every((m: any) => m.role !== "system")).toBe(true);
  });

  it("handles multiple text blocks", async () => {
    const provider = new AnthropicProvider();

    mockMessagesCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Part 1. " },
        { type: "text", text: "Part 2." },
      ],
      usage: { input_tokens: 5, output_tokens: 4 },
      stop_reason: null,
      model: "claude-sonnet-4-5-20250929",
    });

    const result = await provider.chat(makeRequest(), "sk-FAKE-ant-test");
    expect(result.content).toBe("Part 1. Part 2.");
    expect(result.finishReason).toBe("end_turn"); // null → "end_turn" fallback
  });
});

// ---------------------------------------------------------------------------
//  chatStream
// ---------------------------------------------------------------------------

describe("AnthropicProvider — chatStream", () => {
  it("yields deltas then final chunk with usage", async () => {
    const provider = new AnthropicProvider();

    const streamEvents = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      { type: "message_delta", usage: { output_tokens: 5 } },
    ];

    mockMessagesStream.mockReturnValueOnce({
      [Symbol.asyncIterator]: () => {
        let idx = 0;
        return {
          next: () => {
            if (idx < streamEvents.length) {
              return Promise.resolve({ value: streamEvents[idx++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    });

    const chunks: Array<{ delta: string; done: boolean; usage?: unknown }> = [];
    for await (const chunk of provider.chatStream(makeRequest(), "sk-FAKE-ant-test")) {
      chunks.push(chunk);
    }

    // "Hello", " world" content chunks + final done chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].delta).toBe("Hello");
    expect(chunks[0].done).toBe(false);
    expect(chunks[1].delta).toBe(" world");

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.done).toBe(true);
    expect((lastChunk.usage as any).promptTokens).toBe(10);
    expect((lastChunk.usage as any).completionTokens).toBe(5);
  });
});
