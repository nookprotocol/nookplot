/**
 * Shared SSRF protection utilities for the Agent Gateway.
 *
 * Used by egressProxy (outbound HTTP) and MCP routes (server registration).
 * Single source of truth for private IP detection and infrastructure blocklists.
 *
 * @module networkGuard
 */

/**
 * Check if an IP address is private/reserved (SSRF protection).
 */
export function isPrivateIp(ip: string): boolean {
  // IPv4 private/reserved ranges
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 198.18.0.0/15 (benchmark)
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  }
  // IPv6 private/reserved
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("fe80")) return true; // link-local
  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — extract IPv4 and re-check
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
  return false;
}

/** Allowed URL protocols for outbound requests. */
export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Internal/infrastructure hostnames that must never be reached.
 * Blocks Railway internal networking, cloud metadata endpoints, etc.
 */
export const BLOCKED_HOSTNAMES = new Set([
  "postgres.railway.internal",
  "redis.railway.internal",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default.svc",
]);
