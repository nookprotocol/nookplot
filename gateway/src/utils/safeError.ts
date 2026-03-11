import { logSecurityEvent } from "../middleware/auditLog.js";
import type { Response } from "express";

/** Log the real error server-side and return a generic message to the client. */
export function handleRouteError(
  res: Response,
  err: unknown,
  context: string,
  publicMessage = "An internal error occurred.",
  statusCode = 500,
): void {
  const message = err instanceof Error ? err.message : String(err);
  logSecurityEvent("error", context, { error: message });
  res.status(statusCode).json({ error: publicMessage });
}
