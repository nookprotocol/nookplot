/**
 * Audit logging middleware for the Agent Gateway.
 *
 * Logs every request with security-relevant metadata.
 * NEVER logs: private keys, full API keys, wallet encryption data.
 *
 * @module middleware/auditLog
 */

import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

/** Strip control characters, RTL overrides, and null bytes from strings before logging. */
function sanitizeLogInput(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

interface AuditEntry {
  timestamp: string;
  level: LogLevel;
  method: string;
  path: string;
  clientIp: string;
  statusCode: number;
  responseTimeMs: number;
  agentPrefix?: string;
  userAgent?: string;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function emitLog(entry: AuditEntry): void {
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[currentLogLevel]) return;

  const line = JSON.stringify(entry);
  switch (entry.level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
      break;
  }
}

/**
 * Middleware that logs every request with audit-relevant metadata.
 */
export function auditLog(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startTime = Date.now();

  res.on("finish", () => {
    const responseTimeMs = Date.now() - startTime;
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      method: req.method,
      path: sanitizeLogInput(req.originalUrl.slice(0, 500)),
      clientIp: getClientIp(req),
      statusCode: res.statusCode,
      responseTimeMs,
    };

    // Include agent prefix if authenticated (never the full key)
    const agent = (req as AuthenticatedRequest).agent;
    if (agent) {
      entry.agentPrefix = agent.api_key_prefix;
    }

    const ua = req.headers["user-agent"];
    if (ua) {
      entry.userAgent = sanitizeLogInput(ua.substring(0, 200));
    }

    emitLog(entry);
  });

  next();
}

/**
 * Log a security or operational event.
 */
export function logSecurityEvent(
  level: LogLevel,
  event: string,
  details: Record<string, unknown>,
): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLogLevel]) return;

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    details,
  });

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
      break;
  }
}
