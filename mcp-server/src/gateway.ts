/**
 * Lightweight HTTP client for the Nookplot gateway.
 *
 * Replicated from cli/src/utils/http.ts with exponential backoff.
 * Uses native fetch (Node 18+).
 *
 * @module gateway
 */

export interface GatewayResponse<T = unknown> {
  ok: true;
  status: number;
  data: T;
}

export interface GatewayError {
  ok: false;
  status: number;
  error: string;
  retryAfterMs?: number;
}

export function isGatewayError(result: GatewayResponse | GatewayError | null | undefined): result is GatewayError {
  if (!result) return true;
  return !result.ok;
}

/** Backoff config matching runtime/src/connection.ts pattern. */
const BACKOFF = {
  baseMs: 5_000,
  maxRetries: 4,
  factor: 2,
  jitterMin: 0.8,
  jitterMax: 1.2,
};

/**
 * Make a request to the Nookplot gateway.
 */
export async function gatewayRequest<T = unknown>(
  gatewayUrl: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  options?: {
    body?: unknown;
    apiKey?: string;
    clientVersion?: string;
    /** Request timeout in milliseconds (default 30_000). */
    timeoutMs?: number;
  },
): Promise<GatewayResponse<T> | GatewayError> {
  const url = `${gatewayUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Nookplot-Client": `mcp/${options?.clientVersion ?? "unknown"}`,
  };

  if (options?.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  // SECURITY: Warn if sending Bearer token over non-HTTPS to non-localhost
  if (options?.apiKey) {
    try {
      const parsed = new URL(url);
      const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (!isLocal && parsed.protocol !== "https:") {
        console.warn(
          `\n  \u26a0 WARNING: Sending API key over insecure HTTP to ${parsed.hostname}.` +
          `\n    Use HTTPS for non-localhost gateways to protect your credentials.\n`,
        );
      }
    } catch { /* URL parse failure handled by fetch below */ }
  }

  // Configurable timeout (default 60s — mining submissions and IPFS uploads need more than 30s)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options?.timeoutMs ?? 60_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined && method !== "GET"
        ? JSON.stringify(options.body)
        : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      error: `Cannot reach gateway at ${gatewayUrl} \u2014 ${message}`,
    };
  }

  clearTimeout(timeoutId);

  // Rate limit handling
  if (response.status === 429) {
    const resetHeader = response.headers.get("RateLimit-Reset");
    let retryAfterMs: number | undefined;
    if (resetHeader) {
      const resetTime = Number(resetHeader);
      if (!Number.isNaN(resetTime)) {
        retryAfterMs = Math.max(0, resetTime * 1000 - Date.now());
      }
    }

    let errorMsg: string;
    try {
      const body = await response.json() as { error?: string; message?: string };
      errorMsg = body.message ?? body.error ?? "Rate limit exceeded";
    } catch {
      errorMsg = "Rate limit exceeded";
    }

    return { ok: false, status: 429, error: errorMsg, retryAfterMs };
  }

  // Parse response body
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const errBody = data as { error?: string; message?: string };
    const errorMsg = errBody.message
      ? (errBody.error ? `${errBody.error}: ${errBody.message}` : errBody.message)
      : (errBody.error ?? `Request failed (${response.status})`);
    return { ok: false, status: response.status, error: errorMsg };
  }

  return { ok: true, status: response.status, data: data as T };
}

/**
 * Make a gateway request with exponential backoff on 429 errors.
 */
export async function gatewayRequestWithRetry<T = unknown>(
  gatewayUrl: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  options?: {
    body?: unknown;
    apiKey?: string;
    clientVersion?: string;
    /** Request timeout in milliseconds (default 30_000). */
    timeoutMs?: number;
  },
): Promise<GatewayResponse<T> | GatewayError> {
  let lastResult: GatewayResponse<T> | GatewayError;

  for (let attempt = 0; attempt <= BACKOFF.maxRetries; attempt++) {
    lastResult = await gatewayRequest<T>(gatewayUrl, method, path, options);

    if (!isGatewayError(lastResult) || lastResult.status !== 429) {
      return lastResult;
    }

    if (attempt < BACKOFF.maxRetries) {
      const baseDelay = BACKOFF.baseMs * Math.pow(BACKOFF.factor, attempt);
      const jitter = BACKOFF.jitterMin + Math.random() * (BACKOFF.jitterMax - BACKOFF.jitterMin);
      const delay = Math.min(baseDelay * jitter, 60_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return lastResult!;
}
