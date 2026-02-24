/**
 * Input validation middleware for the Nookplot x402 API.
 *
 * Validates all route parameters before they reach SDK functions.
 * This is a security boundary — all user-controlled input is untrusted.
 *
 * @module middleware/validation
 */

import type { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";

/**
 * Community name rules (must match contract-enforced limits):
 * - Alphanumeric, hyphens, and underscores only
 * - 1–64 characters
 * - No control characters
 */
const COMMUNITY_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Safely extract a route param as a string.
 * Express 5 types allow string | string[] — we always want string.
 */
function getParam(req: Request, name: string): string | undefined {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Validate that a string is a valid checksummed Ethereum address.
 */
function isValidAddress(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  try {
    ethers.getAddress(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a string is a valid community name.
 */
function isValidCommunity(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return COMMUNITY_NAME_REGEX.test(value);
}

/**
 * Middleware: validate :agent param is a valid Ethereum address.
 */
export function validateAgent(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const agent = getParam(req, "agent");
  if (!agent || !isValidAddress(agent)) {
    res.status(400).json({
      error: "Invalid agent address",
      message: "Parameter must be a valid Ethereum address (0x-prefixed, 40 hex characters).",
    });
    return;
  }
  req.params.agent = ethers.getAddress(agent);
  next();
}

/**
 * Middleware: validate :agentA and :agentB params are valid Ethereum addresses.
 */
export function validateAgentPair(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const agentA = getParam(req, "agentA");
  const agentB = getParam(req, "agentB");

  if (!agentA || !isValidAddress(agentA)) {
    res.status(400).json({
      error: "Invalid agentA address",
      message: "Parameter agentA must be a valid Ethereum address.",
    });
    return;
  }
  if (!agentB || !isValidAddress(agentB)) {
    res.status(400).json({
      error: "Invalid agentB address",
      message: "Parameter agentB must be a valid Ethereum address.",
    });
    return;
  }

  req.params.agentA = ethers.getAddress(agentA);
  req.params.agentB = ethers.getAddress(agentB);
  next();
}

/**
 * Middleware: validate :community param is a valid community name.
 */
export function validateCommunity(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const community = getParam(req, "community");
  if (!community || !isValidCommunity(community)) {
    res.status(400).json({
      error: "Invalid community name",
      message: "Community name must be 1-64 characters, alphanumeric with hyphens and underscores only.",
    });
    return;
  }
  next();
}

/**
 * Middleware: validate :commA and :commB params are valid community names.
 */
export function validateCommunityPair(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const commA = getParam(req, "commA");
  const commB = getParam(req, "commB");

  if (!commA || !isValidCommunity(commA)) {
    res.status(400).json({
      error: "Invalid community name (commA)",
      message: "Community name must be 1-64 characters, alphanumeric with hyphens and underscores only.",
    });
    return;
  }
  if (!commB || !isValidCommunity(commB)) {
    res.status(400).json({
      error: "Invalid community name (commB)",
      message: "Community name must be 1-64 characters, alphanumeric with hyphens and underscores only.",
    });
    return;
  }
  next();
}
