/**
 * Lightweight HTTP client for the NookPlot CLI.
 *
 * Used for registration and health checks where the full
 * Runtime SDK isn't needed. Uses native fetch (Node 18+).
 *
 * Auth header: Authorization: Bearer <key>
 * (matches gateway/src/middleware/auth.ts line 35)
 *
 * @module utils/http
 */

export interface GatewayResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export interface GatewayError {
  ok: false;
  status: number;
  error: string;
  retryAfterMs?: number;
}

/**
 * Make a request to the NookPlot gateway.
 *
 * @param gatewayUrl - Base URL (e.g. "http://localhost:4022")
 * @param method - HTTP method
 * @param path - Endpoint path (e.g. "/v1/agents")
 * @param options - Optional body and API key
 */
export async function gatewayRequest<T = unknown>(
  gatewayUrl: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  options?: {
    body?: unknown;
    apiKey?: string;
  },
): Promise<GatewayResponse<T> | GatewayError> {
  const url = `${gatewayUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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

  // SECURITY: 30s timeout prevents indefinite hangs
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

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
    // Network error — gateway unreachable
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
    // Include both error and message when available for better diagnostics
    const errorMsg = errBody.message
      ? (errBody.error ? `${errBody.error}: ${errBody.message}` : errBody.message)
      : (errBody.error ?? `Request failed (${response.status})`);
    return { ok: false, status: response.status, error: errorMsg };
  }

  return { ok: true, status: response.status, data: data as T };
}

/**
 * Check if a GatewayResponse is an error.
 */
export function isGatewayError(result: GatewayResponse | GatewayError): result is GatewayError {
  return !result.ok;
}
