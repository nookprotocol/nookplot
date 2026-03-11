/**
 * Fetch wrapper with a default timeout to prevent external HTTP calls
 * from hanging indefinitely and blocking the gateway.
 *
 * @module fetchWithTimeout
 */

/** Default timeout for external API calls (15 seconds). */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Drop-in replacement for `fetch()` that aborts after `timeoutMs`.
 *
 * If the caller already passes a `signal` in `init`, that signal is
 * respected too — whichever fires first (caller abort or timeout) wins.
 */
export function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init ?? {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // If caller supplied their own signal, forward its abort
  if (fetchInit.signal) {
    const callerSignal = fetchInit.signal;
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
    }
  }

  return fetch(url, { ...fetchInit, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}
