/**
 * manifestActivationHook contract tests.
 *
 * Stub-based unit tests against `installManifestActivationHook(runtime, opts)`.
 * The runtime is a minimal mock — `hooks` is a fresh `HookRegistry` per test
 * so listeners never leak; `manifests` is a vi.fn() bag covering the methods
 * the hook calls (`setFocus`, `updateManifest`, `getMyManifest`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../hooks.js";
import {
  installManifestActivationHook,
  TASK_BEARING_SIGNALS,
  TERMINAL_ACTIONS,
  extractDomain,
} from "../manifestActivationHook.js";
import type { NookplotRuntime } from "../index.js";
import type { SignalEvent } from "../autonomous.js";

interface ManifestStubs {
  setFocus: ReturnType<typeof vi.fn>;
  updateManifest: ReturnType<typeof vi.fn>;
  getMyManifest: ReturnType<typeof vi.fn>;
}

function makeRuntime(initialUncertainties: unknown[] = []): {
  runtime: NookplotRuntime;
  hooks: HookRegistry;
  manifests: ManifestStubs;
} {
  const hooks = new HookRegistry();
  const manifests: ManifestStubs = {
    setFocus: vi.fn().mockResolvedValue({ agentId: "a1", currentFocus: null }),
    updateManifest: vi.fn().mockResolvedValue({ agentId: "a1", currentFocus: null }),
    getMyManifest: vi.fn().mockResolvedValue({
      agentId: "a1",
      uncertainties: initialUncertainties,
    }),
  };
  const runtime = { hooks, manifests } as unknown as NookplotRuntime;
  return { runtime, hooks, manifests };
}

async function flush() {
  // Hooks fire via `Promise.resolve()`-scheduled emits; one microtask flush
  // is enough for the sync-look listeners. The async appendUncertainty path
  // chains a getMyManifest then updateManifest — give it three rounds.
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

describe("manifestActivationHook — installer", () => {
  it("registers four listeners and the disposer removes them all", () => {
    const { runtime, hooks } = makeRuntime();
    expect(hooks.count("signal_received")).toBe(0);
    expect(hooks.count("action_end")).toBe(0);
    expect(hooks.count("action_error")).toBe(0);
    expect(hooks.count("doom_loop_detected")).toBe(0);

    const dispose = installManifestActivationHook(runtime);
    expect(hooks.count("signal_received")).toBe(1);
    expect(hooks.count("action_end")).toBe(1);
    expect(hooks.count("action_error")).toBe(1);
    expect(hooks.count("doom_loop_detected")).toBe(1);

    dispose();
    expect(hooks.count("signal_received")).toBe(0);
    expect(hooks.count("action_end")).toBe(0);
    expect(hooks.count("action_error")).toBe(0);
    expect(hooks.count("doom_loop_detected")).toBe(0);
  });

  it("uses the registry from opts when provided", () => {
    const { runtime, hooks: runtimeHooks } = makeRuntime();
    const optsHooks = new HookRegistry();
    installManifestActivationHook(runtime, { hooks: optsHooks });
    expect(optsHooks.count("signal_received")).toBe(1);
    expect(runtimeHooks.count("signal_received")).toBe(0);
  });
});

describe("manifestActivationHook — signal_received → setFocus", () => {
  it("calls setFocus for a task-bearing signal with extracted domain", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("signal_received", {
      signalType: "mining_opportunity",
      domainTags: ["solidity-security"],
    } as unknown as SignalEvent);
    await flush();

    expect(manifests.setFocus).toHaveBeenCalledTimes(1);
    expect(manifests.setFocus).toHaveBeenCalledWith({
      taskType: "mining_opportunity",
      domain: "solidity-security",
    });
  });

  it("skips setFocus for non-allowlisted (social) signals", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("signal_received", { signalType: "channel_message" } as SignalEvent);
    await hooks.emit("signal_received", { signalType: "dm_received" } as SignalEvent);
    await hooks.emit("signal_received", { signalType: "new_follower" } as SignalEvent);
    await flush();

    expect(manifests.setFocus).not.toHaveBeenCalled();
  });

  it("falls back to 'general' when no domain hint is present", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("signal_received", { signalType: "bounty" } as SignalEvent);
    await flush();

    expect(manifests.setFocus).toHaveBeenCalledWith({
      taskType: "bounty",
      domain: "general",
    });
  });

  it("swallows manifest write rejections so the agent loop is unaffected", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    manifests.setFocus.mockRejectedValueOnce(new Error("gateway down"));
    installManifestActivationHook(runtime);

    // The handler is sync-look; emit.allSettled inside HookRegistry plus our
    // .catch swallow means this must NOT throw.
    await expect(
      hooks.emit("signal_received", {
        signalType: "task_assigned",
        domain: "data-science",
      } as unknown as SignalEvent),
    ).resolves.toBeUndefined();
  });
});

describe("manifestActivationHook — action_end → clearFocus", () => {
  it("clears focus on a terminal action", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("action_end", {
      actionType: "submit_mining_solution",
      args: {},
      result: {},
      durationMs: 100,
    });
    await flush();

    expect(manifests.updateManifest).toHaveBeenCalledTimes(1);
    expect(manifests.updateManifest).toHaveBeenCalledWith({ currentFocus: null });
  });

  it("does NOT clear focus on a non-terminal action", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("action_end", {
      actionType: "browse_tools",
      args: {},
      result: {},
      durationMs: 100,
    });
    await hooks.emit("action_end", {
      actionType: "get_my_balance",
      args: {},
      result: {},
      durationMs: 100,
    });
    await flush();

    expect(manifests.updateManifest).not.toHaveBeenCalled();
  });
});

describe("manifestActivationHook — action_error debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not write after 1 error", async () => {
    vi.useRealTimers();
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("action_error", {
      actionType: "submit_mining_solution",
      args: {},
      error: new Error("network blip"),
      durationMs: 100,
    });
    await flush();

    expect(manifests.getMyManifest).not.toHaveBeenCalled();
    expect(manifests.updateManifest).not.toHaveBeenCalled();
  });

  it("writes one uncertainty after 3 errors of the same actionType inside the window", async () => {
    vi.useRealTimers();
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    for (let i = 0; i < 3; i++) {
      await hooks.emit("action_error", {
        actionType: "submit_mining_solution",
        args: {},
        error: new Error(`fail-${i}`),
        durationMs: 50,
      });
    }
    await flush();

    expect(manifests.getMyManifest).toHaveBeenCalledTimes(1);
    expect(manifests.updateManifest).toHaveBeenCalledTimes(1);
    const call = manifests.updateManifest.mock.calls[0]![0] as {
      uncertainties: Array<{ description: string; valueOfResolution: number }>;
    };
    expect(call.uncertainties).toHaveLength(1);
    expect(call.uncertainties[0].description).toContain("Stuck on submit_mining_solution");
    expect(call.uncertainties[0].description).toContain("fail-2");
    expect(call.uncertainties[0].valueOfResolution).toBe(0.7);
  });

  it("resets the counter when errors are spread beyond the window", async () => {
    vi.useRealTimers();
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime, { errorDebounceWindowMs: 50 });

    await hooks.emit("action_error", {
      actionType: "deliver_work",
      args: {},
      error: new Error("a"),
      durationMs: 0,
    });
    await new Promise((r) => setTimeout(r, 80)); // exceeds 50ms window
    await hooks.emit("action_error", {
      actionType: "deliver_work",
      args: {},
      error: new Error("b"),
      durationMs: 0,
    });
    await flush();

    // First error opens window, second resets — only 2 emissions, no 3rd inside window.
    expect(manifests.updateManifest).not.toHaveBeenCalled();
  });

  it("does not conflate counters across different actionTypes", async () => {
    vi.useRealTimers();
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("action_error", { actionType: "A", args: {}, error: new Error("x"), durationMs: 0 });
    await hooks.emit("action_error", { actionType: "B", args: {}, error: new Error("x"), durationMs: 0 });
    await hooks.emit("action_error", { actionType: "A", args: {}, error: new Error("x"), durationMs: 0 });
    await flush();

    // 2 A errors + 1 B error → no threshold trip.
    expect(manifests.updateManifest).not.toHaveBeenCalled();
  });
});

describe("manifestActivationHook — doom_loop_detected", () => {
  it("appends an uncertainty unconditionally", async () => {
    const { runtime, hooks, manifests } = makeRuntime();
    installManifestActivationHook(runtime);

    await hooks.emit("doom_loop_detected", {
      offender: "submit_mining_solution",
      triggers: 1,
      actionType: "submit_mining_solution",
    });
    await flush();

    expect(manifests.updateManifest).toHaveBeenCalledTimes(1);
    const call = manifests.updateManifest.mock.calls[0]![0] as {
      uncertainties: Array<{ description: string; valueOfResolution: number }>;
    };
    expect(call.uncertainties[0].description).toBe("Doom loop on submit_mining_solution");
    expect(call.uncertainties[0].valueOfResolution).toBe(0.9);
  });
});

describe("manifestActivationHook — uncertainty cap", () => {
  it("drops the oldest entry FIFO when at the 20-cap", async () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({
      description: `old-${i}`,
      valueOfResolution: 0.5,
    }));
    const { runtime, hooks, manifests } = makeRuntime(existing);
    installManifestActivationHook(runtime);

    await hooks.emit("doom_loop_detected", {
      offender: "X",
      triggers: 1,
      actionType: "X",
    });
    await flush();

    const call = manifests.updateManifest.mock.calls[0]![0] as {
      uncertainties: Array<{ description: string }>;
    };
    expect(call.uncertainties).toHaveLength(20);
    // Oldest dropped, newest appended.
    expect(call.uncertainties[0].description).toBe("old-1");
    expect(call.uncertainties[19].description).toBe("Doom loop on X");
  });

  it("respects a custom cap", async () => {
    const existing = Array.from({ length: 5 }, (_, i) => ({
      description: `old-${i}`,
      valueOfResolution: 0.5,
    }));
    const { runtime, hooks, manifests } = makeRuntime(existing);
    installManifestActivationHook(runtime, { maxUncertainties: 5 });

    await hooks.emit("doom_loop_detected", {
      offender: "Y",
      triggers: 1,
      actionType: "Y",
    });
    await flush();

    const call = manifests.updateManifest.mock.calls[0]![0] as {
      uncertainties: Array<{ description: string }>;
    };
    expect(call.uncertainties).toHaveLength(5);
    expect(call.uncertainties[4].description).toBe("Doom loop on Y");
  });
});

describe("manifestActivationHook — extractDomain", () => {
  it("prefers domainTags[0] when present", () => {
    expect(extractDomain({ signalType: "x", domainTags: ["alpha", "beta"] } as unknown as SignalEvent))
      .toBe("alpha");
  });
  it("falls back to domain field", () => {
    expect(extractDomain({ signalType: "x", domain: "bio" } as unknown as SignalEvent))
      .toBe("bio");
  });
  it("falls back to skillDomain", () => {
    expect(extractDomain({ signalType: "x", skillDomain: "code-review" } as unknown as SignalEvent))
      .toBe("code-review");
  });
  it("falls back to metadata.domain", () => {
    expect(
      extractDomain({ signalType: "x", metadata: { domain: "math" } } as unknown as SignalEvent),
    ).toBe("math");
  });
  it("falls back to community when present", () => {
    expect(extractDomain({ signalType: "x", community: "defi" } as SignalEvent)).toBe("defi");
  });
  it("returns 'general' as last resort", () => {
    expect(extractDomain({ signalType: "x" } as SignalEvent)).toBe("general");
  });
  it("ignores empty domainTags array", () => {
    expect(extractDomain({ signalType: "x", domainTags: [] } as unknown as SignalEvent))
      .toBe("general");
  });
});

describe("manifestActivationHook — allowlists", () => {
  it("TASK_BEARING_SIGNALS is non-empty and excludes social signals", () => {
    expect(TASK_BEARING_SIGNALS.size).toBeGreaterThan(10);
    expect(TASK_BEARING_SIGNALS.has("channel_message")).toBe(false);
    expect(TASK_BEARING_SIGNALS.has("dm_received")).toBe(false);
    expect(TASK_BEARING_SIGNALS.has("new_follower")).toBe(false);
    expect(TASK_BEARING_SIGNALS.has("attestation_received")).toBe(false);
    expect(TASK_BEARING_SIGNALS.has("welcome_guide")).toBe(false);
  });
  it("TERMINAL_ACTIONS includes the canonical work-completion actions", () => {
    expect(TERMINAL_ACTIONS.has("submit_mining_solution")).toBe(true);
    expect(TERMINAL_ACTIONS.has("deliver_work")).toBe(true);
    expect(TERMINAL_ACTIONS.has("mark_task_done")).toBe(true);
    expect(TERMINAL_ACTIONS.has("resolve_clarification")).toBe(true);
  });
  it("TERMINAL_ACTIONS excludes read-only / browse actions", () => {
    expect(TERMINAL_ACTIONS.has("browse_tools")).toBe(false);
    expect(TERMINAL_ACTIONS.has("get_my_balance")).toBe(false);
    expect(TERMINAL_ACTIONS.has("nookplot_get_manifest")).toBe(false);
  });
});
