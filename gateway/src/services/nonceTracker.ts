/**
 * NonceTracker — Per-agent nonce cache with mutex for the prepare→sign→relay flow.
 *
 * Problem: The gateway's buildPrepareResult() reads the on-chain forwarder nonce
 * on every prepare call. When an agent makes rapid concurrent prepare calls
 * (e.g. upvote + comment), both read the same nonce. The first relay succeeds
 * and increments the nonce on-chain; the second relay fails with
 * "ForwardRequest signature verification failed."
 *
 * Solution: Cache the nonce per agent and serialize acquisition with a
 * Promise-based mutex. After a prepare call, the cached nonce increments
 * locally so the next prepare call gets the next sequential nonce without
 * waiting for the relay to be mined.
 *
 * The relay endpoint calls confirmNonce() on success and releaseNonce() on
 * failure to keep the cache in sync with on-chain state.
 *
 * @module services/nonceTracker
 */

interface AgentNonceEntry {
  /** Next nonce to issue. */
  nonce: bigint;
  /** Count of issued-but-not-yet-relayed nonces. */
  pending: number;
  /** Timestamp (ms) of the last on-chain fetch. */
  lastFetchedAt: number;
}

export class NonceTracker {
  /** Per-agent nonce state. */
  private agents = new Map<string, AgentNonceEntry>();

  /** Per-agent Promise-based mutex — serializes acquireNonce for the same agent. */
  private locks = new Map<string, Promise<void>>();

  /** Re-fetch from chain after this TTL (only when pending === 0). */
  private readonly CACHE_TTL_MS: number;

  /**
   * @param getNonceFromChain — Reads the current nonce from the forwarder contract.
   * @param cacheTtlMs — TTL for cached nonces (default 60s). Only re-fetches when
   *                      TTL expired AND no pending nonces.
   */
  constructor(
    private readonly getNonceFromChain: (address: string) => Promise<bigint>,
    cacheTtlMs = 60_000,
  ) {
    this.CACHE_TTL_MS = cacheTtlMs;
  }

  /**
   * Acquire the next nonce for an agent. Thread-safe per agent via mutex.
   *
   * - First call for an agent fetches the on-chain nonce and caches it.
   * - Subsequent calls return the next sequential nonce from cache.
   * - If the cache is stale (TTL expired) and no nonces are pending, re-fetches.
   */
  async acquireNonce(agentAddress: string): Promise<bigint> {
    const key = agentAddress.toLowerCase();

    // Chain onto the per-agent lock to serialize
    const prevLock = this.locks.get(key) ?? Promise.resolve();
    let releaseLock: () => void;
    const nextLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    this.locks.set(key, nextLock);

    try {
      // Wait for any prior acquireNonce for this agent to finish
      await prevLock;

      const now = Date.now();
      let entry = this.agents.get(key);

      // Fetch from chain if: no entry, or stale (TTL expired AND no pending nonces)
      const isStale = entry && entry.pending === 0 && (now - entry.lastFetchedAt > this.CACHE_TTL_MS);
      if (!entry || isStale) {
        const chainNonce = await this.getNonceFromChain(agentAddress);
        entry = { nonce: chainNonce, pending: 0, lastFetchedAt: now };
        this.agents.set(key, entry);
      }

      // Issue the nonce and advance
      const issued = entry.nonce;
      entry.nonce = issued + 1n;
      entry.pending += 1;

      return issued;
    } finally {
      releaseLock!();
    }
  }

  /**
   * Called by relay.ts on successful relay.
   * Decrements the pending counter — the nonce was consumed on-chain.
   */
  confirmNonce(agentAddress: string): void {
    const key = agentAddress.toLowerCase();
    const entry = this.agents.get(key);
    if (entry && entry.pending > 0) {
      entry.pending -= 1;
    }
  }

  /**
   * Called by relay.ts on failed relay (signature invalid, tx reverted, etc.).
   * Decrements pending. When pending hits 0, invalidates the cache so the
   * next acquireNonce re-fetches the true on-chain nonce.
   */
  releaseNonce(agentAddress: string): void {
    const key = agentAddress.toLowerCase();
    const entry = this.agents.get(key);
    if (!entry) return;

    if (entry.pending > 0) {
      entry.pending -= 1;
    }

    // When all pending nonces are resolved and at least one failed,
    // invalidate the cache so the next call re-fetches from chain.
    if (entry.pending === 0) {
      this.agents.delete(key);
    }
  }

  /**
   * Force-reset an agent's cache (e.g. on stale detection).
   */
  invalidate(agentAddress: string): void {
    const key = agentAddress.toLowerCase();
    this.agents.delete(key);
  }
}
