/**
 * Mining capability detection for `nookplot mine`.
 *
 * Probes the local environment to determine which mining tracks are eligible:
 *   - knowledge: any reasoning LLM (Anthropic / OpenAI / local Ollama)
 *   - embedding: Ollama with nomic-embed-text installed
 *   - rlm:       reasoning LLM + Python sandbox (local interpreter)
 *   - gradient:  GPU presence (informational only — no solver yet)
 *
 * Detection runs on `nookplot mine` startup, on SIGHUP (manual re-detect),
 * and every {@link CAPABILITY_REFRESH_INTERVAL_MS} thereafter so the loop
 * picks up newly-installed Ollama models / rotated keys without restart.
 *
 * @module utils/miningCapabilities
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export type MiningTrack = "knowledge" | "embedding" | "rlm" | "gradient";

export interface MiningCapability {
  track: MiningTrack;
  enabled: boolean;
  reason?: string;
  /** Detected provider that satisfied this capability (if enabled). */
  provider?: string;
}

/** Capability re-detection cadence (1h). SIGHUP forces immediate re-detect. */
export const CAPABILITY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** Ollama default port. */
const OLLAMA_BASE = "http://127.0.0.1:11434";

/** Models that count as "reasoning-capable" for knowledge / RLM tracks. */
const REASONING_MODEL_PREFIXES = [
  "hermes", "llama3", "qwen", "mistral", "deepseek",
  "phi", "gemma", "command", "yi", "mixtral",
];

/** Embedding models the embedding track can use. */
const EMBEDDING_MODELS = ["nomic-embed-text"];

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Detect all four mining capabilities. Pure function (no side effects beyond
 * network probes). Safe to call repeatedly; each call re-probes everything.
 */
export async function detectCapabilities(): Promise<MiningCapability[]> {
  const reasoning = await detectReasoningProvider();
  const ollamaModels = await listOllamaModels();
  const embeddingModel = ollamaModels.find((m) => EMBEDDING_MODELS.some((e) => m.startsWith(e)));
  const pythonAvailable = await hasPython();
  const gpu = await detectGpu();

  const knowledge: MiningCapability = reasoning
    ? { track: "knowledge", enabled: true, provider: reasoning }
    : { track: "knowledge", enabled: false, reason: "No LLM available — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or run Ollama with a reasoning model" };

  const embedding: MiningCapability = embeddingModel
    ? { track: "embedding", enabled: true, provider: `ollama (${embeddingModel})` }
    : { track: "embedding", enabled: false, reason: "Run: ollama pull nomic-embed-text" };

  const rlm: MiningCapability = !reasoning
    ? { track: "rlm", enabled: false, reason: "RLM needs an LLM — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or run Ollama" }
    : !pythonAvailable
      ? { track: "rlm", enabled: false, reason: "RLM needs Python 3 in PATH for sandbox execution" }
      : { track: "rlm", enabled: true, provider: `${reasoning} + python` };

  const gradient: MiningCapability = gpu
    ? { track: "gradient", enabled: false, reason: "GPU detected — gradient mining is not currently available", provider: gpu }
    : { track: "gradient", enabled: false, reason: "No GPU detected" };

  return [knowledge, embedding, rlm, gradient];
}

/**
 * Convenience: returns true if any mining track is enabled. The loop should
 * exit early when this is false rather than burning CPU on a doomed loop.
 */
export function anyEnabled(caps: MiningCapability[]): boolean {
  return caps.some((c) => c.enabled);
}

/** Filter to enabled capabilities, preserving order. */
export function enabledTracks(caps: MiningCapability[]): MiningTrack[] {
  return caps.filter((c) => c.enabled).map((c) => c.track);
}

// ── Reasoning provider detection (env vars + Ollama) ─────────────────────

/**
 * Returns the first reasoning provider available, or null if none. Order:
 *   1. ANTHROPIC_API_KEY
 *   2. OPENAI_API_KEY
 *   3. Ollama with a model in REASONING_MODEL_PREFIXES
 */
export async function detectReasoningProvider(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";

  const models = await listOllamaModels();
  for (const m of models) {
    if (REASONING_MODEL_PREFIXES.some((p) => m.toLowerCase().includes(p))) {
      return `ollama (${m})`;
    }
  }
  return null;
}

// ── Ollama probe ─────────────────────────────────────────────────────────

/**
 * Returns the list of Ollama-installed model names, or [] if Ollama is not
 * running. Never throws — a 2s timeout protects against slow boots.
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

// ── Python sandbox probe ─────────────────────────────────────────────────

/**
 * Returns true if `python3` is in PATH and runs. Exit code is the only
 * signal — we don't care about the version string.
 */
export async function hasPython(): Promise<boolean> {
  return runWithExitCode("python3", ["--version"], 1500);
}

// ── GPU probe (informational) ────────────────────────────────────────────

/**
 * Returns a short identifier of detected GPU vendor or null. The gradient
 * track ships disabled regardless — this is purely UI signal.
 */
export async function detectGpu(): Promise<string | null> {
  const os = platform();
  if (os === "darwin") {
    // Apple silicon — `system_profiler SPDisplaysDataType` lists GPU. Quicker:
    // assume any darwin host has at least integrated GPU. We treat M1/M2/M3
    // as detected because Metal is always present.
    return process.arch === "arm64" ? "apple-silicon" : null;
  }
  if (os === "linux" || os === "win32") {
    if (await runWithExitCode("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], 1500)) {
      return "nvidia";
    }
    if (await runWithExitCode("rocminfo", ["--noversion"], 1500)) {
      return "amd";
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function runWithExitCode(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve(false);
      }
    }, timeoutMs);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}
