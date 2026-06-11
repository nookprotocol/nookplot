/**
 * Guardrails — declarative per-action parameter validation.
 *
 * A guardrail is a function attached to a specific `actionType`. It can:
 *   - **Pass** by returning `undefined` / nothing.
 *   - **Mutate args** by returning `Partial<TArgs>` — declared keys overwrite,
 *     undeclared keys are preserved.
 *   - **Block** by throwing `InputGuardrailTripped` (input) or
 *     `OutputGuardrailTripped` (output). The wrapped dispatcher converts any
 *     other error into an `InputGuardrailTripped` so callers always observe
 *     a single error class for "validation failure".
 *
 * This is a SEPARATE concern from `contentSafety` (string sanitizers) and
 * the gateway's threat-detection layer — guardrails operate on typed
 * arg objects scoped to a specific action, see those args, and can short-
 * circuit the dispatch. All three layers can run on the same call.
 *
 * Composition order at the dispatcher (`autonomous.ts`
 * `handleActionRequest`):
 *   1. `action_start` hook fires.
 *   2. `tool_input` hook fires.
 *   3. Input guardrails run in declared order; first throw → `action_error`.
 *   4. Action body executes.
 *   5. `tool_output` hook fires.
 *   6. Output guardrails run; first throw → `action_error`.
 *   7. `action_end` hook fires.
 *
 * @example
 * ```ts
 * runtime.guardrails.register("send_dm", {
 *   input: [
 *     ({ to }) => {
 *       if (!/^0x[0-9a-fA-F]{40}$/.test(to as string)) {
 *         throw new InputGuardrailTripped("`to` must be a 0x-prefixed 40-hex address");
 *       }
 *     },
 *     ({ content }) => ({ content: sanitizeForPrompt(content as string, 2000) }),
 *   ],
 * });
 * ```
 *
 * @module guardrails
 */
import { hooks as defaultHooks, type HookRegistry } from "./hooks.js";

// ── Errors ───────────────────────────────────────────────────

/** Base class for guardrail short-circuits. Catch this to handle either side. */
export class GuardrailTripped extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "GuardrailTripped";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Thrown when an input guardrail rejects or any guardrail callback throws
 *  during the input phase. The dispatcher converts this into `action_error`. */
export class InputGuardrailTripped extends GuardrailTripped {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InputGuardrailTripped";
  }
}

/** Thrown when an output guardrail rejects. The dispatcher converts this
 *  into `action_error` after the action body has already executed. */
export class OutputGuardrailTripped extends GuardrailTripped {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutputGuardrailTripped";
  }
}

// ── Types ────────────────────────────────────────────────────

/**
 * An input guardrail. Receives the (possibly mutated) args from prior
 * guardrails. Returns `void` to pass, `Partial<TArgs>` to mutate, or throws
 * `InputGuardrailTripped` to block.
 *
 * TS does not introspect parameter names — the caller declares which keys
 * the guardrail accepts via the `Pick<TArgs, …>` type. Returned objects are
 * shallow-merged onto args; undeclared keys in the return value are still
 * applied (TS can't enforce param-binding at runtime), but agents should
 * stick to the declared keys for parity with the Python `inspect.signature`
 * extraction.
 */
export type InputGuardrail<TArgs extends Record<string, unknown> = Record<string, unknown>> = (
  args: TArgs,
) => void | undefined | Partial<TArgs> | Promise<void | undefined | Partial<TArgs>>;

/**
 * An output guardrail. Receives the action result. Returns `void` to pass,
 * `Partial<TResult>` to mutate, or throws `OutputGuardrailTripped` to block.
 *
 * Output guardrails CANNOT replace the entire result — the merge is shallow
 * AND `undefined` values in the return are filtered out before merge. This
 * means a guardrail cannot silently drop security-critical fields (`txHash`,
 * `signature`) by returning `{ txHash: undefined }`. To intentionally clear
 * a field, throw `OutputGuardrailTripped` instead.
 */
export type OutputGuardrail<TResult = unknown> = (
  result: TResult,
) => void | undefined | Partial<TResult> | Promise<void | undefined | Partial<TResult>>;

export interface GuardrailSet<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  input?: InputGuardrail<TArgs>[];
  output?: OutputGuardrail<TResult>[];
}

