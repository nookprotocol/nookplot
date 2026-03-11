/**
 * Audit logging middleware for the Nookplot x402 API.
 *
 * Logs every request with security-relevant metadata.
 * NEVER logs: private keys, full payment signatures, raw amounts
 * that could deanonymize users.
 *
 * @module middleware/auditLog
 */

import type { Request, Response, NextFunction } from "express";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = "info";

/**
 * Set the global log level.
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Structured log entry for audit trail.
 */
interface AuditEntry {
  timestamp: string;
  level: LogLevel;
  method: string;
  path: string;
  clientIp: string;
  statusCode: number;
  responseTimeMs: number;
  /** Whether x402 payment was present on the request. */
  paymentPresent: boolean;
  /** User-agent header (truncated). */
  userAgent?: string;
  /** Payer wallet address (extracted from payment header or settlement). */
  payerWallet?: string;
  /** Settlement transaction hash (set after successful x402 settlement). */
  settlementTx?: string;
}

/**
 * Get the client IP from request, respecting proxy headers.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Emit a structured log line.
 */
function emitLog(entry: AuditEntry): void {
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[currentLogLevel]) return;

  // Structured JSON log — easy to parse by log aggregators
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

  // Capture response finish to log with status code and timing
  res.on("finish", () => {
    const responseTimeMs = Date.now() - startTime;
    const paymentPresent =
      !!req.headers["payment-signature"] || !!req.headers["x-payment"];

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      method: req.method,
      path: req.originalUrl.slice(0, 500),
      clientIp: getClientIp(req),
      statusCode: res.statusCode,
      responseTimeMs,
      paymentPresent,
    };

    // Include truncated user-agent for debugging (not a secret, but cap length)
    const ua = req.headers["user-agent"];
    if (ua) {
      entry.userAgent = ua.substring(0, 200);
    }

    // Include payer wallet and settlement TX from res.locals (set by walletRateLimit / onAfterSettle)
    if (res.locals.x402Payer) {
      entry.payerWallet = res.locals.x402Payer as string;
    }
    if (res.locals.x402Transaction) {
      entry.settlementTx = res.locals.x402Transaction as string;
    }

    emitLog(entry);
  });

  next();
}

/**
 * Log a security event (failed payment, rejected input, etc.).
 * Call this directly from route handlers or other middleware.
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
    ...details,
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
