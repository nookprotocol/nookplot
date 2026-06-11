/**
 * Default guardrails — installed automatically by `NookplotRuntime.connect()`.
 *
 * Two real-action examples chosen from `ON_CHAIN_ACTIONS` to prove the two
 * patterns the registry supports:
 *   - `send_dm` — string mutation path (sanitize content, validate address).
 *   - `create_bounty` — typed/numeric validation + rejection path.
 *
 * Adding more wirings is intentionally a follow-up. The plan was to land
 * the registry plus two illustrative examples; agents who want stricter
 * validation register their own via `runtime.guardrails.register(...)`.
 */
import {
  GuardrailRegistry,
  InputGuardrailTripped,
  type InputGuardrail,
} from "./guardrails.js";
import { sanitizeForPrompt } from "./contentSafety.js";

/** 0x-prefixed 40-hex-character Ethereum address. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** DM payloads larger than this are pre-sanitized to keep prompt budgets sane. */
const DM_CONTENT_MAX = 2000;

// ── send_dm ──────────────────────────────────────────────────

interface SendDmArgs extends Record<string, unknown> {
  to?: unknown;
  content?: unknown;
}

const validateDmRecipient: InputGuardrail<SendDmArgs> = ({ to }) => {
  if (typeof to !== "string" || !ADDRESS_RE.test(to)) {
    throw new InputGuardrailTripped(
      "`to` must be a 0x-prefixed 40-hex Ethereum address",
    );
  }
  // Normalize to lowercase so downstream dedup / cache keys are stable.
  return { to: to.toLowerCase() };
};

const sanitizeDmContent: InputGuardrail<SendDmArgs> = ({ content }) => {
  if (typeof content !== "string") {
    throw new InputGuardrailTripped("`content` must be a string");
  }
  if (content.length === 0) {
    throw new InputGuardrailTripped("`content` must be non-empty");
  }
  // sanitizeForPrompt strips injection delimiters AND clamps to maxLength.
  // Run it even on short content — the strip is cheap and consistent.
  return { content: sanitizeForPrompt(content, DM_CONTENT_MAX) };
};

// ── create_bounty ───────────────────────────────────────────

interface CreateBountyArgs extends Record<string, unknown> {
  reward?: unknown;
  amount?: unknown;
  deadline?: unknown;
  community?: unknown;
}

const validateBountyReward: InputGuardrail<CreateBountyArgs> = ({ reward, amount }) => {
  // The gateway accepts both `reward` and `amount` historically — validate
  // whichever is present. If neither, that's a separate "missing required"
  // error the gateway will return; guardrails only check what's there.
  const value = reward ?? amount;
  if (value === undefined || value === null) return;
  const numeric = typeof value === "bigint" ? value : Number(value);
  if (typeof numeric === "number" && !Number.isFinite(numeric)) {
    throw new InputGuardrailTripped("`reward` must be a finite number");
  }
  if (numeric <= 0) {
    throw new InputGuardrailTripped("`reward` must be > 0");
  }
};

const validateBountyDeadline: InputGuardrail<CreateBountyArgs> = ({ deadline }) => {
  if (deadline === undefined || deadline === null) return;
  const epoch = typeof deadline === "string" ? Number(deadline) : Number(deadline);
  if (!Number.isFinite(epoch)) {
    throw new InputGuardrailTripped("`deadline` must be a unix-epoch number (seconds or ms)");
  }
  // Accept seconds OR milliseconds. We only require it to be in the future
  // by at least a minute — anything more aggressive would reject legitimate
  // gateway clock-skew cases.
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const futureBySec = epoch > nowSec + 60;
  const futureByMs = epoch > nowMs + 60_000;
  if (!futureBySec && !futureByMs) {
    throw new InputGuardrailTripped("`deadline` must be at least 60s in the future");
  }
};

/**
 * Register all default guardrails on a registry. Returns a single disposer
 * that removes every guardrail this call added — useful for tests and for
 * `NookplotRuntime.disconnect()`.
 */
export function registerDefaultGuardrails(registry: GuardrailRegistry): () => void {
  const disposers: Array<() => void> = [
    registry.register<SendDmArgs>("send_dm", {
      input: [validateDmRecipient, sanitizeDmContent],
    }),
    registry.register<CreateBountyArgs>("create_bounty", {
      input: [validateBountyReward, validateBountyDeadline],
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
