import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  anyEnabled,
  detectCapabilities,
  detectReasoningProvider,
  enabledTracks,
  listOllamaModels,
  type MiningCapability,
} from "../miningCapabilities.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function mockOllama(models: string[]): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
    }
    return new Response("", { status: 404 });
  });
}

function mockOllamaUnreachable(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("ECONNREFUSED");
  });
}

describe("listOllamaModels", () => {
  it("returns model names when Ollama responds", async () => {
    mockOllama(["llama3.2:latest", "nomic-embed-text:latest"]);
    const models = await listOllamaModels();
    expect(models).toEqual(["llama3.2:latest", "nomic-embed-text:latest"]);
  });

  it("returns empty array when Ollama is unreachable (never throws)", async () => {
    mockOllamaUnreachable();
    const models = await listOllamaModels();
    expect(models).toEqual([]);
  });

  it("returns empty array on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    const models = await listOllamaModels();
    expect(models).toEqual([]);
  });
});

describe("detectReasoningProvider", () => {
  it("prefers ANTHROPIC_API_KEY when set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    mockOllama([]);
    expect(await detectReasoningProvider()).toBe("anthropic");
  });

  it("falls through to OPENAI_API_KEY", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockOllama([]);
    expect(await detectReasoningProvider()).toBe("openai");
  });

  it("falls through to a reasoning-capable Ollama model", async () => {
    mockOllama(["llama3.2:latest"]);
    expect(await detectReasoningProvider()).toBe("ollama (llama3.2:latest)");
  });

  it("ignores Ollama models that aren't reasoning-capable (e.g. embedding-only)", async () => {
    mockOllama(["nomic-embed-text:latest"]);
    expect(await detectReasoningProvider()).toBeNull();
  });

  it("returns null when no providers exist", async () => {
    mockOllama([]);
    expect(await detectReasoningProvider()).toBeNull();
  });
});

describe("detectCapabilities", () => {
  it("disables knowledge + rlm when no LLM is available (false-positive guard)", async () => {
    mockOllama([]);
    const caps = await detectCapabilities();
    const k = caps.find((c) => c.track === "knowledge");
    const r = caps.find((c) => c.track === "rlm");
    expect(k?.enabled).toBe(false);
    expect(r?.enabled).toBe(false);
    expect(r?.reason).toMatch(/LLM/);
  });

  it("enables knowledge when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockOllama([]);
    const caps = await detectCapabilities();
    const k = caps.find((c) => c.track === "knowledge");
    expect(k?.enabled).toBe(true);
    expect(k?.provider).toBe("anthropic");
  });

  it("enables embedding when nomic-embed-text is installed", async () => {
    mockOllama(["nomic-embed-text:latest"]);
    const caps = await detectCapabilities();
    const e = caps.find((c) => c.track === "embedding");
    expect(e?.enabled).toBe(true);
    expect(e?.provider).toMatch(/nomic-embed-text/);
  });

  it("disables embedding with a clear pull suggestion when missing", async () => {
    mockOllama(["llama3.2:latest"]);
    const caps = await detectCapabilities();
    const e = caps.find((c) => c.track === "embedding");
    expect(e?.enabled).toBe(false);
    expect(e?.reason).toMatch(/ollama pull nomic-embed-text/);
  });

  it("ships gradient as informational-only — never enabled", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockOllama(["nomic-embed-text:latest"]);
    const caps = await detectCapabilities();
    const g = caps.find((c) => c.track === "gradient");
    expect(g?.enabled).toBe(false);
    expect(g?.reason).toBeTruthy();
  });

  it("rlm requires both LLM and python — disabled if either missing", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockOllama([]);
    const caps = await detectCapabilities();
    const r = caps.find((c) => c.track === "rlm");
    // Whether python3 exists on the test host is not guaranteed; we only
    // assert the *reason* mentions python when disabled, or it's enabled.
    if (!r?.enabled) {
      expect(r?.reason).toMatch(/python/i);
    } else {
      expect(r.provider).toMatch(/python/);
    }
  });
});

describe("anyEnabled / enabledTracks", () => {
  it("returns true when any track is enabled", () => {
    const caps: MiningCapability[] = [
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: false, reason: "missing" },
      { track: "rlm", enabled: false, reason: "missing" },
      { track: "gradient", enabled: false, reason: "no GPU" },
    ];
    expect(anyEnabled(caps)).toBe(true);
    expect(enabledTracks(caps)).toEqual(["knowledge"]);
  });

  it("returns false when all tracks are disabled", () => {
    const caps: MiningCapability[] = [
      { track: "knowledge", enabled: false },
      { track: "embedding", enabled: false },
      { track: "rlm", enabled: false },
      { track: "gradient", enabled: false },
    ];
    expect(anyEnabled(caps)).toBe(false);
    expect(enabledTracks(caps)).toEqual([]);
  });
});
