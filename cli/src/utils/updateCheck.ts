/**
 * Non-blocking CLI update checker.
 *
 * Checks npm registry for newer @nookplot/cli version and prints
 * a notice to stderr if one is available. Never blocks the CLI —
 * network fetch fires asynchronously with a short timeout.
 *
 * Cache: ~/.nookplot/update-check.json (24hr TTL)
 *
 * @module utils/updateCheck
 */

import fs from "fs";
import path from "path";
import os from "os";

const CACHE_DIR = path.join(os.homedir(), ".nookplot");
const CACHE_FILE = path.join(CACHE_DIR, "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;
const REGISTRY_URL = "https://registry.npmjs.org/@nookplot/cli/latest";

interface CacheData {
  latestVersion: string;
  checkedAt: number;
}

/**
 * Compare two semver strings. Returns true if `a` < `b`.
 * Only handles MAJOR.MINOR.PATCH — no prerelease/build metadata.
 */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const parts = v.replace(/^v/, "").split(".");
    return {
      major: parseInt(parts[0], 10) || 0,
      minor: parseInt(parts[1], 10) || 0,
      patch: parseInt(parts[2], 10) || 0,
    };
  };
  const c = parse(current);
  const l = parse(latest);
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

/** Read the cached version data, if valid and not expired. */
function readCache(): CacheData | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as CacheData;
    if (
      typeof data.latestVersion === "string" &&
      typeof data.checkedAt === "number" &&
      Date.now() - data.checkedAt < CACHE_TTL_MS
    ) {
      return data;
    }
  } catch {
    // Cache doesn't exist or is invalid
  }
  return null;
}

/** Write version data to cache. */
function writeCache(latestVersion: string): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ latestVersion, checkedAt: Date.now() } satisfies CacheData),
    );
  } catch {
    // Non-critical — cache write failure is fine
  }
}

/**
 * Check for updates and print a notice if a newer version is available.
 *
 * This function is synchronous from the caller's perspective — it reads
 * the cache synchronously and fires a background fetch if needed. It
 * NEVER blocks the CLI and NEVER throws.
 */
export function checkForUpdate(currentVersion: string): void {
  try {
    const cached = readCache();

    if (cached) {
      // Show notice if cached version is newer
      if (isNewer(currentVersion, cached.latestVersion)) {
        process.stderr.write(
          `\nUpdate available: @nookplot/cli ${currentVersion} → ${cached.latestVersion}\n` +
          `Run: npm update -g @nookplot/cli\n\n`,
        );
      }
      return; // Cache is fresh, no network call needed
    }

    // Cache is stale or missing — fire background fetch (never await)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((res) => {
        clearTimeout(timeout);
        if (!res.ok) return;
        return res.json();
      })
      .then((data: { version?: string } | undefined) => {
        if (data?.version) {
          writeCache(data.version);
          // Don't show notice on first fetch — show on next invocation
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        // Network error — silently ignore
      });
  } catch {
    // Never crash the CLI
  }
}