// ── Registry ─────────────────────────────────────────────────

/**
 * Per-action guardrail registry. Keyed on `actionType` (the same string the
 * dispatcher uses, e.g. `"send_dm"` or `"create_bounty"`). Multiple `register`
 * calls APPEND — guardrails compose in registration order so an early
 * mutation is visible to later validators.
 *
 * `runInput` / `runOutput` are the dispatcher integration points. They:
 *   - Apply guardrails sequentially (not in parallel — order matters).
 *   - Shallow-merge any returned `Partial<>` onto the working args.
 *   - Re-throw `InputGuardrailTripped` / `OutputGuardrailTripped` as-is.
 *   - Wrap any other thrown error in `InputGuardrailTripped` / `OutputGuardrailTripped`
 *     with the original attached as `cause`.
 *
 * Tool hooks (`tool_input` / `tool_output`) are emitted by the dispatcher,
 * not by the registry — keeps the emit point next to the action boundary.
 */
export class GuardrailRegistry {
  private readonly inputs = new Map<string, InputGuardrail[]>();
  private readonly outputs = new Map<string, OutputGuardrail[]>();
  private readonly hooks: HookRegistry;

  constructor(hooks: HookRegistry = defaultHooks) {
    this.hooks = hooks;
  }

  /**
   * Register one or more guardrails for an action. Returns a disposer that
   * removes only the guardrails added by this call.
   *
   * `actionType` is deliberately typed as `string`, not a union of known
   * action names. The registry does NOT validate against `ON_CHAIN_ACTIONS`
   * — agents can attach guardrails to custom off-chain handlers, to internal
   * action names, or to third-party actions added via SDK extension. The
   * dispatcher only invokes guardrails whose key matches the actionType it's
   * currently handling, so registering for an unknown key is harmless (the
   * guardrail simply never runs).
   *
   * If you need strict validation — e.g. a CI check that a guardrail is
   * actually wired to a real action — use {@link countInput} /
   * {@link countOutput} in a test that asserts against the exported
   * `ON_CHAIN_ACTIONS` set from `autonomous.ts`.
   */
  register<TArgs extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    actionType: string,
    set: GuardrailSet<TArgs, TResult>,
  ): () => void {
    const inputs = (set.input ?? []) as InputGuardrail[];
    const outputs = (set.output ?? []) as OutputGuardrail[];
    if (inputs.length === 0 && outputs.length === 0) return () => {};

    const inputBucket = this.inputs.get(actionType) ?? [];
    const outputBucket = this.outputs.get(actionType) ?? [];
    inputBucket.push(...inputs);
    outputBucket.push(...outputs);
    if (inputBucket.length > 0) this.inputs.set(actionType, inputBucket);
    if (outputBucket.length > 0) this.outputs.set(actionType, outputBucket);

    return () => {
      const ib = this.inputs.get(actionType);
      if (ib) {
        for (const cb of inputs) {
          const idx = ib.indexOf(cb);
          if (idx >= 0) ib.splice(idx, 1);
        }
        if (ib.length === 0) this.inputs.delete(actionType);
      }
      const ob = this.outputs.get(actionType);
      if (ob) {
        for (const cb of outputs) {
          const idx = ob.indexOf(cb);
          if (idx >= 0) ob.splice(idx, 1);
        }
        if (ob.length === 0) this.outputs.delete(actionType);
      }
    };
  }

  /** Number of registered input guardrails for an action (test inspection). */
  countInput(actionType: string): number {
    return this.inputs.get(actionType)?.length ?? 0;
  }

  /** Number of registered output guardrails for an action (test inspection). */
  countOutput(actionType: string): number {
    return this.outputs.get(actionType)?.length ?? 0;
  }

  /** Test helper. With no arg, clears all guardrails. */
  clear(actionType?: string): void {
    if (actionType) {
      this.inputs.delete(actionType);
      this.outputs.delete(actionType);
    } else {
      this.inputs.clear();
      this.outputs.clear();
    }
  }

  /**
   * Run input guardrails in declared order and return the (possibly mutated)
   * args. Throws `InputGuardrailTripped` if any guardrail rejects.
   *
   * The original `args` object is not mutated — a new shallow copy is
   * returned even when no mutations occurred, to keep caller semantics
   * predictable.
   */
  async runInput<TArgs extends Record<string, unknown>>(
    actionType: string,
    args: TArgs,
  ): Promise<TArgs> {
    const list = this.inputs.get(actionType);
    let working: TArgs = { ...args };
    if (!list || list.length === 0) return working;

    for (const guardrail of list) {
      try {
        const ret = await guardrail(working);
        if (ret && typeof ret === "object") {
          mergeDropUndefined(working as Record<string, unknown>, ret as Record<string, unknown>);
        }
      } catch (err) {
        if (err instanceof InputGuardrailTripped) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new InputGuardrailTripped(
          `Input guardrail for "${actionType}" failed: ${msg}`,
          { cause: err },
        );
      }
    }
    return working;
  }

  /**
   * Run output guardrails in declared order and return the (possibly
   * mutated) result. Throws `OutputGuardrailTripped` on rejection. Like
   * `runInput`, the working object is shallow-cloned for each mutation so
   * the caller's `result` reference is untouched until the call returns.
   */
  async runOutput<TResult>(actionType: string, result: TResult): Promise<TResult> {
    const list = this.outputs.get(actionType);
    if (!list || list.length === 0) return result;

    let working = result;
    for (const guardrail of list) {
      try {
        const ret = await guardrail(working);
        if (ret && typeof ret === "object" && working && typeof working === "object") {
          const clone = { ...(working as Record<string, unknown>) };
          mergeDropUndefined(clone, ret as Record<string, unknown>);
          working = clone as TResult;
        }
      } catch (err) {
        if (err instanceof OutputGuardrailTripped) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new OutputGuardrailTripped(
          `Output guardrail for "${actionType}" failed: ${msg}`,
          { cause: err },
        );
      }
    }
    return working;
  }
}

