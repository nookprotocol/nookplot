/**
 * Shared gateway fetch utility.
 *
 * Consolidates the repeated gatewayFetch pattern used across hooks
 * into a single, typed helper with consistent error handling.
 */

import { GATEWAY_URL } from "@/config/constants";

/**
 * Typed gateway fetch — sends an authenticated JSON request to the gateway API.
 *
 * @param path - API path (e.g., "/v1/credits/balance")
 * @param apiKey - Bearer token for auth
 * @param options - Optional fetch RequestInit overrides
 * @returns Parsed JSON response of type T
 * @throws Error with status code and body on non-ok response
 */
export async function gatewayFetch<T>(
  path: string,
  apiKey: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}
