/**
 * In-process LRU cache for index query results.
 *
 * Eliminates redundant Postgres hits on high-traffic public endpoints.
 * No external dependencies (uses lru-cache v11, zero-dep ESM package).
 *
 * @module services/queryCache
 */

import { LRUCache } from "lru-cache";

export interface QueryCacheOptions {
  /** Maximum number of entries (default 500). */
  max?: number;
}

export class QueryCache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cache: LRUCache<string, any>;

  constructor(options?: QueryCacheOptions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.cache = new LRUCache<string, any>({
      max: options?.max ?? 500,
    });
  }

  /**
   * Return cached value if fresh, otherwise call factory and cache the result.
   *
   * @param key   Cache key (e.g. "idx:stats")
   * @param factory  Async function that produces the value
   * @param ttlMs    Time-to-live in milliseconds
   */
  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs: number): Promise<T> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }
    const value = await factory();
    this.cache.set(key, value, { ttl: ttlMs });
    return value;
  }

  /** Remove a single key. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Remove all keys that start with the given prefix. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Number of entries currently in cache. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
  }
}