/**
 * Shallow-merge `patch` into `target`, skipping keys whose value is
 * `undefined`. This is the single defensive merge used by both input and
 * output guardrails. The rule: a guardrail can SET a field to anything
 * (including `null` or an empty string — semantically meaningful), but
 * cannot DROP a field by returning `undefined`. To drop, throw.
 */
function mergeDropUndefined(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    target[key] = value;
  }
}

// ── withGuardrails wrapper (standalone helper) ───────────────

/**
 * Decorator-style wrapper for a single action handler. Convenient when an
 * agent wants to attach guardrails to a one-off handler (a custom CLI tool,
 * a unit-test fixture) without registering them globally.
 *
 * For the dispatcher integration, prefer `GuardrailRegistry.register()` +
 * `registry.runInput` / `registry.runOutput` — that path is what
 * `autonomous.ts`'s `handleActionRequest` calls.
 *
 * @example
 * ```ts
 * const sendDm = withGuardrails(rawSendDm, {
 *   input: [({ to }) => { if (!to.startsWith("0x")) throw new InputGuardrailTripped("bad addr"); }],
 *   output: [({ messageId }) => { if (!messageId) throw new OutputGuardrailTripped("missing id"); }],
 * });
 * ```
 */
export function withGuardrails<
  TArgs extends Record<string, unknown>,
  TResult,
>(
  handler: (args: TArgs) => Promise<TResult> | TResult,
  opts: {
    input?: InputGuardrail<TArgs>[];
    output?: OutputGuardrail<TResult>[];
  },
): (args: TArgs) => Promise<TResult> {
  const registry = new GuardrailRegistry();
  const ACTION = "__withGuardrails__";
  registry.register<TArgs, TResult>(ACTION, opts);
  return async (args: TArgs): Promise<TResult> => {
    const validatedArgs = await registry.runInput<TArgs>(ACTION, args);
    const result = await handler(validatedArgs);
    return registry.runOutput<TResult>(ACTION, result);
  };
}

// ── Module-level singleton ───────────────────────────────────

/**
 * Module singleton. `NookplotRuntime` exposes its own `runtime.guardrails`
 * which is the same object as this — `import { guardrails } from
 * "@nookplot/runtime"` and `runtime.guardrails` are interchangeable.
 */
export const guardrails = new GuardrailRegistry();
