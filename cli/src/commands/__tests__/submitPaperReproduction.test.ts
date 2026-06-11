/**
 * `nookplot submit-paper-reproduction` — command registration + payload shape.
 *
 * The command is a thin wrapper around POST /v1/mining/challenges/:id/submit
 * that auto-generates a minimal trace for paper_reproduction submissions. The
 * critical contracts to lock down:
 *   1. Rejects non-paper challenges with a clear message.
 *   2. Sends { traceCid, traceHash, traceSummary, artifactCid, claimedMetricValue }.
 *   3. Requires claimedMetric to parse as a finite number (not NaN/Infinity).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// -- Mock modules before imports ----------------------------------------------

const mockGatewayRequest = vi.fn();

vi.mock("../../utils/http.js", () => ({
  gatewayRequest: (...args: unknown[]) => mockGatewayRequest(...args),
  isGatewayError: (res: { ok?: boolean }) => res?.ok === false,
}));

vi.mock("../../config.js", () => ({
  loadConfig: () => ({ gateway: "http://localhost:4022", apiKey: "test-key" }),
  validateConfig: () => [],
}));

vi.mock("chalk", () => ({
  default: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "default") return undefined;
        const fn = (s: string) => s;
        return new Proxy(fn, { get() { return (s: string) => s; }, apply(_f, _this, a) { return a[0]; } });
      },
    },
  ),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

const mockPrompt = vi.fn();
vi.mock("inquirer", () => ({
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

import {
  registerSubmitPaperReproductionCommand,
  savePendingSubmission,
  loadPendingSubmission,
  type PendingSubmission,
} from "../submitPaperReproduction.js";

// -- Helpers ------------------------------------------------------------------

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerSubmitPaperReproductionCommand(program);
  return program;
}

beforeEach(() => {
  mockGatewayRequest.mockReset();
  mockPrompt.mockReset();
});

describe("submit-paper-reproduction command registration", () => {
  it("registers the command with expected options", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "submit-paper-reproduction");
    expect(cmd).toBeDefined();
    const optNames = cmd!.options.map((o) => o.long);
    expect(optNames).toContain("--artifact-cid");
    expect(optNames).toContain("--claimed-metric");
    expect(optNames).toContain("--summary");
    expect(optNames).toContain("--model");
    expect(optNames).toContain("--json");
  });

  it("accepts a challengeId positional argument", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "submit-paper-reproduction");
    // Commander stores positional args in `_args` — one arg named `challengeId`.
    const args = (cmd as unknown as { _args: Array<{ _name: string; required: boolean }> })._args;
    expect(args).toHaveLength(1);
    expect(args[0]._name).toBe("challengeId");
    expect(args[0].required).toBe(true);
  });
});

describe("submit-paper-reproduction submit payload", () => {
  it("rejects non-paper_reproduction challenges with a pointer to the correct tool", async () => {
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: { id: "c1", title: "Not a paper", sourceType: "reasoning_trace" },
    }));
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called"); }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await program.parseAsync([
        "node", "nookplot", "submit-paper-reproduction", "c1",
        "--artifact-cid", "bafyArtifact", "--claimed-metric", "0.78",
      ]);
    } catch { /* swallow the exitOverride throw */ }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errSpy.mock.calls.flat().join("\n");
    // sourceType gets surfaced with the wrong-kind guidance pointing to the MCP tool.
    expect(errors).toMatch(/sourceType is 'reasoning_trace'/);
    expect(errors).toMatch(/nookplot_submit_reasoning_trace/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("rejects non-finite --claimed-metric BEFORE making any gateway call", async () => {
    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called"); }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await program.parseAsync([
        "node", "nookplot", "submit-paper-reproduction", "c1",
        "--artifact-cid", "bafyArtifact", "--claimed-metric", "not-a-number",
      ]);
    } catch { /* swallow */ }
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errSpy.mock.calls.flat().join("\n");
    expect(errors).toMatch(/finite number/i);
    // Zero gateway calls: validation is client-side.
    expect(mockGatewayRequest).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("uploads a minimal trace and POSTs the submission with paper-specific fields", async () => {
    // 1) GET challenge
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: {
        id: "c1",
        title: "MNIST repro",
        sourceType: "paper_reproduction",
        paperConfig: {
          target_metric_name: "test_accuracy",
          target_metric_value: "0.99",
          epsilon_sandbox: "0.02",
        },
      },
    }));
    // 2) POST /v1/ipfs/upload → returns CID
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: { cid: "bafyAutoTrace" },
    }));
    // 3) POST /v1/mining/challenges/:id/submit → returns submission
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true,
      status: 201,
      data: { id: "sub-1", challengeId: "c1", solverAddress: "0xdeadbeef" },
    }));

    const program = createProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await program.parseAsync([
      "node", "nookplot", "submit-paper-reproduction", "c1",
      "--artifact-cid", "bafyArtifact",
      "--claimed-metric", "0.985",
      "--summary", "Fine-tuned ResNet-18 on MNIST train split, lr=1e-3, 10 epochs, standard augmentation.",
      "--model", "claude-opus-4-7",
    ]);

    // Assert the three gateway calls in order.
    expect(mockGatewayRequest).toHaveBeenCalledTimes(3);
    const [_gwA, methA, pathA] = mockGatewayRequest.mock.calls[0];
    expect(methA).toBe("GET");
    expect(pathA).toBe("/v1/mining/challenges/c1");

    const [_gwB, methB, pathB, optsB] = mockGatewayRequest.mock.calls[1];
    expect(methB).toBe("POST");
    expect(pathB).toBe("/v1/ipfs/upload");
    expect((optsB as { body: { content: string } }).body.content).toMatch(/## Approach/);
    expect((optsB as { body: { content: string } }).body.content).toMatch(/bafyArtifact/);
    expect((optsB as { body: { content: string } }).body.content).toMatch(/0\.985/);

    const [_gwC, methC, pathC, optsC] = mockGatewayRequest.mock.calls[2];
    expect(methC).toBe("POST");
    expect(pathC).toBe("/v1/mining/challenges/c1/submit");
    const body = (optsC as { body: Record<string, unknown> }).body;
    expect(body.traceCid).toBe("bafyAutoTrace");
    expect(typeof body.traceHash).toBe("string");
    expect((body.traceHash as string).length).toBe(64);
    expect(body.artifactCid).toBe("bafyArtifact");
    expect(body.claimedMetricValue).toBe(0.985);
    expect(body.modelUsed).toBe("claude-opus-4-7");
    // traceSummary passthrough matches the flag (no interactive prompt because ≥50 chars).
    expect(body.traceSummary).toMatch(/Fine-tuned ResNet-18/);
    // Should not have prompted because summary met the 50-char floor.
    expect(mockPrompt).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("prompts for --summary when flag is missing or too short", async () => {
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      data: { id: "c1", title: "MNIST", sourceType: "paper_reproduction" },
    }));
    mockPrompt.mockImplementationOnce(async () => ({
      summary: "Interactive summary describing approach in sufficient detail well over the fifty char floor.",
    }));
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true, status: 200, data: { cid: "bafyAutoTrace" },
    }));
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true, status: 201, data: { id: "sub-1", challengeId: "c1", solverAddress: "0xabc" },
    }));

    const program = createProgram();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await program.parseAsync([
      "node", "nookplot", "submit-paper-reproduction", "c1",
      "--artifact-cid", "bafyArtifact",
      "--claimed-metric", "0.5",
      "--summary", "too short",
    ]);
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const body = (mockGatewayRequest.mock.calls[2][3] as { body: Record<string, unknown> }).body;
    expect(body.traceSummary).toMatch(/Interactive summary/);
    logSpy.mockRestore();
  });

  it("saves a pending submission after IPFS upload, clears it on successful POST", async () => {
    // Isolate from any real ~/.nookplot state — redirect HOME to a tmpdir.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nookplot-sub-ok-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200,
        data: { id: "c-ok", title: "X", sourceType: "paper_reproduction" },
      }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200, data: { cid: "bafyOk" },
      }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 201, data: { id: "sub-ok", challengeId: "c-ok", solverAddress: "0xabc" },
      }));
      const program = createProgram();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await program.parseAsync([
        "node", "nookplot", "submit-paper-reproduction", "c-ok",
        "--artifact-cid", "bafyArtifactOk",
        "--claimed-metric", "0.9",
        "--summary", "A sufficiently long summary explaining the model and training regimen used.",
      ]);
      // On success, the pending file must be cleared.
      const after = await loadPendingSubmission("c-ok");
      expect(after).toBeNull();
      logSpy.mockRestore();
    } finally {
      process.env.HOME = origHome;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("keeps the pending submission on gateway failure so next run can resume", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nookplot-sub-fail-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200,
        data: { id: "c-fail", title: "X", sourceType: "paper_reproduction" },
      }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200, data: { cid: "bafyFail" },
      }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: false, status: 502, error: "Bad gateway",
      }));
      const program = createProgram();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await program.parseAsync([
          "node", "nookplot", "submit-paper-reproduction", "c-fail",
          "--artifact-cid", "bafyArtifactFail",
          "--claimed-metric", "0.9",
          "--summary", "A sufficiently long summary explaining the model and training regimen used.",
        ]);
      } catch { /* exit */ }
      // On transient failure, pending file must remain so the next invocation
      // can reuse the pinned traceCid instead of re-uploading.
      const after = await loadPendingSubmission("c-fail");
      expect(after).not.toBeNull();
      expect(after!.traceCid).toBe("bafyFail");
      expect(after!.artifactCid).toBe("bafyArtifactFail");
      const errs = errSpy.mock.calls.flat().join("\n");
      expect(errs).toMatch(/trace pin is saved/i);
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
    } finally {
      process.env.HOME = origHome;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("reuses saved traceCid when rerun with the same artifact+metric+summary", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nookplot-sub-resume-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // Pre-seed a pending submission that matches what the next run will
      // compute (same artifact + metric + summary → same content → same
      // traceHash, so resume is offered).
      const summary = "Exact same summary string the resume path needs to match for resume to be offered.";
      const content =
        `## Approach\n${summary}\n\n` +
        `## Artifact\nIPFS: bafyArtifactResume\n\n` +
        `## Claimed\n0.9\n`;
      const crypto = await import("node:crypto");
      const traceHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
      const pending: PendingSubmission = {
        challengeId: "c-resume",
        traceCid: "bafyOriginallyPinned",
        traceHash,
        traceSummary: summary,
        artifactCid: "bafyArtifactResume",
        claimedMetricValue: 0.9,
        savedAt: new Date().toISOString(),
      };
      await savePendingSubmission(pending);
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200,
        data: { id: "c-resume", title: "X", sourceType: "paper_reproduction" },
      }));
      mockPrompt.mockImplementationOnce(async () => ({ resume: true }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 201,
        data: { id: "sub-resume", challengeId: "c-resume", solverAddress: "0xabc" },
      }));
      const program = createProgram();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await program.parseAsync([
        "node", "nookplot", "submit-paper-reproduction", "c-resume",
        "--artifact-cid", "bafyArtifactResume",
        "--claimed-metric", "0.9",
        "--summary", summary,
      ]);
      // Two calls total: GET challenge + POST submit. The IPFS upload MUST
      // have been skipped because we resumed the saved traceCid.
      expect(mockGatewayRequest).toHaveBeenCalledTimes(2);
      const submitBody = (mockGatewayRequest.mock.calls[1][3] as { body: { traceCid: string } }).body;
      expect(submitBody.traceCid).toBe("bafyOriginallyPinned");
      logSpy.mockRestore();
    } finally {
      process.env.HOME = origHome;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("discards stale pending submission when artifact CID changes", async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nookplot-sub-stale-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // Pre-seed a pending submission with a different artifact — the resume
      // prompt must NOT trigger, and a fresh upload must run.
      await savePendingSubmission({
        challengeId: "c-stale",
        traceCid: "bafyStaleOldPin",
        traceHash: "deadbeef".repeat(8),
        traceSummary: "stale",
        artifactCid: "bafyOldArtifact",
        claimedMetricValue: 0.5,
        savedAt: new Date().toISOString(),
      });
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200,
        data: { id: "c-stale", title: "X", sourceType: "paper_reproduction" },
      }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 200, data: { cid: "bafyFreshPin" },
      }));
      mockGatewayRequest.mockImplementationOnce(async () => ({
        ok: true, status: 201, data: { id: "sub-stale", challengeId: "c-stale", solverAddress: "0xabc" },
      }));
      const program = createProgram();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      await program.parseAsync([
        "node", "nookplot", "submit-paper-reproduction", "c-stale",
        "--artifact-cid", "bafyNewArtifact",   // DIFFERENT artifact
        "--claimed-metric", "0.9",
        "--summary", "A sufficiently long summary explaining the model and training regimen used.",
      ]);
      // No resume prompt (stale pending is discarded silently).
      expect(mockPrompt).not.toHaveBeenCalled();
      // Fresh upload was performed.
      expect(mockGatewayRequest).toHaveBeenCalledTimes(3);
      const submitBody = (mockGatewayRequest.mock.calls[2][3] as { body: { traceCid: string } }).body;
      expect(submitBody.traceCid).toBe("bafyFreshPin");
      logSpy.mockRestore();
    } finally {
      process.env.HOME = origHome;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("warns on METRIC_OUT_OF_RANGE and suggests retrying against the reference bundle", async () => {
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      data: {
        id: "c1", title: "MNIST", sourceType: "paper_reproduction",
        paperConfig: { target_metric_name: "acc", target_metric_value: "0.99", epsilon_sandbox: "0.01" },
      },
    }));
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: true, status: 200, data: { cid: "bafyAutoTrace" },
    }));
    mockGatewayRequest.mockImplementationOnce(async () => ({
      ok: false, status: 422, error: "METRIC_OUT_OF_RANGE",
    }));

    const program = createProgram();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called"); }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await program.parseAsync([
        "node", "nookplot", "submit-paper-reproduction", "c1",
        "--artifact-cid", "bafyArtifact",
        "--claimed-metric", "0.50",  // well below the 0.98-1.00 window
        "--summary", "A deliberately out-of-range metric claim to trigger the gateway validation error path.",
      ]);
    } catch { /* exit override */ }
    const errs = errSpy.mock.calls.flat().join("\n");
    expect(errs).toMatch(/METRIC_OUT_OF_RANGE/);
    expect(errs).toMatch(/submission window/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
