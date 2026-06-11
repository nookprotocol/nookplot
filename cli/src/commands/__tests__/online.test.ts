/**
 * Tests for `nookplot online` — daemon lifecycle helpers.
 *
 * `online` runs a background process that maintains a WebSocket to the
 * gateway. The user-facing surface — `readPid`, `runStop`, `runStatus` —
 * is purely fs + signal-based and easy to unit-test by stubbing node:fs
 * and process.kill. The interactive `runStart` path forks a child process
 * and is exercised end-to-end elsewhere; here we focus on the pieces that
 * survive the fork.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fs before importing the module ────────────────────────────

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockAppendFileSync = vi.fn();

// Wrap node:fs without breaking other modules' module-init reads (e.g. the
// runtime SDK reads its package.json synchronously at import time). The
// mocks delegate to the real fs by default; each test opts into stubbed
// behavior per-call via mockReturnValue / mockImplementation.
let realFs: typeof import("node:fs");
vi.mock("node:fs", async () => {
  const actual: typeof import("node:fs") = await vi.importActual("node:fs");
  realFs = actual;
  // Initial defaults — runtime SDK reads its package.json at import time, so
  // these MUST already delegate to the real fs by the time the factory returns.
  mockExistsSync.mockImplementation(actual.existsSync);
  mockReadFileSync.mockImplementation(actual.readFileSync as never);
  mockWriteFileSync.mockImplementation(actual.writeFileSync);
  mockUnlinkSync.mockImplementation(actual.unlinkSync);
  mockMkdirSync.mockImplementation(actual.mkdirSync as never);
  mockAppendFileSync.mockImplementation(actual.appendFileSync);
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    unlinkSync: mockUnlinkSync,
    mkdirSync: mockMkdirSync,
    appendFileSync: mockAppendFileSync,
  };
});

// Quiet chalk + ora
vi.mock("chalk", () => {
  const fn = (s: string): string => s;
  const proxy: Record<string, unknown> = new Proxy(fn, { get: () => fn });
  return { default: proxy };
});

vi.mock("ora", () => ({
  default: () => ({ start: () => ({ succeed: vi.fn(), fail: vi.fn(), warn: vi.fn(), info: vi.fn() }) }),
}));

const { readPid, runStop, runStatus } = await import("../online.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(" ")); };
  return { logs, restore: () => { console.log = orig; } };
}

// ===========================================================================
// readPid — returns null when missing / stale / invalid; PID when alive
// ===========================================================================

describe("readPid", () => {
  beforeEach(() => {
    // Reset call history AND any previously-set return values, then restore
    // real-fs delegation as the default. Tests override per-call as needed.
    mockExistsSync.mockReset().mockImplementation(realFs.existsSync);
    mockReadFileSync.mockReset().mockImplementation(realFs.readFileSync as never);
    mockWriteFileSync.mockReset().mockImplementation(realFs.writeFileSync);
    mockUnlinkSync.mockReset().mockImplementation(realFs.unlinkSync);
    mockMkdirSync.mockReset().mockImplementation(realFs.mkdirSync as never);
    mockAppendFileSync.mockReset().mockImplementation(realFs.appendFileSync);
  });

  it("returns null when the PID file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readPid()).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("returns null and removes the file when the PID file contains a non-numeric value", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not-a-number");
    expect(readPid()).toBeNull();
    // No process.kill is called — early-return on NaN
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("returns the PID when the process is alive (process.kill 0 succeeds)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("12345\n");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    try {
      expect(readPid()).toBe(12345);
      expect(killSpy).toHaveBeenCalledWith(12345, 0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("returns null and removes the stale file when process.kill 0 throws (process gone)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("99999");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
    try {
      expect(readPid()).toBeNull();
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
    }
  });
});

// ===========================================================================
// runStop — sends SIGTERM and cleans up; tolerant of dead PID
// ===========================================================================

describe("runStop", () => {
  beforeEach(() => {
    // Reset call history AND any previously-set return values, then restore
    // real-fs delegation as the default. Tests override per-call as needed.
    mockExistsSync.mockReset().mockImplementation(realFs.existsSync);
    mockReadFileSync.mockReset().mockImplementation(realFs.readFileSync as never);
    mockWriteFileSync.mockReset().mockImplementation(realFs.writeFileSync);
    mockUnlinkSync.mockReset().mockImplementation(realFs.unlinkSync);
    mockMkdirSync.mockReset().mockImplementation(realFs.mkdirSync as never);
    mockAppendFileSync.mockReset().mockImplementation(realFs.appendFileSync);
  });

  it("logs \"Not running\" when no PID file exists", () => {
    mockExistsSync.mockReturnValue(false);
    const { logs, restore } = captureLog();
    try {
      runStop();
      expect(logs.join("\n")).toMatch(/not running/i);
    } finally {
      restore();
    }
  });

  it("sends SIGTERM and removes the PID file when the daemon is alive", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("4321");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const { logs, restore } = captureLog();
    try {
      runStop();
      expect(killSpy).toHaveBeenCalledWith(4321, 0); // readPid liveness probe
      expect(killSpy).toHaveBeenCalledWith(4321, "SIGTERM");
      expect(mockUnlinkSync).toHaveBeenCalled();
      expect(logs.join("\n")).toMatch(/stopped/i);
    } finally {
      killSpy.mockRestore();
      restore();
    }
  });

  it("falls back gracefully when SIGTERM throws (process already gone)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("4321");
    let callCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig: number | string) => {
      callCount++;
      // First call (readPid liveness probe with sig=0) succeeds; second (SIGTERM) throws.
      if (callCount === 1 && sig === 0) return true as never;
      throw new Error("ESRCH");
    }) as never);
    const { logs, restore } = captureLog();
    try {
      runStop();
      expect(logs.join("\n")).toMatch(/not found/i);
    } finally {
      killSpy.mockRestore();
      restore();
    }
  });
});

// ===========================================================================
// runStatus — offline / online (with events file) / online (with log tail)
// ===========================================================================

describe("runStatus", () => {
  beforeEach(() => {
    // Reset call history AND any previously-set return values, then restore
    // real-fs delegation as the default. Tests override per-call as needed.
    mockExistsSync.mockReset().mockImplementation(realFs.existsSync);
    mockReadFileSync.mockReset().mockImplementation(realFs.readFileSync as never);
    mockWriteFileSync.mockReset().mockImplementation(realFs.writeFileSync);
    mockUnlinkSync.mockReset().mockImplementation(realFs.unlinkSync);
    mockMkdirSync.mockReset().mockImplementation(realFs.mkdirSync as never);
    mockAppendFileSync.mockReset().mockImplementation(realFs.appendFileSync);
  });

  it("prints \"Offline\" guidance when no PID file exists", () => {
    mockExistsSync.mockReturnValue(false);
    const { logs, restore } = captureLog();
    try {
      runStatus();
      expect(logs.join("\n")).toMatch(/offline/i);
      expect(logs.join("\n")).toMatch(/online start/);
    } finally {
      restore();
    }
  });

  it("prints \"Online (PID …)\" + event summary when PID + events file exist", () => {
    // existsSync called for: PID_FILE → true, EVENTS_FILE → true, LOG_FILE → false
    let call = 0;
    mockExistsSync.mockImplementation(() => {
      call++;
      if (call === 1) return true;       // PID_FILE
      if (call === 2) return true;       // EVENTS_FILE
      return false;                       // LOG_FILE
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith("online.pid")) return "5555";
      if (p.endsWith("events.jsonl")) return [
        '{"type":"post.new","ts":1}',
        '{"type":"post.new","ts":2}',
        '{"type":"vote.received","ts":3}',
      ].join("\n") + "\n";
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const { logs, restore } = captureLog();
    try {
      runStatus();
      const out = logs.join("\n");
      expect(out).toMatch(/online \(PID 5555\)/i);
      expect(out).toMatch(/3 events received/);
      expect(out).toMatch(/2 post\.new/);
    } finally {
      killSpy.mockRestore();
      restore();
    }
  });

  it("prints log tail when the log file exists", () => {
    let call = 0;
    mockExistsSync.mockImplementation(() => {
      call++;
      if (call === 1) return true;      // PID_FILE
      if (call === 2) return false;     // EVENTS_FILE
      return true;                       // LOG_FILE
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith("online.pid")) return "7777";
      if (p.endsWith("online.log")) return "[2026-04-27T00:00:00Z] ready\n[2026-04-27T00:00:01Z] connected\n";
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const { logs, restore } = captureLog();
    try {
      runStatus();
      expect(logs.join("\n")).toMatch(/Last log:.*connected/);
    } finally {
      killSpy.mockRestore();
      restore();
    }
  });

  it("tolerates a malformed line in events.jsonl without crashing", () => {
    let call = 0;
    mockExistsSync.mockImplementation(() => {
      call++;
      return call <= 2; // PID + events true, log false
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.endsWith("online.pid")) return "8888";
      if (p.endsWith("events.jsonl")) return [
        '{"type":"post.new"}',
        "not valid json",
        '{"type":"vote.received"}',
      ].join("\n");
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    const { logs, restore } = captureLog();
    try {
      expect(() => runStatus()).not.toThrow();
      expect(logs.join("\n")).toMatch(/3 events received/);
    } finally {
      killSpy.mockRestore();
      restore();
    }
  });
});
