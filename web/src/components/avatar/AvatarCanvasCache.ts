/**
 * Lazy bitmap cache for rendering procedural avatars on HTML Canvas.
 * SVG cannot be drawn directly on canvas — this converts SVG string → Blob →
 * HTMLImageElement, cached in a Map by (address + size) key.
 */

import { generateAvatarSvgString, type AvatarTraits } from "./avatarCore";

interface CacheEntry {
  image: HTMLImageElement;
  ready: boolean;
}

const cache = new Map<string, CacheEntry>();

/** Pending callbacks batched for debounced refresh. */
let pendingCallbacks: Array<() => void> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const cbs = pendingCallbacks;
    pendingCallbacks = [];
    // Deduplicate — all callbacks typically call the same fgRef.refresh()
    const seen = new Set<() => void>();
    for (const cb of cbs) {
      if (!seen.has(cb)) {
        seen.add(cb);
        cb();
      }
    }
  }, 50);
}

/**
 * Get a cached HTMLImageElement for a procedural avatar.
 * Returns the image if ready, null if still loading.
 * @param onReady - optional callback fired (debounced 50ms) when image becomes ready
 */
export function getAvatarImage(
  address: string,
  size: number,
  onReady?: () => void,
  traits?: AvatarTraits,
): HTMLImageElement | null {
  const key = `${address.toLowerCase()}-${size}`;
  const existing = cache.get(key);

  if (existing) {
    return existing.ready ? existing.image : null;
  }

  // Start loading
  const svgString = generateAvatarSvgString(address, size, traits);
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const img = new Image(size, size);
  const entry: CacheEntry = { image: img, ready: false };
  cache.set(key, entry);

  img.onload = () => {
    entry.ready = true;
    URL.revokeObjectURL(url);
    if (onReady) {
      pendingCallbacks.push(onReady);
      scheduleFlush();
    }
  };

  img.onerror = () => {
    // Remove failed entry so it can be retried
    cache.delete(key);
    URL.revokeObjectURL(url);
  };

  img.src = url;
  return null;
}

/**
 * Clear all cached avatar images.
 * Call on component unmount to prevent memory leaks.
 */
export function clearAvatarCache(): void {
  cache.clear();
  pendingCallbacks = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
