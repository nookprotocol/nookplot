/**
 * Cookie-based session management for browser clients.
 *
 * The API key is stored in an HttpOnly cookie (set by the gateway)
 * that JavaScript cannot read. This module stores only non-sensitive
 * metadata (agentId, address, displayName) in localStorage so
 * sessions persist across browser restarts.
 *
 * @module lib/authSession
 */

import { GATEWAY_URL } from "@/config/constants";

/** localStorage key for non-sensitive session metadata (persists across browser restarts). */
const SESSION_META_KEY = "nookplot_session";

/** Shape of the non-sensitive metadata stored in localStorage. */
export interface SessionInfo {
  agentId: string;
  address: string;
  displayName: string | null;
  apiKeyPrefix: string;
  hasDid?: boolean;
  authSource?: string;
}

/**
 * Start a session by posting the API key to the gateway.
 *
 * The gateway validates the key, sets an HttpOnly cookie,
 * and returns non-sensitive metadata that we store in localStorage.
 *
 * @param apiKey - The raw API key (nk_...)
 * @throws Error if the key is invalid or the request fails
 */
export async function startSession(apiKey: string): Promise<SessionInfo> {
  const res = await fetch(`${GATEWAY_URL}/v1/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ apiKey }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Session creation failed" }));
    throw new Error(body.error ?? `Session failed: ${res.status}`);
  }

  const info: SessionInfo = await res.json();
  localStorage.setItem(SESSION_META_KEY, JSON.stringify(info));
  return info;
}

/**
 * End the session — clears the HttpOnly cookie and local metadata.
 */
export async function endSession(): Promise<void> {
  try {
    await fetch(`${GATEWAY_URL}/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // Best-effort — clear local state regardless
  }
  localStorage.removeItem(SESSION_META_KEY);
}

/**
 * Check if a session is active (synchronous — checks local metadata).
 *
 * This doesn't validate the cookie server-side. For that, use checkSession().
 */
export function isAuthenticated(): boolean {
  return localStorage.getItem(SESSION_META_KEY) !== null;
}

/**
 * Get the non-sensitive session metadata.
 *
 * Returns null if no session is active.
 */
export function getSessionInfo(): SessionInfo | null {
  const raw = localStorage.getItem(SESSION_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionInfo;
  } catch {
    return null;
  }
}

/**
 * Server-side session check — validates the cookie is still valid.
 *
 * Updates local metadata if valid, clears it if not.
 */
export async function checkSession(): Promise<SessionInfo | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/auth/check`, {
      credentials: "include",
    });
    if (!res.ok) {
      localStorage.removeItem(SESSION_META_KEY);
      return null;
    }
    const data = await res.json();
    if (data.authenticated && data.agent) {
      const info: SessionInfo = data.agent;
      localStorage.setItem(SESSION_META_KEY, JSON.stringify(info));
      return info;
    }
    localStorage.removeItem(SESSION_META_KEY);
    return null;
  } catch {
    return null;
  }
}
