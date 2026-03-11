/**
 * Unit tests for NonceTracker — per-agent nonce cache with mutex.
 *
 * Verifies:
 * - Sequential nonces from cache (no duplicate nonces)
 * - Concurrent acquireNonce calls serialize correctly
 * - confirmNonce/releaseNonce lifecycle
 * - Cache invalidation on relay failure
 * - Stale cache re-fetches from chain
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NonceTracker } from "../nonceTracker.js";

describe("NonceTracker", () => {
  let getNonceFromChain: ReturnType<typeof vi.fn>;
  let tracker: NonceTracker;

  beforeEach(() => {
    getNonceFromChain = vi.fn().mockResolvedValue(5n);
    tracker = new NonceTracker(getNonceFromChain, 60_000);
  });

  it("fetches from chain on first call and returns the on-chain nonce", async () => {
    const nonce = await tracker.acquireNonce("0xAgent1");
    expect(nonce).toBe(5n);
    expect(getNonceFromChain).toHaveBeenCalledWith("0xAgent1");
  });

  it("returns sequential nonces from cache without re-fetching", async () => {
    const n1 = await tracker.acquireNonce("0xAgent1");
    const n2 = await tracker.acquireNonce("0xAgent1");
    const n3 = await tracker.acquireNonce("0xAgent1");

    expect(n1).toBe(5n);
    expect(n2).toBe(6n);
    expect(n3).toBe(7n);

    // Only one chain fetch
    expect(getNonceFromChain).toHaveBeenCalledTimes(1);
  });

  it("isolates nonces per agent", async () => {
    getNonceFromChain
      .mockResolvedValueOnce(10n)  // agent1
      .mockResolvedValueOnce(20n); // agent2

    const a1 = await tracker.acquireNonce("0xAgent1");
    const a2 = await tracker.acquireNonce("0xAgent2");
    const a1b = await tracker.acquireNonce("0xAgent1");

    expect(a1).toBe(10n);
    expect(a2).toBe(20n);
    expect(a1b).toBe(11n);
  });

  it("normalizes addresses to lowercase", async () => {
    const n1 = await tracker.acquireNonce("0xABCD");
    const n2 = await tracker.acquireNonce("0xabcd");

    expect(n1).toBe(5n);
    expect(n2).toBe(6n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(1);
  });

  it("three concurrent acquireNonce calls yield three distinct sequential nonces", async () => {
    // This is the core race-condition test
    const [n1, n2, n3] = await Promise.all([
      tracker.acquireNonce("0xAgent1"),
      tracker.acquireNonce("0xAgent1"),
      tracker.acquireNonce("0xAgent1"),
    ]);

    const nonces = [n1, n2, n3].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(nonces).toEqual([5n, 6n, 7n]);
    expect(getNonceFromChain).toHaveBeenCalledTimes(1);
  });

  it("confirmNonce decrements pending counter", async () => {
    await tracker.acquireNonce("0xAgent1");
    await tracker.acquireNonce("0xAgent1");

    // Two pending nonces
    tracker.confirmNonce("0xAgent1");

    // Should still return from cache (one pending remaining)
    const n3 = await tracker.acquireNonce("0xAgent1");
    expect(n3).toBe(7n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(1);
  });

  it("releaseNonce invalidates cache when pending hits 0", async () => {
    await tracker.acquireNonce("0xAgent1"); // nonce 5, pending=1

    // Simulate relay failure
    tracker.releaseNonce("0xAgent1"); // pending=0 → cache deleted

    // Next acquire should re-fetch from chain
    getNonceFromChain.mockResolvedValueOnce(5n); // same nonce (relay didn't advance)
    const n2 = await tracker.acquireNonce("0xAgent1");
    expect(n2).toBe(5n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(2);
  });

  it("releaseNonce does NOT invalidate cache while other nonces pending", async () => {
    await tracker.acquireNonce("0xAgent1"); // nonce 5, pending=1
    await tracker.acquireNonce("0xAgent1"); // nonce 6, pending=2

    // First relay fails
    tracker.releaseNonce("0xAgent1"); // pending=1 → cache stays

    // Next acquire should use cache
    const n3 = await tracker.acquireNonce("0xAgent1");
    expect(n3).toBe(7n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(1);
  });

  it("invalidate forces re-fetch on next acquire", async () => {
    await tracker.acquireNonce("0xAgent1");
    tracker.confirmNonce("0xAgent1"); // pending=0

    tracker.invalidate("0xAgent1");

    getNonceFromChain.mockResolvedValueOnce(6n);
    const n2 = await tracker.acquireNonce("0xAgent1");
    expect(n2).toBe(6n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(2);
  });

  it("re-fetches from chain after TTL expires (when no pending)", async () => {
    // Use a very short TTL
    const shortTtl = new NonceTracker(getNonceFromChain, 10); // 10ms

    const n1 = await shortTtl.acquireNonce("0xAgent1");
    expect(n1).toBe(5n);

    shortTtl.confirmNonce("0xAgent1"); // pending=0

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 20));

    getNonceFromChain.mockResolvedValueOnce(6n);
    const n2 = await shortTtl.acquireNonce("0xAgent1");
    expect(n2).toBe(6n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-fetch after TTL if nonces are still pending", async () => {
    const shortTtl = new NonceTracker(getNonceFromChain, 10); // 10ms

    const n1 = await shortTtl.acquireNonce("0xAgent1");
    expect(n1).toBe(5n);
    // pending=1, don't confirm

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 20));

    // Should use cache despite TTL expiry (pending > 0)
    const n2 = await shortTtl.acquireNonce("0xAgent1");
    expect(n2).toBe(6n);
    expect(getNonceFromChain).toHaveBeenCalledTimes(1);
  });

  it("handles confirmNonce/releaseNonce for unknown agent gracefully", () => {
    // Should not throw
    tracker.confirmNonce("0xUnknown");
    tracker.releaseNonce("0xUnknown");
    tracker.invalidate("0xUnknown");
  });

  it("handles chain fetch failure by propagating the error", async () => {
    getNonceFromChain.mockRejectedValueOnce(new Error("RPC timeout"));

    await expect(tracker.acquireNonce("0xAgent1")).rejects.toThrow("RPC timeout");
  });
});
