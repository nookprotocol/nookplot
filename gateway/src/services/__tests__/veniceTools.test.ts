import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerVeniceTools } from "../veniceTools.js";
import type { ActionRegistry } from "../actionRegistry.js";
import type { ByokManager } from "../byokManager.js";

// Mock OpenAI SDK
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

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockRegistry() {
  const tools = new Map<string, any>();
  return {
    register: vi.fn((tool: any) => tools.set(tool.name, tool)),
    get: (name: string) => tools.get(name),
    _tools: tools,
  } as unknown as ActionRegistry & { _tools: Map<string, any> };
}

function createMockByokManager(byokKey: string | null = null) {
  return {
    getKey: vi.fn().mockResolvedValue(byokKey),
  } as unknown as ByokManager;
}

const VENICE_API_KEY = "venice-gateway-key-123";

// ---------------------------------------------------------------------------
//  Registration
// ---------------------------------------------------------------------------

describe("registerVeniceTools — registration", () => {
  it("registers both tools", () => {
    const registry = createMockRegistry();
    const byok = createMockByokManager();

    registerVeniceTools(registry, null as any, null as any, byok, VENICE_API_KEY);

    expect(registry.register).toHaveBeenCalledTimes(2);
    expect(registry._tools.has("venice_image_gen")).toBe(true);
    expect(registry._tools.has("venice_web_search")).toBe(true);
  });

  it("venice_image_gen has correct schema and cost", () => {
    const registry = createMockRegistry();
    registerVeniceTools(registry, null as any, null as any, createMockByokManager(), VENICE_API_KEY);

    const tool = registry._tools.get("venice_image_gen");
    expect(tool.category).toBe("ai");
    expect(tool.cost).toBe(200);
    expect(tool.defaultAutonomyLevel).toBe("semi-autonomous");
    expect(tool.inputSchema.required).toEqual(["prompt"]);
  });

  it("venice_web_search has correct schema and cost", () => {
    const registry = createMockRegistry();
    registerVeniceTools(registry, null as any, null as any, createMockByokManager(), VENICE_API_KEY);

    const tool = registry._tools.get("venice_web_search");
    expect(tool.category).toBe("ai");
    expect(tool.cost).toBe(75);
    expect(tool.defaultAutonomyLevel).toBe("autonomous");
    expect(tool.inputSchema.required).toEqual(["query"]);
  });
});

// ---------------------------------------------------------------------------
//  venice_image_gen handler
// ---------------------------------------------------------------------------

describe("venice_image_gen — handler", () => {
  let registry: ActionRegistry & { _tools: Map<string, any> };
  let byok: ByokManager;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createMockRegistry();
    byok = createMockByokManager();
    registerVeniceTools(registry, null as any, null as any, byok, VENICE_API_KEY);
  });

  it("calls Venice image API and returns images", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { url: "https://venice.ai/img/abc.png" },
          { url: "https://venice.ai/img/def.png" },
        ],
      }),
    });

    const handler = registry._tools.get("venice_image_gen").handler;
    const result = await handler("agent-1", { prompt: "a cat in space", n: 2 });

    expect(result.success).toBe(true);
    expect(result.output.images).toHaveLength(2);
    expect(result.output.images[0]).toBe("https://venice.ai/img/abc.png");
    expect(result.creditsUsed).toBe(200);

    // Verify fetch was called with correct URL and auth
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${VENICE_API_KEY}`,
        }),
      }),
    );
  });

  it("uses BYOK key when available", async () => {
    const byokRegistry = createMockRegistry();
    const byokManager = createMockByokManager("agent-venice-key");
    registerVeniceTools(byokRegistry, null as any, null as any, byokManager, VENICE_API_KEY);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ url: "https://venice.ai/img/1.png" }] }),
    });

    const handler = byokRegistry._tools.get("venice_image_gen").handler;
    await handler("agent-1", { prompt: "a dog" });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer agent-venice-key",
        }),
      }),
    );
  });

  it("handles API error gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limit exceeded"),
    });

    const handler = registry._tools.get("venice_image_gen").handler;
    const result = await handler("agent-1", { prompt: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
    expect(result.creditsUsed).toBe(0);
  });

  it("clamps n to 1-4 range", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const handler = registry._tools.get("venice_image_gen").handler;
    await handler("agent-1", { prompt: "test", n: 10 });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.n).toBe(4);
  });
});

// ---------------------------------------------------------------------------
//  venice_web_search handler
// ---------------------------------------------------------------------------

describe("venice_web_search — handler", () => {
  let registry: ActionRegistry & { _tools: Map<string, any> };

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createMockRegistry();
    registerVeniceTools(registry, null as any, null as any, createMockByokManager(), VENICE_API_KEY);
  });

  it("calls Venice chat API with web search enabled", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "The answer is 42. [1](https://example.com)" } }],
      model: "llama-3.3-70b",
    });

    const handler = registry._tools.get("venice_web_search").handler;
    const result = await handler("agent-1", { query: "what is the meaning of life" });

    expect(result.success).toBe(true);
    expect(result.output.answer).toContain("The answer is 42");
    expect(result.output.model).toBe("llama-3.3-70b");
    expect(result.creditsUsed).toBe(75);

    // Verify venice_parameters were passed
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        venice_parameters: {
          enable_web_search: true,
          enable_web_citations: true,
        },
      }),
    );
  });

  it("extracts citation URLs from response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: "Source [1](https://example.com/a) and [2](https://example.com/b) confirm this.",
        },
      }],
      model: "llama-3.3-70b",
    });

    const handler = registry._tools.get("venice_web_search").handler;
    const result = await handler("agent-1", { query: "test" });

    expect(result.success).toBe(true);
    expect(result.output.citations).toContain("https://example.com/a");
    expect(result.output.citations).toContain("https://example.com/b");
  });

  it("handles error gracefully", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API timeout"));

    const handler = registry._tools.get("venice_web_search").handler;
    const result = await handler("agent-1", { query: "test" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("API timeout");
    expect(result.creditsUsed).toBe(0);
  });
});
