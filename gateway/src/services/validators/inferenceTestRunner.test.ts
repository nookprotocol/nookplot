import { describe, it, expect, vi, beforeEach } from "vitest";
import { InferenceTestRunner } from "./inferenceTestRunner.js";
import { createMockPool } from "../../test/helpers.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createMockInferenceProxy() {
  return {
    chat: vi.fn().mockResolvedValue({ content: "Test response content here" }),
    getProvider: vi.fn().mockReturnValue(null),
  };
}

function createRunner(
  pool?: ReturnType<typeof createMockPool>,
  proxy?: ReturnType<typeof createMockInferenceProxy>,
) {
  const p = pool ?? createMockPool();
  const ip = proxy ?? createMockInferenceProxy();
  const runner = new InferenceTestRunner(p as any, ip as any);
  return { runner, pool: p, inferenceProxy: ip };
}

const AGENT_ROW = {
  id: "agt_1",
  address: "0x1111111111111111111111111111111111111111",
  display_name: "Test Agent",
  model_provider: "openai",
  model_name: "gpt-4",
  capabilities: ["chat", "code"],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  Basic
// ---------------------------------------------------------------------------

describe("InferenceTestRunner", () => {
  it("has name 'inference'", () => {
    const { runner } = createRunner();
    expect(runner.name).toBe("inference");
  });
});

// ---------------------------------------------------------------------------
//  runTest
// ---------------------------------------------------------------------------

describe("InferenceTestRunner.runTest", () => {
  it("throws when agent not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { runner } = createRunner(pool);

    await expect(runner.runTest("agt_unknown", {} as any)).rejects.toThrow("not found");
  });

  it("throws when no model_provider configured", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{ ...AGENT_ROW, model_provider: null }],
      rowCount: 1,
    });
    const { runner } = createRunner(pool);

    await expect(runner.runTest("agt_1", {} as any)).rejects.toThrow("model_provider");
  });

  it("returns score 10 when inference call fails", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [AGENT_ROW], rowCount: 1 });
    const proxy = createMockInferenceProxy();
    proxy.chat.mockRejectedValueOnce(new Error("API key invalid"));
    const { runner } = createRunner(pool, proxy);

    const result = await runner.runTest("agt_1", {} as any);

    expect(result.score).toBe(10);
    expect(result.testResponse).toContain("ERROR");
    expect(result.testResponse).toContain("API key invalid");
    expect(result.metrics.responseQuality).toBe(0);
    expect(result.metrics.responseLatency).toBe(0);
    expect(result.proofMethod).toBe("direct");
  });

  it("returns evaluated score with fallback heuristic (no LLM judge)", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [AGENT_ROW], rowCount: 1 });
    const proxy = createMockInferenceProxy();
    // Agent inference response (long enough for heuristic to score well)
    proxy.chat.mockResolvedValueOnce({
      content: "I am an AI assistant specializing in chat and code generation. I can help you write Python scripts and debug issues.",
    });
    // getProvider returns null → fallback heuristic
    proxy.getProvider.mockReturnValue(null);
    const { runner } = createRunner(pool, proxy);

    const result = await runner.runTest("agt_1", {} as any);

    // Fallback heuristic: quality=50, coherence=60, claimAccuracy=50
    expect(result.score).toBeGreaterThan(0);
    expect(result.testResponse).toContain("AI assistant");
    expect(result.proofMethod).toBe("direct");
  });

  it("uses LLM-as-judge when provider available", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [AGENT_ROW], rowCount: 1 });
    const proxy = createMockInferenceProxy();
    // Agent inference
    proxy.chat.mockResolvedValueOnce({ content: "I help with chat and code." });
    // LLM-as-judge provider exists
    proxy.getProvider.mockReturnValueOnce({ name: "anthropic" });
    // LLM-as-judge evaluation response
    proxy.chat.mockResolvedValueOnce({ content: "85, 90, 75" });
    const { runner } = createRunner(pool, proxy);

    const result = await runner.runTest("agt_1", {} as any);

    expect(result.metrics.responseQuality).toBe(85);
    expect(result.metrics.coherence).toBe(90);
    expect(result.metrics.claimAccuracy).toBe(75);
  });
});

// ---------------------------------------------------------------------------
//  generateTestPrompt (private — via reflection)
// ---------------------------------------------------------------------------

describe("InferenceTestRunner — generateTestPrompt", () => {
  it("includes capabilities in prompt", () => {
    const { runner } = createRunner();
    const agent = { capabilities: ["chat", "code", "analysis"] } as any;
    const prompt = (runner as any).generateTestPrompt(agent);

    expect(prompt).toContain("chat, code, analysis");
    expect(prompt).toContain("claimed capabilities");
  });

  it("uses 'general' when no capabilities", () => {
    const { runner } = createRunner();
    const agent = { capabilities: null } as any;
    const prompt = (runner as any).generateTestPrompt(agent);

    expect(prompt).toContain("general");
  });
});

// ---------------------------------------------------------------------------
//  evaluateResponse (private — via reflection)
// ---------------------------------------------------------------------------

describe("InferenceTestRunner — evaluateResponse", () => {
  const MOCK_AGENT = { model_provider: "openai", model_name: "gpt-4", capabilities: ["chat"] };

  it("parses LLM scores correctly", async () => {
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValueOnce({ name: "anthropic" });
    proxy.chat.mockResolvedValueOnce({ content: "95, 88, 72" });
    const { runner } = createRunner(undefined, proxy);

    const result = await (runner as any).evaluateResponse("test prompt", "test response", MOCK_AGENT);

    expect(result.quality).toBe(95);
    expect(result.coherence).toBe(88);
    expect(result.claimAccuracy).toBe(72);
  });

  it("caps scores at 100", async () => {
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValueOnce({ name: "openai" });
    proxy.chat.mockResolvedValueOnce({ content: "150, 200, 300" });
    const { runner } = createRunner(undefined, proxy);

    const result = await (runner as any).evaluateResponse("test", "test", MOCK_AGENT);

    expect(result.quality).toBe(100);
    expect(result.coherence).toBe(100);
    expect(result.claimAccuracy).toBe(100);
  });

  it("falls back to heuristic when no providers available", async () => {
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValue(null);
    const { runner } = createRunner(undefined, proxy);

    const result = await (runner as any).evaluateResponse(
      "test",
      "This is a reasonably long response with enough content to pass both checks easily.",
      MOCK_AGENT,
    );

    expect(result.quality).toBe(50);
    expect(result.coherence).toBe(60);
    expect(result.claimAccuracy).toBe(50);
  });

  it("returns low heuristic scores for short responses", async () => {
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValue(null);
    const { runner } = createRunner(undefined, proxy);

    const result = await (runner as any).evaluateResponse("test", "short", MOCK_AGENT);

    expect(result.quality).toBe(10);
    expect(result.coherence).toBe(20);
  });

  it("tries anthropic first then falls back to openai", async () => {
    const proxy = createMockInferenceProxy();
    proxy.getProvider.mockReturnValueOnce(null); // anthropic unavailable
    proxy.getProvider.mockReturnValueOnce({ name: "openai" }); // openai available
    proxy.chat.mockResolvedValueOnce({ content: "70, 80, 60" });
    const { runner } = createRunner(undefined, proxy);

    const result = await (runner as any).evaluateResponse("test", "test response", MOCK_AGENT);

    expect(proxy.getProvider).toHaveBeenCalledWith("anthropic");
    expect(proxy.getProvider).toHaveBeenCalledWith("openai");
    expect(result.quality).toBe(70);
  });
});
