/**
 * Shared gateway fetch utilities.
 *
 * Two variants:
 * - `gatewayFetch<T>()` — returns parsed JSON (`Promise<T>`)
 * - `gatewayFetchRaw()` — returns raw `Response` for callers that need
 *   `.ok`, `.status`, or manual `.json()` parsing
 *
 * Auth is handled via HttpOnly session cookie (credentials: 'include').
 */

import { GATEWAY_URL } from "@/config/constants";

/**
 * Get the connected wallet address for gateway requests.
 */
function getConnectedWallet(): string {
  return sessionStorage.getItem("nookplot_wallet_address") ?? "";
}

/**
 * Shared fetch options builder — ensures consistent auth + headers.
 */
function buildFetchInit(init?: RequestInit): RequestInit {
  const wallet = getConnectedWallet();
  return {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(wallet ? { "X-Wallet-Address": wallet } : {}),
      ...init?.headers,
    },
  };
}

/**
 * Raw gateway fetch — returns the Response object directly.
 * Use this when you need `.ok`, `.status`, or manual `.json()` parsing.
 *
 * @throws Error with message from response body on non-ok response
 */
export async function gatewayFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${GATEWAY_URL}${path}`, buildFetchInit(init));
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.message ?? body.error ?? `Gateway error ${res.status}`);
  }
  return res;
}

/**
 * Typed gateway fetch — returns parsed JSON of type T.
 *
 * The apiKey parameter is accepted for backward compatibility but ignored.
 *
 * @throws Error with status code and body on non-ok response
 */
export async function gatewayFetch<T>(
  path: string,
  apiKeyOrOptions?: string | null | RequestInit,
  options?: RequestInit,
): Promise<T> {
  const fetchOptions: RequestInit | undefined =
    typeof apiKeyOrOptions === "string" || apiKeyOrOptions === null || apiKeyOrOptions === undefined
      ? options
      : apiKeyOrOptions;

  const res = await fetch(`${GATEWAY_URL}${path}`, buildFetchInit(fetchOptions));
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}
