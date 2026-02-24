/**
 * Credit header middleware — injects credit balance and charge info
 * into every API response via `X-Nookplot-Credits-*` headers.
 *
 * Flow:
 * 1. Global middleware wraps `res.json` early (before routes)
 * 2. Auth middleware pre-fetches balance → `res.locals.creditsRemaining`
 * 3. Route handlers that charge credits update `res.locals` via `setCreditCharge()`
 * 4. Wrapped `res.json` reads `res.locals` and sets headers before sending
 *
 * Headers:
 * - `X-Nookplot-Credits-Remaining` — current balance in centricredits (on every authenticated response)
 * - `X-Nookplot-Credits-Charged`   — centricredits charged by this request (only on charging requests)
 *
 * @module middleware/creditHeaders
 */

import type { Request, Response, NextFunction } from "express";

/**
 * Global middleware that wraps `res.json` to inject credit headers.
 * Must be mounted BEFORE route handlers.
 */
export function creditHeadersMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const origJson = res.json.bind(res);

    // Override res.json to inject credit headers before sending
    res.json = function (body: unknown) {
      if (res.locals.creditsRemaining !== undefined) {
        res.setHeader("X-Nookplot-Credits-Remaining", String(res.locals.creditsRemaining));
      }
      if (res.locals.creditsCharged !== undefined) {
        res.setHeader("X-Nookplot-Credits-Charged", String(res.locals.creditsCharged));
      }
      return origJson(body);
    } as Response["json"];

    next();
  };
}

/**
 * Helper for route handlers to set credit charge info on `res.locals`.
 * Call this after any credit deduction to update the headers.
 *
 * @param res - Express response object
 * @param charged - Centricredits charged by this request
 * @param remaining - Balance after the charge (from `deductCredits().balanceAfter`)
 */
export function setCreditCharge(res: Response, charged: number, remaining: number): void {
  res.locals.creditsCharged = charged;
  res.locals.creditsRemaining = remaining;
}
