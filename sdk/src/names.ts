/**
 * Basenames (.base.eth) resolution module for the Nookplot SDK.
 *
 * Provides forward resolution (name -> address), reverse resolution
 * (address -> name), batch resolution, and ownership verification
 * using Base's L2 ENS Registry and Resolver contracts directly.
 *
 * ethers v6's built-in `provider.resolveName()` only works on Ethereum
 * mainnet ENS. Since Nookplot runs on Base, we call the L2 contracts
 * directly via `namehash()` + `Contract`.
 *
 * @module names
 */

import { ethers } from "ethers";

import { ENS_REGISTRY_ABI, ENS_RESOLVER_ABI } from "./abis";
import type { BasenamesConfig } from "./types";
import { BASENAMES_ADDRESSES } from "./types";

/** Regex for valid .base.eth names (after lowercasing). */
const NAME_REGEX = /^[a-z0-9-]+\.base\.eth$/;

/** Regex for Ethereum addresses. */
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/** ENS reverse resolution suffix. */
const ADDR_REVERSE_SUFFIX = ".addr.reverse";

/** Cache entry with expiration. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Manages Basenames (.base.eth) name resolution on Base L2.
 *
 * Supports forward resolution (name -> address), reverse resolution
 * (address -> name), batch resolution, and on-chain ownership verification.
 *
 * Uses an LRU-style Map cache with configurable TTL and max size.
 */
export class NamesManager {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly registry: ethers.Contract;
  private readonly cacheTTL: number;
  private readonly maxCacheSize: number;

  /** Forward cache: name -> address */
  private readonly forwardCache = new Map<string, CacheEntry<string | null>>();
  /** Reverse cache: address -> name */
  private readonly reverseCache = new Map<string, CacheEntry<string | null>>();

  /** Cache hit/miss counters. */
  private hits = 0;
  private misses = 0;

  constructor(
    provider: ethers.JsonRpcProvider,
    config?: BasenamesConfig,
    chainId?: number,
  ) {
    this.provider = provider;
    this.cacheTTL = config?.cacheTTL ?? 300_000; // 5 minutes
    this.maxCacheSize = config?.maxCacheSize ?? 1000;

    // Determine registry address: config > auto-detect from chainId
    const registryAddress =
      config?.registry ?? this.getRegistryForChain(chainId);

    this.registry = new ethers.Contract(
      registryAddress,
      ENS_REGISTRY_ABI,
      provider,
    );
  }

  /**
   * Get the registry address for a given chain ID.
   */
  private getRegistryForChain(chainId?: number): string {
    if (chainId === 84532) return BASENAMES_ADDRESSES.baseSepolia.registry;
    // Default to Base Mainnet
    return BASENAMES_ADDRESSES.baseMainnet.registry;
  }

  // ================================================================
  //                     Validation
  // ================================================================

  /**
   * Validate that a string is a well-formed .base.eth name.
   */
  private isValidName(name: string): boolean {
    return NAME_REGEX.test(name.toLowerCase());
  }

  /**
   * Validate that a string is a well-formed Ethereum address.
   */
  private isAddress(input: string): boolean {
    return ADDRESS_REGEX.test(input);
  }

  // ================================================================
  //                     Cache Management
  // ================================================================

