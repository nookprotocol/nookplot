/**
 * Tests for `nookplot mine` — verifies command registration, flag parsing,
 * and capability-driven track filtering.
 *
 * The full mining loop (discover/rank/solve) is exercised in
 * runtime/src/__tests__/mining.test.ts; these tests focus on the CLI's
 * orchestration surface that the loop depends on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────

const mockMiningStart = vi.fn();
const mockMiningSession = {
  done: Promise.resolve(),
  stop: vi.fn().mockResolvedValue(undefined),
  stats: vi.fn().mockReturnValue({
    ticks: 1, attempted: 0, submitted: 0, skipped: 0, dryRun: 0, errors: 0, creditsSpent: 0,
    byTrack: { knowledge: { attempted: 0, submitted: 0, errors: 0 }, embedding: { attempted: 0, submitted: 0, errors: 0 }, rlm: { attempted: 0, submitted: 0, errors: 0 }, gradient: { attempted: 0, submitted: 0, errors: 0 } },
  }),
};
const mockConnect = vi.fn().mockResolvedValue({});
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockRequest = vi.fn();

vi.mock("@nookplot/runtime", () => ({
  NookplotRuntime: vi.fn().mockImplementation(() => ({
    connection: { request: mockRequest },
    connect: mockConnect,
    disconnect: mockDisconnect,
    mining: { start: mockMiningStart },
  })),
}));

vi.mock("../../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    gateway: "https://gateway.test",
    apiKey: "nk_test",
    privateKey: "0xTEST_KEY",
  }),
  validateConfig: vi.fn().mockReturnValue([]),
}));

const mockDetectCapabilities = vi.fn();
vi.mock("../../utils/miningCapabilities.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/miningCapabilities.js")>(
    "../../utils/miningCapabilities.js",
  );
  return {
    ...actual,
    detectCapabilities: mockDetectCapabilities,
  };
});

vi.mock("chalk", () => {
  const fn = (s: string): string => s;
  const proxy: Record<string, unknown> = new Proxy(fn, { get: () => fn });
  return { default: proxy };
});

vi.mock("ora", () => ({
  default: () => ({
    start: () => ({ stop: vi.fn(), succeed: vi.fn(), fail: vi.fn(), warn: vi.fn(), info: vi.fn() }),
    stop: vi.fn(),
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────

import { Command } from "commander";

async function runMineWith(args: string[]): Promise<{ exitCode: number | null; stderr: string; }> {
  // Re-import after mocks are set so registerMineCommand's deps are mocked.
  const { registerMineCommand } = await import("../mine.js");
  const program = new Command();
  program.exitOverride();

  // Capture stderr
  const originalErr = console.error;
  let stderr = "";
  console.error = (msg: unknown) => { stderr += String(msg) + "\n"; };

  // Capture process.exit
  const originalExit = process.exit;
  let exitCode: number | null = null;
  // @ts-expect-error — test override
  process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error("__test_exit__"); };

  registerMineCommand(program);

  try {
    await program.parseAsync(["node", "test", "mine", ...args]);
  } catch (err) {
    if (err instanceof Error && err.message === "__test_exit__") {
      // expected — process.exit was called
    } else {
      throw err;
    }
  } finally {
    console.error = originalErr;
    process.exit = originalExit;
  }
  return { exitCode, stderr };
}

// ─── Setup / Teardown ───────────────────────────────────────────────

beforeEach(() => {
  mockMiningStart.mockReset();
  mockMiningStart.mockResolvedValue(mockMiningSession);
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({
    tracks: [
      { track: "knowledge", openCount: 5, estNookPerHour: 10000, successRate: 0.7 },
    ],
    totalEstNookPerHour: 10000,
  });
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  mockDetectCapabilities.mockReset();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("registerMineCommand — registration", () => {
  it("adds the `mine` subcommand to the program", async () => {
    const { registerMineCommand } = await import("../mine.js");
    const program = new Command();
    registerMineCommand(program);
    const cmd = program.commands.find((c) => c.name() === "mine");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toMatch(/mining loop/i);
    const optionFlags = cmd?.options.map((o) => o.flags) ?? [];
    expect(optionFlags).toEqual(expect.arrayContaining([
      expect.stringContaining("--tracks"),
      expect.stringContaining("--once"),
      expect.stringContaining("--max-credits"),
      expect.stringContaining("--guild"),
      expect.stringContaining("--dry-run"),
      expect.stringContaining("--explain"),
    ]));
  });
});

describe("runMine — track filtering", () => {
  it("exits with error when no tracks are enabled locally", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: false, reason: "no LLM" },
      { track: "embedding", enabled: false, reason: "no Ollama" },
      { track: "rlm", enabled: false, reason: "no LLM" },
      { track: "gradient", enabled: false, reason: "no GPU" },
    ]);
    const { exitCode, stderr } = await runMineWith([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No mining tracks are enabled/);
    expect(mockMiningStart).not.toHaveBeenCalled();
  });

  it("rejects --tracks containing only invalid names", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: false },
      { track: "rlm", enabled: false },
      { track: "gradient", enabled: false },
    ]);
    const { exitCode, stderr } = await runMineWith(["--tracks", "bogus,fake"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/No valid tracks/);
    expect(mockMiningStart).not.toHaveBeenCalled();
  });

  it("filters detected tracks against --tracks intersection", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: true, provider: "ollama (nomic-embed-text)" },
      { track: "rlm", enabled: false, reason: "no python" },
      { track: "gradient", enabled: false },
    ]);
    const { exitCode } = await runMineWith(["--tracks", "knowledge,rlm", "--once"]);
    // exitCode is null when the run completes normally (no process.exit call).
    expect(exitCode).toBeNull();
    expect(mockMiningStart).toHaveBeenCalledOnce();
    const passed = mockMiningStart.mock.calls[0][0];
    // RLM was requested but is disabled locally → only knowledge survives.
    expect(passed.tracks).toEqual(["knowledge"]);
  });

  it("errors out when none of the requested tracks are enabled", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: false },
      { track: "rlm", enabled: false },
      { track: "gradient", enabled: false },
    ]);
    const { exitCode, stderr } = await runMineWith(["--tracks", "rlm"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/None of the requested tracks/);
  });

  it("propagates --once, --max-credits, --guild, --dry-run, --explain to runtime.mining.start()", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: false },
      { track: "rlm", enabled: false },
      { track: "gradient", enabled: false },
    ]);
    await runMineWith([
      "--once",
      "--max-credits", "1234",
      "--guild", "0xGUILD",
      "--dry-run",
      "--explain",
      "--tick-interval", "500",
    ]);
    const passed = mockMiningStart.mock.calls[0][0];
    expect(passed.once).toBe(true);
    expect(passed.maxCredits).toBe(1234);
    expect(passed.guildId).toBe("0xGUILD");
    expect(passed.dryRun).toBe(true);
    expect(passed.explain).toBe(true);
    expect(passed.tickIntervalMs).toBe(500);
  });
});

describe("runMine — earnings preview", () => {
  it("queries /v1/mining/earnings-preview with the enabled tracks", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: true, provider: "ollama" },
      { track: "rlm", enabled: false },
      { track: "gradient", enabled: false },
    ]);
    await runMineWith(["--once"]);
    const previewCall = mockRequest.mock.calls.find((c: any[]) =>
      typeof c[1] === "string" && c[1].startsWith("/v1/mining/earnings-preview"));
    expect(previewCall).toBeTruthy();
    expect(previewCall![1]).toContain("knowledge");
    expect(previewCall![1]).toContain("embedding");
  });

  it("proceeds even when earnings-preview fails", async () => {
    mockDetectCapabilities.mockResolvedValue([
      { track: "knowledge", enabled: true, provider: "anthropic" },
      { track: "embedding", enabled: false },
      { track: "rlm", enabled: false },
      { track: "gradient", enabled: false },
    ]);
    mockRequest.mockRejectedValueOnce(new Error("preview unavailable"));
    const { exitCode } = await runMineWith(["--once"]);
    // null exit code means normal completion (no process.exit call).
    expect(exitCode).toBeNull();
    expect(mockMiningStart).toHaveBeenCalledOnce();
  });
});
