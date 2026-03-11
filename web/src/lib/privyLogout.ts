/**
 * Dynamically imported Privy logout helper.
 *
 * Separated from main code so @privy-io/react-auth is only loaded
 * when actually needed (Privy users signing out).
 */

function isPrivyKey(key: string): boolean {
  return key.startsWith("privy:") || key.startsWith("privy-");
}

function clearPrivyKeys(storage: Storage): void {
  // Collect matching keys first, then remove.
  // Use multiple strategies since jsdom's Storage.length can be undefined.
  const toRemove: string[] = [];

  // Strategy 1: standard key() iteration
  if (typeof storage.length === "number") {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key && isPrivyKey(key)) toRemove.push(key);
    }
  }

  // Strategy 2: for..in (works in some environments where length doesn't)
  if (toRemove.length === 0) {
    for (const key in storage) {
      if (Object.prototype.hasOwnProperty.call(storage, key) && isPrivyKey(key)) {
        toRemove.push(key);
      }
    }
  }

  toRemove.forEach((k) => storage.removeItem(k));
}

/**
 * Logout from Privy by clearing Privy-related localStorage/sessionStorage.
 * PrivyProvider will detect the missing state on next mount and treat the user as logged out.
 */
export default async function privyLogout(): Promise<void> {
  clearPrivyKeys(localStorage);
  clearPrivyKeys(sessionStorage);
}
