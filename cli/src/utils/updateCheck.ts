/**
 * CLI update checker + auto-updater.
 *
 * checkForUpdate: Non-blocking — fires a background fetch and prints
 * a notice on the next invocation if a newer version exists.
 *
 * autoUpdate: Blocking — used by `nookplot up` to self-update before
 * starting the agent loop. Fetches latest version from npm, compares,
 * and runs `npm install -g @nookplot/cli@latest` if outdated.
 *
 * Cache: ~/.nookplot/update-check.json (24hr TTL)
 *
 * @module utils/updateCheck
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

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

/**
 * Auto-update the CLI if a newer version is available on npm.
 *
 * This is a blocking call intended for `nookplot up` startup —
 * it fetches the latest version, compares, and runs
 * `npm install -g @nookplot/cli@latest` if outdated.
 *
 * Returns true if an update was installed (caller should re-exec).
 * Returns false if already up to date or update failed.
 * Never throws.
 */
export async function autoUpdate(currentVersion: string): Promise<boolean> {
  try {
    // Check cache first to avoid hammering npm on every `up`
    const cached = readCache();
    let latestVersion: string | null = cached?.latestVersion ?? null;

    if (!cached) {
      // Fetch from npm
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(REGISTRY_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);
      if (!res.ok) return false;
      const data = (await res.json()) as { version?: string };
      latestVersion = data.version ?? null;
      if (latestVersion) writeCache(latestVersion);
    }

    if (!latestVersion || !isNewer(currentVersion, latestVersion)) {
      return false; // Already up to date
    }

    process.stderr.write(
      `\n  Updating @nookplot/cli ${currentVersion} \u2192 ${latestVersion}...\n`,
    );

    // Detect package manager — prefer the one that installed us
    const npmUserAgent = process.env.npm_config_user_agent || "";
    let installCmd: string;
    if (npmUserAgent.includes("pnpm")) {
      installCmd = `pnpm add -g @nookplot/cli@${latestVersion}`;
    } else if (npmUserAgent.includes("yarn")) {
      installCmd = `yarn global add @nookplot/cli@${latestVersion}`;
    } else {
      installCmd = `npm install -g @nookplot/cli@${latestVersion}`;
    }

    execSync(installCmd, { stdio: "inherit", timeout: 60000 });
    process.stderr.write(`  Updated to @nookplot/cli@${latestVersion}\n\n`);

    // Re-exec the same command with the new version
    const { execFileSync } = await import("child_process");
    execFileSync(process.argv[0], process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, _NOOKPLOT_UPDATED: "1" },
    });
    process.exit(0);
  } catch (err) {
    // Update failed — continue with current version
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  Auto-update failed: ${msg}\n  Continuing with current version.\n\n`);
    return false;
  }
}
