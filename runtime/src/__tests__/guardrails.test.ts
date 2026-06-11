/**
 * GuardrailRegistry — unit tests.
 *
 * Covers: pass-through, partial mutation, error wrapping, ordering,
 * disposer behavior, output-guardrail merge semantics, withGuardrails
 * standalone wrapper.
 */
import { describe, it, expect } from "vitest";
import {
  GuardrailRegistry,
  GuardrailTripped,
  InputGuardrailTripped,
  OutputGuardrailTripped,
  withGuardrails,
} from "../guardrails.js";

describe("GuardrailRegistry — input", () => {
  it("returns args unchanged when no guardrails registered", async () => {
    const reg = new GuardrailRegistry();
    const out = await reg.runInput("send_dm", { to: "0xABC", content: "hi" });
    expect(out).toEqual({ to: "0xABC", content: "hi" });
  });

  it("guardrail returning undefined is a pass-through", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { input: [() => undefined] });
    const out = await reg.runInput("send_dm", { to: "0x1", content: "hi" });
    expect(out).toEqual({ to: "0x1", content: "hi" });
  });

  it("guardrail returning Partial<TArgs> shallow-merges", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", {
      input: [({ content }) => ({ content: `[REDACTED:${(content as string).length}]` })],
    });
    const out = await reg.runInput("send_dm", { to: "0x1", content: "secret" });
    expect(out).toEqual({ to: "0x1", content: "[REDACTED:6]" });
  });

  it("multiple guardrails compose in declared order", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", {
      input: [
        () => ({ content: "first" }),
        ({ content }) => ({ content: `${content as string}+second` }),
      ],
    });
    const out = await reg.runInput("send_dm", { to: "0x1", content: "raw" });
    expect(out.content).toBe("first+second");
  });

  it("InputGuardrailTripped is re-thrown as-is", async () => {
    const reg = new GuardrailRegistry();
    const err = new InputGuardrailTripped("invalid recipient");
    reg.register("send_dm", { input: [() => { throw err; }] });
    await expect(reg.runInput("send_dm", { to: "" })).rejects.toBe(err);
  });

  it("non-guardrail errors get wrapped with the original as cause", async () => {
    const reg = new GuardrailRegistry();
    const inner = new Error("boom");
    reg.register("send_dm", { input: [() => { throw inner; }] });
    await expect(reg.runInput("send_dm", { to: "0x1" }))
      .rejects.toMatchObject({
        name: "InputGuardrailTripped",
        message: expect.stringContaining("boom"),
        cause: inner,
      });
  });

  it("InputGuardrailTripped is also a GuardrailTripped", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { input: [() => { throw new InputGuardrailTripped("x"); }] });
    try {
      await reg.runInput("send_dm", {});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailTripped);
      expect(err).toBeInstanceOf(InputGuardrailTripped);
    }
  });

  it("the original args object is not mutated", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { input: [() => ({ content: "modified" })] });
    const original = { to: "0x1", content: "raw" };
    await reg.runInput("send_dm", original);
    expect(original).toEqual({ to: "0x1", content: "raw" });
  });

  it("async guardrails are awaited", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", {
      input: [
        async ({ content }) => {
          await new Promise((r) => setTimeout(r, 10));
          return { content: `${content}-awaited` };
        },
      ],
    });
    const out = await reg.runInput("send_dm", { to: "0x1", content: "x" });
    expect(out.content).toBe("x-awaited");
  });
});

