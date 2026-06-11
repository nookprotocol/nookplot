/**
 * Coverage for auto-reauth on 401 "Invalid or revoked API key".
 *
 * The contract these tests enforce:
 *   1. With a privateKey configured, a 401 with the magic message triggers
 *      a wallet-session refresh, the effective Bearer key rotates to the
 *      newly-issued session key, and the original request is retried once.
 *   2. The retry uses the NEW key in the Authorization header.
 *   3. If the refresh fails (e.g., wallet-session declines), the original
 *      401 is surfaced — we never silently swallow.
 *   4. Without a privateKey, the 401 path-through is unchanged.
 *   5. `disableAutoReauth: true` opt-out works.
 *   6. The retry only fires ONCE — if the new key STILL hits 401, we throw.
 *
 * `fetch` is mocked per-test so we can simulate the gateway responses
 * with full control over status codes + Set-Cookie headers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectionManager } from "../connection.js";

const TEST_PRIVKEY = "0x" + "ab".repeat(32); // arbitrary 32-byte hex
const TEST_BASE = "https://gateway.example.com";

function makeMockFetch(handlers: ((req: Request) => Promise<Response>)[]) {
  let i = 0;
  return vi.fn(async (urlOrReq: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof urlOrReq === "string" ? urlOrReq : urlOrReq.toString(), init);
    const handler = handlers[i] ?? handlers[handlers.length - 1];
    i++;
    return handler(req);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ConnectionManager — auto-reauth", () => {
  it("rotates the Bearer key + retries when 401 fires with a privateKey configured", async () => {
    let calls = 0;
    const fetchSpy = makeMockFetch([
      // 1st call → 401 Invalid or revoked
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ message: "Invalid or revoked API key." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
      // 2nd call → wallet-session refresh succeeds, Set-Cookie carries new key
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ authenticated: true, agent: { apiKeyPrefix: "nk_new" } }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "nookplot_session=nk_freshRotatedKey1234567890; Path=/; HttpOnly",
            },
          },
        );
      },
      // 3rd call → retry of the original request with NEW key succeeds
      async (req) => {
        calls++;
        // The retry should carry the NEW Bearer key.
        expect(req.headers.get("Authorization")).toBe("Bearer nk_freshRotatedKey1234567890");
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const conn = new ConnectionManager({
      gatewayUrl: TEST_BASE,
      apiKey: "nk_originalRevokedKey",
      privateKey: TEST_PRIVKEY,
    });

    const result = await conn.request<{ ok: boolean }>("GET", "/v1/agents/me");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(conn.apiKey).toBe("nk_freshRotatedKey1234567890");
  });

  it("re-throws the original 401 when wallet-session refresh fails (no recovery possible)", async () => {
    const fetchSpy = makeMockFetch([
      // 1st call → 401
      async () => new Response(
        JSON.stringify({ message: "Invalid or revoked API key." }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
      // 2nd call → wallet-session refresh fails (gateway 403)
      async () => new Response(
        JSON.stringify({ error: "Wallet not registered" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const conn = new ConnectionManager({
      gatewayUrl: TEST_BASE,
      apiKey: "nk_originalRevokedKey",
      privateKey: TEST_PRIVKEY,
    });

    await expect(conn.request("GET", "/v1/agents/me")).rejects.toThrow(/401|Invalid or revoked/i);
    // effectiveApiKey should NOT have rotated — refresh failed.
    expect(conn.apiKey).toBe("nk_originalRevokedKey");
  });

  it("does NOT attempt reauth when no privateKey is configured", async () => {
    let calls = 0;
    const fetchSpy = makeMockFetch([
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ message: "Invalid or revoked API key." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const conn = new ConnectionManager({
      gatewayUrl: TEST_BASE,
      apiKey: "nk_originalRevokedKey",
      // NO privateKey
    });

    await expect(conn.request("GET", "/v1/agents/me")).rejects.toThrow(/Gateway request failed \(401\)/);
    // No reauth attempted: only 1 fetch call (the original 401).
    expect(calls).toBe(1);
  });

  it("respects disableAutoReauth opt-out flag", async () => {
    let calls = 0;
    const fetchSpy = makeMockFetch([
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ message: "Invalid or revoked API key." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const conn = new ConnectionManager({
      gatewayUrl: TEST_BASE,
      apiKey: "nk_originalRevokedKey",
      privateKey: TEST_PRIVKEY,
      disableAutoReauth: true,
    });

    await expect(conn.request("GET", "/v1/agents/me")).rejects.toThrow(/401|Invalid or revoked/i);
    // Opt-out: only 1 fetch call (the original 401).
    expect(calls).toBe(1);
  });

  it("retries only ONCE — a second 401 after rotation throws", async () => {
    let calls = 0;
    const fetchSpy = makeMockFetch([
      // 1st: 401
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ message: "Invalid or revoked API key." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
      // 2nd: wallet-session refresh succeeds
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ authenticated: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": "nookplot_session=nk_newKeyButStillRevoked123456789012; Path=/; HttpOnly",
            },
          },
        );
      },
      // 3rd: retry with new key STILL 401 (something else is wrong)
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ message: "Invalid or revoked API key." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const conn = new ConnectionManager({
      gatewayUrl: TEST_BASE,
      apiKey: "nk_originalRevokedKey",
      privateKey: TEST_PRIVKEY,
    });

    await expect(conn.request("GET", "/v1/agents/me")).rejects.toThrow(/401|Invalid or revoked/i);
    // Original (401) + refresh (200) + retry (401) = 3 calls. NO 4th
    // attempt — that would be the infinite-loop bug we're guarding against.
    expect(calls).toBe(3);
  });

  it("ignores 401s with non-matching messages (no reauth, just throw)", async () => {
    let calls = 0;
    const fetchSpy = makeMockFetch([
      async () => {
        calls++;
        return new Response(
          JSON.stringify({ message: "Owner only — agent's wallet required." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      },
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const conn = new ConnectionManager({
      gatewayUrl: TEST_BASE,
      apiKey: "nk_validButOwnerCheckFails",
      privateKey: TEST_PRIVKEY,
    });

    await expect(conn.request("GET", "/v1/some-owner-only-route")).rejects.toThrow(/Owner only/);
    // No reauth on a non-key-revoked 401.
    expect(calls).toBe(1);
  });
});
