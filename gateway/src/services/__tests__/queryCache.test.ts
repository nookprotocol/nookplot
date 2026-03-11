import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryCache } from "../queryCache.js";

describe("QueryCache", () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache({ max: 100 });
  });

  it("returns factory result on cache miss", async () => {
    const factory = vi.fn().mockResolvedValue({ count: 42 });
    const result = await cache.getOrSet("key1", factory, 10_000);
    expect(result).toEqual({ count: 42 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on cache hit (no factory call)", async () => {
    const factory = vi.fn().mockResolvedValue({ count: 42 });
    await cache.getOrSet("key1", factory, 10_000);
    const result = await cache.getOrSet("key1", factory, 10_000);
    expect(result).toEqual({ count: 42 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("calls factory again after invalidation (simulates TTL expiry)", async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce({ v: 2 });

    await cache.getOrSet("key1", factory, 60_000);
    expect(factory).toHaveBeenCalledTimes(1);

    // Simulate TTL expiry via invalidation
    cache.invalidate("key1");

    const result = await cache.getOrSet("key1", factory, 60_000);
    expect(result).toEqual({ v: 2 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidate() removes a key", async () => {
    const factory = vi.fn().mockResolvedValue("val");
    await cache.getOrSet("key1", factory, 60_000);
    cache.invalidate("key1");

    await cache.getOrSet("key1", factory, 60_000);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidatePrefix() removes matching keys", async () => {
    const factory = vi.fn().mockResolvedValue("v");
    await cache.getOrSet("idx:feed:a", factory, 60_000);
    await cache.getOrSet("idx:feed:b", factory, 60_000);
    await cache.getOrSet("idx:stats", factory, 60_000);

    cache.invalidatePrefix("idx:feed");
    expect(cache.size).toBe(1); // only idx:stats remains
  });

  it("clear() empties the cache", async () => {
    const factory = vi.fn().mockResolvedValue("v");
    await cache.getOrSet("a", factory, 60_000);
    await cache.getOrSet("b", factory, 60_000);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("respects max entries (LRU eviction)", async () => {
    const smallCache = new QueryCache({ max: 2 });
    const factory = vi.fn().mockResolvedValue("v");

    await smallCache.getOrSet("a", factory, 60_000);
    await smallCache.getOrSet("b", factory, 60_000);
    await smallCache.getOrSet("c", factory, 60_000); // evicts "a"

    expect(smallCache.size).toBe(2);

    // "a" should be evicted, factory called again
    await smallCache.getOrSet("a", factory, 60_000);
    expect(factory).toHaveBeenCalledTimes(4); // a, b, c, a(miss)
  });
});
