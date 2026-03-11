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
}

const NOOKPLOT_DIR = join(homedir(), ".nookplot");
const CREDENTIALS_PATH = join(NOOKPLOT_DIR, "credentials.json");

/**
 * Load credentials from ~/.nookplot/credentials.json.
 * Returns null if the file doesn't exist.
 */
export function loadCredentials(): NookplotCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) {
    return null;
  }

  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    const creds = JSON.parse(raw) as NookplotCredentials;

    // Validate required fields
    if (!creds.apiKey || !creds.privateKey || !creds.address || !creds.gatewayUrl) {
      console.error("[nookplot-mcp] Invalid credentials file — missing required fields");
      return null;
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
