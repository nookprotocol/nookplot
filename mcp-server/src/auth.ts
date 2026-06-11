/**
 * Credential management for the Nookplot MCP server.
 *
 * Stores credentials in ~/.nookplot/credentials.json (chmod 600).
 *
 * @module auth
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface NookplotCredentials {
  apiKey: string;
  privateKey: string;
  address: string;
  gatewayUrl: string;
  displayName?: string;
  /**
   * Present only when credentials were loaded through a profile.
   * Set from `~/.nookplot/profiles/<name>/profile.json::scopedAgentAddress`.
   * The server context reads this to populate `ctx.scopedAgentAddress`
   * for tools that forward it to the gateway (capture tools, etc.).
   *
   * Overridden by `NOOKPLOT_AGENT_ADDRESS` env var if that's set.
   */
  scopedAgentAddress?: string;
  /** Name of the profile the creds were loaded through, for logging. */
  profileName?: string;
}

const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const CREDENTIALS_PATH = join(NOOKPLOT_DIR, "credentials.json");
/** Per-profile credential dir — used when NOOKPLOT_PROFILE env is set. */
const AGENTS_DIR = join(NOOKPLOT_DIR, "agents");

/**
 * Resolve the credentials file path for the current run.
 *
 * Lookup order:
 *   1. Explicit override via NOOKPLOT_CREDENTIALS_PATH env (escape hatch)
 *   2. Profile-scoped path when NOOKPLOT_PROFILE is set + the file exists
 *      (~/.nookplot/agents/<profile>/credentials.json)
 *   3. Global ~/.nookplot/credentials.json
 *
 * The profile-scoped path is what makes a forged child agent
 * actually authenticate AS itself with the gateway — so tool calls land
 * under the child's address rather than the parent's. The Forge install
 * flow writes this file when the user provides a child keystore.
 */
function resolveCredentialsPath(): string {
  const explicit = process.env.NOOKPLOT_CREDENTIALS_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const profile = process.env.NOOKPLOT_PROFILE;
  if (profile) {
    const scoped = join(AGENTS_DIR, profile, "credentials.json");
    if (existsSync(scoped)) return scoped;
  }
  return CREDENTIALS_PATH;
}

/**
 * Load credentials from disk. Honors NOOKPLOT_PROFILE for child-agent
 * scoping (see resolveCredentialsPath). Returns null if the file doesn't
 * exist.
 */
export function loadCredentials(): NookplotCredentials | null {
  const path = resolveCredentialsPath();
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const creds = JSON.parse(raw) as NookplotCredentials;

    // Validate required fields
    if (!creds.apiKey || !creds.privateKey || !creds.address || !creds.gatewayUrl) {
      console.error("[nookplot-mcp] Invalid credentials file — missing required fields");
      return null;
    }

    // When loaded via a profile path, surface the profile name so the
    // server can log it ("Connected as <addr> · profile: <name>") and so
    // tools can read ctx.scopedAgentAddress without the env var.
    const profileName = process.env.NOOKPLOT_PROFILE;
    if (profileName && path !== CREDENTIALS_PATH) {
      creds.profileName = profileName;
      // The address from the profile creds IS the scoped address — set
      // it explicitly so downstream tools don't need to guess.
      creds.scopedAgentAddress = creds.address;
    }

    return creds;
  } catch (err) {
    console.error("[nookplot-mcp] Failed to load credentials:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Save credentials to ~/.nookplot/credentials.json with restrictive permissions.
 */
export function saveCredentials(creds: NookplotCredentials): void {
  // Ensure directory exists
  if (!existsSync(NOOKPLOT_DIR)) {
    mkdirSync(NOOKPLOT_DIR, { recursive: true, mode: 0o700 });
  }

  const content = JSON.stringify(creds, null, 2) + "\n";
  writeFileSync(CREDENTIALS_PATH, content, { encoding: "utf-8", mode: 0o600 });

  // Ensure restrictive permissions
  try { chmodSync(CREDENTIALS_PATH, 0o600); } catch { /* Windows doesn't support chmod */ }
}

/**
 * Get the gateway URL from env, credentials, or default.
 */
export function getGatewayUrl(creds?: NookplotCredentials | null): string {
  return process.env.NOOKPLOT_GATEWAY_URL
    ?? creds?.gatewayUrl
    ?? "https://gateway.nookplot.com";
}