describe("GuardrailRegistry — output", () => {
  it("returns result unchanged when no guardrails registered", async () => {
    const reg = new GuardrailRegistry();
    const out = await reg.runOutput("send_dm", { messageId: "m1" });
    expect(out).toEqual({ messageId: "m1" });
  });

  it("output guardrail returning Partial merges onto result", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", {
      output: [() => ({ scrubbed: true })],
    });
    const out = await reg.runOutput("send_dm", { messageId: "m1" });
    expect(out).toEqual({ messageId: "m1", scrubbed: true });
  });

  it("output guardrail cannot drop security-critical fields silently", async () => {
    // Returning a partial CANNOT replace the whole result — txHash survives.
    const reg = new GuardrailRegistry();
    reg.register("create_bounty", {
      output: [() => ({ logged: true })],
    });
    const out = await reg.runOutput("create_bounty", {
      txHash: "0xCRITICAL",
      bountyId: 42,
    });
    expect(out).toEqual({ txHash: "0xCRITICAL", bountyId: 42, logged: true });
  });

  it("OutputGuardrailTripped is re-thrown as-is", async () => {
    const reg = new GuardrailRegistry();
    const err = new OutputGuardrailTripped("bad result");
    reg.register("send_dm", { output: [() => { throw err; }] });
    await expect(reg.runOutput("send_dm", {})).rejects.toBe(err);
  });

  it("non-guardrail errors in output get wrapped", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { output: [() => { throw new Error("bad"); }] });
    await expect(reg.runOutput("send_dm", {}))
      .rejects.toMatchObject({
        name: "OutputGuardrailTripped",
        message: expect.stringContaining("bad"),
      });
  });

  it("non-object results are returned unchanged even if guardrail returns a partial", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { output: [() => ({ extra: 1 })] });
    // Result is a string — there's nothing to merge into.
    const out = await reg.runOutput("send_dm", "ok");
    expect(out).toBe("ok");
  });

  it("output guardrail returning { txHash: undefined } cannot drop txHash", async () => {
    const reg = new GuardrailRegistry();
    reg.register("create_bounty", {
      output: [() => ({ txHash: undefined, logged: true })],
    });
    const out = await reg.runOutput("create_bounty", {
      txHash: "0xCRITICAL",
      bountyId: 42,
    });
    expect(out).toEqual({ txHash: "0xCRITICAL", bountyId: 42, logged: true });
  });

  it("input guardrail returning { field: undefined } cannot drop the field", async () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", {
      input: [() => ({ to: undefined, content: "sanitized" })],
    });
    const out = await reg.runInput<Record<string, unknown>>("send_dm", {
      to: "0xADDR",
      content: "raw",
    });
    expect(out).toEqual({ to: "0xADDR", content: "sanitized" });
  });

  it("output guardrail returning empty object preserves all original fields", async () => {
    const reg = new GuardrailRegistry();
    reg.register("create_bounty", { output: [() => ({})] });
    const out = await reg.runOutput("create_bounty", {
      txHash: "0xabc",
      signature: "0xsig",
      bountyId: 1,
    });
    expect(out).toEqual({ txHash: "0xabc", signature: "0xsig", bountyId: 1 });
  });

  it("original result reference is not mutated by output guardrail merge", async () => {
    const reg = new GuardrailRegistry();
    reg.register("create_bounty", { output: [() => ({ extra: "tag" })] });
    const original = { txHash: "0xabc", bountyId: 1 };
    const out = await reg.runOutput("create_bounty", original);
    expect(original).toEqual({ txHash: "0xabc", bountyId: 1 }); // untouched
    expect(out).toEqual({ txHash: "0xabc", bountyId: 1, extra: "tag" });
  });
});

describe("GuardrailRegistry — registration", () => {
  it("disposer returned by register() removes only that call's guardrails", async () => {
    const reg = new GuardrailRegistry();
    const dispose = reg.register("send_dm", {
      input: [() => ({ content: "first" })],
    });
    reg.register("send_dm", {
      input: [() => ({ content: "second" })],
    });

    expect(reg.countInput("send_dm")).toBe(2);
    dispose();
    expect(reg.countInput("send_dm")).toBe(1);
    const out = await reg.runInput<Record<string, unknown>>("send_dm", { to: "0x1" });
    expect(out.content).toBe("second");
  });

  it("clear(actionType) removes only that action's guardrails", () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { input: [() => undefined] });
    reg.register("create_bounty", { input: [() => undefined] });
    reg.clear("send_dm");
    expect(reg.countInput("send_dm")).toBe(0);
    expect(reg.countInput("create_bounty")).toBe(1);
  });

  it("clear() removes all guardrails", () => {
    const reg = new GuardrailRegistry();
    reg.register("send_dm", { input: [() => undefined], output: [() => undefined] });
    reg.register("create_bounty", { input: [() => undefined] });
    reg.clear();
    expect(reg.countInput("send_dm")).toBe(0);
    expect(reg.countOutput("send_dm")).toBe(0);
    expect(reg.countInput("create_bounty")).toBe(0);
  });

  it("registering an empty set is a no-op (returns no-op disposer)", () => {
    const reg = new GuardrailRegistry();
    const dispose = reg.register("send_dm", {});
    expect(reg.countInput("send_dm")).toBe(0);
    expect(() => dispose()).not.toThrow();
  });
});

describe("withGuardrails (standalone wrapper)", () => {
  it("wraps a handler with input + output guardrails", async () => {
    const wrapped = withGuardrails<{ value: number }, { doubled: number }>(
      async ({ value }) => ({ doubled: value * 2 }),
      {
        input: [({ value }) => {
          if (value < 0) throw new InputGuardrailTripped("negative");
        }],
        output: [({ doubled }) => {
          if (doubled > 100) throw new OutputGuardrailTripped("too big");
        }],
      },
    );

    expect(await wrapped({ value: 5 })).toEqual({ doubled: 10 });
    await expect(wrapped({ value: -1 })).rejects.toBeInstanceOf(InputGuardrailTripped);
    await expect(wrapped({ value: 51 })).rejects.toBeInstanceOf(OutputGuardrailTripped);
  });
});
