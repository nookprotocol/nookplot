/**
 * Unit tests for the doom-loop detector — TS parity with
 * runtime-py/tests/test_doom_loop.py.
 */

import { describe, expect, it } from "vitest";

import {
  buildCorrectivePrompt,
  checkForDoomLoop,
  checkForDoomLoopFromSignatures,
  detectIdenticalConsecutive,
  detectRepeatingSequence,
  extractRecentToolSignatures,
  makeSignature,
  type ToolCallSignature,
} from "../doomLoop.js";

function msg(name: string, args: Record<string, unknown> = {}): unknown {
  return {
    role: "assistant",
    tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
  };
}

function sig(name: string, args: Record<string, unknown> = {}): ToolCallSignature {
  return makeSignature(name, args);
}

// ---------------------------------------------------------------------------
//  Doom-loop detector spec
// ---------------------------------------------------------------------------

describe("checkForDoomLoop — roadmap spec", () => {
  it("returns tool name on 3 identical consecutive calls", () => {
    const msgs = Array.from({ length: 3 }, () => msg("search_knowledge", { q: "x" }));
    expect(checkForDoomLoop(msgs)).toBe("search_knowledge");
  });

  it("returns null on 2 identical calls", () => {
    const msgs = [msg("search_knowledge", { q: "x" }), msg("search_knowledge", { q: "x" })];
    expect(checkForDoomLoop(msgs)).toBeNull();
  });

  it("returns tool name on A,B,A,B pattern", () => {
    const msgs = [msg("A"), msg("B"), msg("A"), msg("B")];
    expect(checkForDoomLoop(msgs)).toBe("A");
  });

  it("returns null on A,B,A (< 2 full reps)", () => {
    const msgs = [msg("A"), msg("B"), msg("A")];
    expect(checkForDoomLoop(msgs)).toBeNull();
  });

  it("returns null when no messages have tool_calls", () => {
    const msgs = Array.from({ length: 5 }, () => ({ role: "assistant", content: "think" }));
    expect(checkForDoomLoop(msgs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Signature hashing
// ---------------------------------------------------------------------------

describe("makeSignature / argsHash", () => {
  it("stable across key order", () => {
    const a = makeSignature("x", { a: 1, b: 2 });
    const b = makeSignature("x", { b: 2, a: 1 });
    expect(a.argsHash).toBe(b.argsHash);
  });

  it("changes with values", () => {
    expect(makeSignature("x", { q: "a" }).argsHash).not.toBe(
      makeSignature("x", { q: "b" }).argsHash,
    );
  });
});

// ---------------------------------------------------------------------------
//  extractRecentToolSignatures
// ---------------------------------------------------------------------------

describe("extractRecentToolSignatures", () => {
  it("skips non-assistant messages", () => {
    const msgs = [
      { role: "user", content: "go" },
      msg("A"),
      { role: "tool", content: "result" },
      msg("A"),
    ];
    const sigs = extractRecentToolSignatures(msgs);
    expect(sigs).toHaveLength(2);
    expect(sigs[0]!.name).toBe("A");
  });

  it("honors lookback", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => msg(`tool_${i}`));
    const sigs = extractRecentToolSignatures(msgs, 5);
    expect(sigs).toHaveLength(5);
    expect(sigs.at(-1)!.name).toBe("tool_49");
  });

  it("returns empty for empty input", () => {
    expect(extractRecentToolSignatures([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  Detection primitives
// ---------------------------------------------------------------------------

describe("detectIdenticalConsecutive", () => {
  it("returns null when args differ", () => {
    const sigs = [sig("search", { q: "a" }), sig("search", { q: "b" }), sig("search", { q: "c" })];
    expect(detectIdenticalConsecutive(sigs, 3)).toBeNull();
  });

  it("returns name on 3 identical", () => {
    const sigs = Array.from({ length: 3 }, () => sig("search", { q: "x" }));
    expect(detectIdenticalConsecutive(sigs, 3)).toBe("search");
  });

  it("resets on different sig between runs", () => {
    const sigs = [sig("A"), sig("A"), sig("B"), sig("A"), sig("A")];
    expect(detectIdenticalConsecutive(sigs, 3)).toBeNull();
  });

  it("respects custom threshold", () => {
    expect(detectIdenticalConsecutive(Array.from({ length: 4 }, () => sig("A")), 4)).toBe("A");
    expect(detectIdenticalConsecutive(Array.from({ length: 3 }, () => sig("A")), 4)).toBeNull();
  });
});

describe("detectRepeatingSequence", () => {
  it("finds A,B,A,B", () => {
    const sigs = [sig("A"), sig("B"), sig("A"), sig("B")];
    const pattern = detectRepeatingSequence(sigs);
    expect(pattern).not.toBeNull();
    expect(pattern!.map(s => s.name)).toEqual(["A", "B"]);
  });

  it("finds A,B,C repeated", () => {
    const sigs = ["A", "B", "C", "A", "B", "C"].map(n => sig(n));
    const pattern = detectRepeatingSequence(sigs);
    expect(pattern!.map(s => s.name)).toEqual(["A", "B", "C"]);
  });

  it("returns null on no pattern", () => {
    const sigs = ["A", "B", "C", "D", "E"].map(n => sig(n));
    expect(detectRepeatingSequence(sigs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  checkForDoomLoopFromSignatures
// ---------------------------------------------------------------------------

describe("checkForDoomLoopFromSignatures", () => {
  it("detects 3 identical", () => {
    expect(checkForDoomLoopFromSignatures(Array.from({ length: 3 }, () => sig("X")))).toBe("X");
  });

  it("detects A,B,A,B", () => {
    expect(
      checkForDoomLoopFromSignatures([sig("A"), sig("B"), sig("A"), sig("B")]),
    ).toBe("A");
  });

  it("returns null under threshold", () => {
    expect(checkForDoomLoopFromSignatures([sig("A"), sig("A")])).toBeNull();
  });

  it("returns null on empty", () => {
    expect(checkForDoomLoopFromSignatures([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  buildCorrectivePrompt
// ---------------------------------------------------------------------------

describe("buildCorrectivePrompt", () => {
  it("mentions the offender", () => {
    const m = buildCorrectivePrompt("search_knowledge");
    expect(m).toContain("search_knowledge");
    expect(m).toMatch(/Doom loop/i);
  });
});