  /**
   * Get a value from cache, returning undefined if expired or missing.
   */
  private getCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
  ): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  /**
   * Set a value in cache with TTL, evicting oldest entries if at capacity.
   */
  private setCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
  ): void {
    // Evict oldest entries if at capacity
    if (cache.size >= this.maxCacheSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTTL,
    });
  }

  /**
   * Clear all cached name resolutions.
   */
  clearCache(): void {
    this.forwardCache.clear();
    this.reverseCache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics.
   */
  get cacheStats(): {
    forwardEntries: number;
    reverseEntries: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    const total = this.hits + this.misses;
    return {
      forwardEntries: this.forwardCache.size,
      reverseEntries: this.reverseCache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  // ================================================================
  //                     Forward Resolution
  // ================================================================

  /**
   * Resolve a .base.eth name to an Ethereum address.
   *
   * Uses namehash to compute the node, looks up the resolver from
   * the registry, then calls resolver.addr(node).
   *
   * @param name - A .base.eth name (e.g., "alice.base.eth").
   * @returns The resolved address, or null if not found/invalid.
   */
  async resolveName(name: string): Promise<string | null> {
    const normalized = name.toLowerCase();
    if (!this.isValidName(normalized)) return null;

    // Check cache
    const cached = this.getCached(this.forwardCache, normalized);
    if (cached !== undefined) return cached;
    this.misses++;

    try {
      const node = ethers.namehash(normalized);

      // Look up resolver
      const resolverAddress: string = await this.registry.resolver(node);
      if (!resolverAddress || resolverAddress === ethers.ZeroAddress) {
        this.setCached(this.forwardCache, normalized, null);
        return null;
      }

      // Resolve name to address
      const resolver = new ethers.Contract(
        resolverAddress,
        ENS_RESOLVER_ABI,
        this.provider,
      );
      const address: string = await resolver.addr(node);

      if (!address || address === ethers.ZeroAddress) {
        this.setCached(this.forwardCache, normalized, null);
        return null;
      }

      const checksummed = ethers.getAddress(address);
      this.setCached(this.forwardCache, normalized, checksummed);
      return checksummed;
    } catch {
      this.setCached(this.forwardCache, normalized, null);
      return null;
    }
  }

  // ================================================================
  //                     Reverse Resolution
  // ================================================================

  /**
   * Look up the .base.eth name for an Ethereum address.
   *
   * Per ENS spec, computes the reverse node from the address,
   * resolves it to a name, then forward-verifies that the name
   * resolves back to the original address (security requirement).
   *
   * @param address - An Ethereum address (0x...).
   * @returns The verified .base.eth name, or null if none set / verification fails.
   */
  async lookupAddress(address: string): Promise<string | null> {
    if (!this.isAddress(address)) return null;

    const normalized = address.toLowerCase();

    // Check cache
    const cached = this.getCached(this.reverseCache, normalized);
    if (cached !== undefined) return cached;
    this.misses++;

    try {
      // Compute reverse node: <addr-without-0x>.addr.reverse
      const reverseNode = ethers.namehash(
        normalized.slice(2) + ADDR_REVERSE_SUFFIX,
      );

      // Look up resolver for reverse node
      const resolverAddress: string = await this.registry.resolver(reverseNode);
      if (!resolverAddress || resolverAddress === ethers.ZeroAddress) {
        this.setCached(this.reverseCache, normalized, null);
        return null;
      }

      // Get the name from the reverse resolver
      const resolver = new ethers.Contract(
        resolverAddress,
        ENS_RESOLVER_ABI,
        this.provider,
      );
      const name: string = await resolver.name(reverseNode);

      if (!name || !this.isValidName(name)) {
        this.setCached(this.reverseCache, normalized, null);
        return null;
      }

      // Forward verification (ENS spec requirement):
      // The name MUST resolve back to the original address
      const forwardResolved = await this.resolveName(name);
      if (
        !forwardResolved ||
        forwardResolved.toLowerCase() !== normalized
      ) {
        this.setCached(this.reverseCache, normalized, null);
        return null;
      }

      this.setCached(this.reverseCache, normalized, name);
      return name;
    } catch {
      this.setCached(this.reverseCache, normalized, null);
      return null;
    }
  }

  // ================================================================
  //                     Utility Methods
  // ================================================================

  /**
   * Resolve an input that may be either a .base.eth name or an address.
   *
   * @param input - A .base.eth name or Ethereum address.
   * @returns The resolved Ethereum address, or null if resolution fails.
   */
  async resolveNameOrAddress(input: string): Promise<string | null> {
    if (this.isAddress(input)) return ethers.getAddress(input);
    if (this.isValidName(input.toLowerCase())) return this.resolveName(input);
    return null;
  }

  /**
   * Batch-resolve multiple names or addresses.
   *
   * Uses `Promise.allSettled()` so individual failures don't block
   * the entire batch.
   *
   * @param inputs - Array of .base.eth names and/or Ethereum addresses.
   * @returns Map from input to resolved address (null if resolution failed).
   */
  async resolveMany(
    inputs: string[],
  ): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    const promises = inputs.map(async (input) => {
      const resolved = await this.resolveNameOrAddress(input);
      results.set(input, resolved);
    });
    await Promise.allSettled(promises);
    return results;
  }

  /**
   * Verify that a .base.eth name resolves to a specific address on-chain.
   *
   * Bypasses cache for critical operations (attestations, DID updates).
   *
   * @param name - The .base.eth name to verify.
   * @param address - The expected Ethereum address.
   * @returns True if the name resolves to the given address.
   */
  async verifyNameOwnership(
    name: string,
    address: string,
  ): Promise<boolean> {
    if (!this.isValidName(name.toLowerCase()) || !this.isAddress(address)) {
      return false;
    }

    try {
      const normalized = name.toLowerCase();
      const node = ethers.namehash(normalized);

      // Look up resolver (bypass cache)
      const resolverAddress: string = await this.registry.resolver(node);
      if (!resolverAddress || resolverAddress === ethers.ZeroAddress) {
        return false;
      }

      const resolver = new ethers.Contract(
        resolverAddress,
        ENS_RESOLVER_ABI,
        this.provider,
      );
      const resolved: string = await resolver.addr(node);

      return (
        resolved !== ethers.ZeroAddress &&
        resolved.toLowerCase() === address.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if a .base.eth name is registered (has an owner).
   *
   * @param name - The .base.eth name to check.
   * @returns True if the name has an owner (non-zero address).
   */
  async isNameRegistered(name: string): Promise<boolean> {
    const normalized = name.toLowerCase();
    if (!this.isValidName(normalized)) return false;

    try {
      const node = ethers.namehash(normalized);
      const owner: string = await this.registry.owner(node);
      return owner !== ethers.ZeroAddress;
    } catch {
      return false;
    }
  }

  /**
   * Batch-lookup names for an array of addresses.
   * Returns a Map from lowercase address to name (or null).
   * Used internally by enrichWithNames.
   */
  async lookupAddresses(
    addresses: string[],
  ): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const promises = unique.map(async (addr) => {
      const name = await this.lookupAddress(addr);
      results.set(addr, name);
    });
    await Promise.allSettled(promises);
    return results;
  }
}
