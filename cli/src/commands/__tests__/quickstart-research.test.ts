import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// ── Mocks ──────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

const mockExecSync = vi.fn();
const spawnHandlers = new Map<string, (arg?: unknown) => void>();
const mockSpawn = vi.fn(() => ({
  on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
    spawnHandlers.set(event, cb);
  }),
  kill: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("chalk", () => ({
  default: {
    bold: (s: string) => s,
    cyan: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
  },
}));

import { existsSync, readFileSync } from "node:fs";
import { registerQuickstartResearchCommand } from "../quickstart-research.js";

// ── Helpers ────────────────────────────────────────────────────

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerQuickstartResearchCommand(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
});

// ── Tests ──────────────────────────────────────────────────────

describe("quickstart-research command registration", () => {
  it("registers on the program", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "quickstart-research");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("autoresearch");
  });

  it("accepts --dir option", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "quickstart-research");
    const dirOpt = cmd!.options.find((o) => o.long === "--dir");
    expect(dirOpt).toBeDefined();
  });

  it("accepts --community option", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "quickstart-research");
    const communityOpt = cmd!.options.find((o) => o.long === "--community");
    expect(communityOpt).toBeDefined();
  });
});

describe("quickstart-research credentials check", () => {
  it("detects existing credentials file", async () => {
    const creds = { apiKey: "nk_test123", privateKey: "0xABC", address: "0x1234567890abcdef" };
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes("credentials.json")) return true;
      // For repo directory check
      if (String(p).includes("train.py")) return true;
      return String(p) === "/mock-repo";
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(creds));

    // Mock python check
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--version")) return "Python 3.12.0";
      if (cmd.includes("pip show")) return "Name: nookplot-autoresearch";
      return "";
    });

    const program = createProgram();
    // Use --dir to skip the interactive prompt
    await program.parseAsync([
      "node", "test", "quickstart-research", "--dir", "/mock-repo",
    ]).catch(() => {}); // spawn exits via process.exit mock

    // Should NOT have called nookplot register (already registered)
    const registerCalls = mockExecSync.mock.calls.filter(
      (c) => String(c[0]).includes("nookplot register"),
    );
    expect(registerCalls).toHaveLength(0);
  });

  it("runs nookplot register when no credentials", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes("credentials.json")) return false;
      if (String(p).includes("train.py")) return true;
      return String(p) === "/mock-repo";
    });

    // After register, credentials exist
    let registerCalled = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("nookplot register")) {
        registerCalled = true;
        vi.mocked(existsSync).mockImplementation((p2) => {
          if (String(p2).includes("credentials.json")) return true;
          if (String(p2).includes("train.py")) return true;
          return String(p2) === "/mock-repo";
        });
        vi.mocked(readFileSync).mockReturnValue(
          JSON.stringify({ apiKey: "nk_new", privateKey: "0xDEF" }),
        );
        return "";
      }
      if (cmd.includes("--version")) return "Python 3.12.0";
      if (cmd.includes("pip show")) return "Name: nookplot-autoresearch";
      return "";
    });

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "quickstart-research", "--dir", "/mock-repo",
    ]).catch(() => {});

    expect(registerCalled).toBe(true);
  });
});

describe("quickstart-research Python detection", () => {
  it("exits if no Python 3.10+ found", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes("credentials.json")) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "nk_test", privateKey: "0x123" }),
    );

    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("--version")) throw new Error("not found");
      return "";
    });

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "quickstart-research", "--dir", "/mock-repo",
    ]).catch(() => {});

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("accepts Python 3.12", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes("credentials.json")) return true;
      if (String(p).includes("train.py")) return true;
      return String(p) === "/mock-repo";
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "nk_test", privateKey: "0x123" }),
    );

    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("python3 --version")) return "Python 3.12.1";
      if (cmd.includes("pip show")) return "Name: nookplot-autoresearch";
      return "";
    });

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "quickstart-research", "--dir", "/mock-repo",
    ]).catch(() => {});

    // Should have reached spawn (watcher start) — not exited early
    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe("quickstart-research watcher launch", () => {
  it("spawns nookplot-autoresearch watch with correct args", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes("credentials.json")) return true;
      if (String(p).includes("train.py")) return true;
      return String(p) === "/my/research";
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "nk_testkey", privateKey: "0xPK" }),
    );

    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("--version")) return "Python 3.11.0";
      if (cmd.includes("pip show")) return "Name: nookplot-autoresearch";
      return "";
    });

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "quickstart-research",
      "--dir", "/my/research",
      "--community", "ml-research",
    ]).catch(() => {});

    expect(mockSpawn).toHaveBeenCalledWith(
      "nookplot-autoresearch",
      expect.arrayContaining(["watch", expect.stringContaining("research"), "--community", "ml-research"]),
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({ NOOKPLOT_API_KEY: "nk_testkey" }),
      }),
    );
  });

  it("passes private key to watcher env", async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes("credentials.json")) return true;
      if (String(p).includes("train.py")) return true;
      return true;
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ apiKey: "nk_k", privateKey: "0xSECRET" }),
    );

    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("--version")) return "Python 3.10.0";
      if (cmd.includes("pip show")) return "Name: nookplot-autoresearch";
      return "";
    });

    const program = createProgram();
    await program.parseAsync([
      "node", "test", "quickstart-research", "--dir", "/repo",
    ]).catch(() => {});

    const spawnCall = mockSpawn.mock.calls[0];
    const env = (spawnCall[2] as { env: Record<string, string> }).env;
    expect(env.AGENT_PRIVATE_KEY).toBe("0xSECRET");
  });
});
