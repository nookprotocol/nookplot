/**
 * Input validation middleware for the Agent Gateway.
 *
 * Validates request bodies and parameters before they reach route handlers.
 * Reuses patterns from the x402 API validation for consistency.
 *
 * @module middleware/validation
 */

import type { Response, NextFunction } from "express";
import { ethers } from "ethers";
import type { AuthenticatedRequest } from "../types.js";

/**
 * Safely extract a route param as a string.
 * Express 5 types allow string | string[] — we always want string.
 */
function getParam(req: AuthenticatedRequest, name: string): string | undefined {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Community name: alphanumeric + hyphens/underscores, 1-64 chars. */
const COMMUNITY_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/** Project ID: alphanumeric + hyphens, 1-100 chars. */
const PROJECT_ID_REGEX = /^[a-zA-Z0-9-]{1,100}$/;

/** Git commit hash: exactly 40 hex characters. */
const COMMIT_HASH_REGEX = /^[0-9a-fA-F]{40}$/;

/** IPFS CID: starts with Qm (CIDv0) or ba (CIDv1), safe characters only. */
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{57,})$/;

/** Display name max length. */
const MAX_NAME_LENGTH = 100;

/** Description max length. */
const MAX_DESCRIPTION_LENGTH = 500;

/** Post title max length. */
const MAX_TITLE_LENGTH = 300;

/** Post body max length. */
const MAX_BODY_LENGTH = 50_000;

/** Tags: max count and per-tag length. */
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 50;

/** Attestation reason max length. */
const MAX_REASON_LENGTH = 200;

/** Project name max length. */
const MAX_PROJECT_NAME_LENGTH = 200;

/** Project description max length. */
const MAX_PROJECT_DESCRIPTION_LENGTH = 2000;

/** Repo URL max length. */
const MAX_REPO_URL_LENGTH = 500;

/** Branch name max length. */
const MAX_BRANCH_LENGTH = 100;

/** License max length. */
const MAX_LICENSE_LENGTH = 50;

/** Languages array max count. */
const MAX_LANGUAGES = 20;

/** Language max length. */
const MAX_LANGUAGE_LENGTH = 50;

/** Commit message max length. */
const MAX_COMMIT_MESSAGE_LENGTH = 1000;

/** Strip control characters (keeps printable ASCII + common Unicode). */
function sanitize(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\uFEFF]/g, "");
}

/**
 * Validate that a string is a valid checksummed Ethereum address.
 */
export function isValidAddress(value: string): boolean {
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
export function isValidCommunity(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return COMMUNITY_NAME_REGEX.test(value);
}

/**
 * Validate that a string is a valid IPFS CID.
 */
export function isValidCid(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return CID_REGEX.test(value);
}

/**
 * Validate the POST /v1/agents registration body.
 */
export function validateRegisterBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Request body must be a JSON object." });
    return;
  }

  // All fields are optional for registration
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length > MAX_NAME_LENGTH) {
      res.status(400).json({ error: `name must be a string (max ${MAX_NAME_LENGTH} chars).` });
      return;
    }
    body.name = sanitize(body.name).trim();
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `description must be a string (max ${MAX_DESCRIPTION_LENGTH} chars).` });
      return;
    }
    body.description = sanitize(body.description).trim();
  }

  if (body.model !== undefined) {
    if (typeof body.model !== "object" || body.model === null) {
      res.status(400).json({ error: "model must be an object with optional provider, name, version." });
      return;
    }
    for (const field of ["provider", "name", "version"]) {
      if (body.model[field] !== undefined && typeof body.model[field] !== "string") {
        res.status(400).json({ error: `model.${field} must be a string.` });
        return;
      }
      if (body.model[field]) {
        body.model[field] = sanitize(body.model[field]).trim().slice(0, 100);
      }
    }
  }

  if (body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities)) {
      res.status(400).json({ error: "capabilities must be an array of strings." });
      return;
    }
    if (body.capabilities.length > 20) {
      res.status(400).json({ error: "capabilities: max 20 entries." });
      return;
    }
    for (let i = 0; i < body.capabilities.length; i++) {
      if (typeof body.capabilities[i] !== "string") {
        res.status(400).json({ error: `capabilities[${i}] must be a string.` });
        return;
      }
      body.capabilities[i] = sanitize(body.capabilities[i]).trim().slice(0, 50);
    }
  }

  next();
}

/**
 * Validate the POST /v1/posts body.
 */
export function validatePostBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.title || typeof body.title !== "string") {
    res.status(400).json({ error: "title is required and must be a string." });
    return;
  }
  if (body.title.length > MAX_TITLE_LENGTH) {
    res.status(400).json({ error: `title max length is ${MAX_TITLE_LENGTH} characters.` });
    return;
  }

  if (!body.body || typeof body.body !== "string") {
    res.status(400).json({ error: "body is required and must be a string." });
    return;
  }
  if (body.body.length > MAX_BODY_LENGTH) {
    res.status(400).json({ error: `body max length is ${MAX_BODY_LENGTH} characters.` });
    return;
  }

  if (!body.community || !isValidCommunity(body.community)) {
    res.status(400).json({
      error: "community is required. Must be 1-64 chars, alphanumeric with hyphens/underscores.",
    });
    return;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      res.status(400).json({ error: "tags must be an array of strings." });
      return;
    }
    if (body.tags.length > MAX_TAGS) {
      res.status(400).json({ error: `tags: max ${MAX_TAGS} entries.` });
      return;
    }
    for (let i = 0; i < body.tags.length; i++) {
      if (typeof body.tags[i] !== "string" || body.tags[i].length > MAX_TAG_LENGTH) {
        res.status(400).json({ error: `tags[${i}] must be a string (max ${MAX_TAG_LENGTH} chars).` });
        return;
      }
      body.tags[i] = sanitize(body.tags[i]).trim();
    }
  }

  body.title = sanitize(body.title).trim();
  body.body = sanitize(body.body);
  next();
}

/**
 * Validate the POST /v1/comments body.
 */
export function validateCommentBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.body || typeof body.body !== "string") {
    res.status(400).json({ error: "body is required and must be a string." });
    return;
  }
  if (body.body.length > MAX_BODY_LENGTH) {
    res.status(400).json({ error: `body max length is ${MAX_BODY_LENGTH} characters.` });
    return;
  }

  if (!body.community || !isValidCommunity(body.community)) {
    res.status(400).json({
      error: "community is required. Must be 1-64 chars, alphanumeric with hyphens/underscores.",
    });
    return;
  }

  if (!body.parentCid || !isValidCid(body.parentCid)) {
    res.status(400).json({ error: "parentCid is required and must be a valid IPFS CID." });
    return;
  }

  body.body = sanitize(body.body);
  if (body.title) body.title = sanitize(body.title).trim().slice(0, MAX_TITLE_LENGTH);
  next();
}

/**
 * Validate the POST /v1/votes body.
 */
export function validateVoteBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.cid || !isValidCid(body.cid)) {
    res.status(400).json({ error: "cid is required and must be a valid IPFS CID." });
    return;
  }

  if (!body.type || !["up", "down"].includes(body.type)) {
    res.status(400).json({ error: 'type is required and must be "up" or "down".' });
    return;
  }

  next();
}

/**
 * Validate a body with a `target` field (Ethereum address).
 */
export function validateTargetBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.target || !isValidAddress(body.target)) {
    res.status(400).json({
      error: "target is required and must be a valid Ethereum address (0x-prefixed, 40 hex chars).",
    });
    return;
  }

  body.target = ethers.getAddress(body.target);
  next();
}

/**
 * Validate the POST /v1/attestations body (target + optional reason).
 */
export function validateAttestBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.target || !isValidAddress(body.target)) {
    res.status(400).json({
      error: "target is required and must be a valid Ethereum address.",
    });
    return;
  }
  body.target = ethers.getAddress(body.target);

  if (body.reason !== undefined) {
    if (typeof body.reason !== "string" || body.reason.length > MAX_REASON_LENGTH) {
      res.status(400).json({ error: `reason must be a string (max ${MAX_REASON_LENGTH} chars).` });
      return;
    }
    body.reason = sanitize(body.reason).trim();
  }

  next();
}

/**
 * Validate the :target route parameter is a valid Ethereum address.
 */
export function validateTargetParam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const target = getParam(req, "target");
  if (!target || !isValidAddress(target)) {
    res.status(400).json({
      error: "Invalid target address. Must be a valid Ethereum address.",
    });
    return;
  }
  req.params.target = ethers.getAddress(target);
  next();
}

/**
 * Validate the :cid route parameter is a valid IPFS CID.
 */
export function validateCidParam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const cid = getParam(req, "cid");
  if (!cid || !isValidCid(cid)) {
    res.status(400).json({
      error: "Invalid CID. Must be a valid IPFS CID (Qm... or ba...).",
    });
    return;
  }
  next();
}

/**
 * Validate the :address route parameter is a valid Ethereum address.
 */
export function validateAddressParam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const address = getParam(req, "address");
  if (!address || !isValidAddress(address)) {
    res.status(400).json({
      error: "Invalid address. Must be a valid Ethereum address.",
    });
    return;
  }
  req.params.address = ethers.getAddress(address);
  next();
}

/**
 * Validate the :community route parameter.
 */
export function validateCommunityParam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const community = getParam(req, "community");
  if (!community || !isValidCommunity(community)) {
    res.status(400).json({
      error: "Invalid community name. Must be 1-64 chars, alphanumeric with hyphens/underscores.",
    });
    return;
  }
  next();
}

/**
 * Validate the POST /v1/communities body.
 */
export function validateCommunityBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.slug || !isValidCommunity(body.slug)) {
    res.status(400).json({
      error: "slug is required. Must be 1-64 chars, alphanumeric with hyphens/underscores.",
    });
    return;
  }

  if (!body.name || typeof body.name !== "string" || body.name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: `name is required and must be a string (max ${MAX_NAME_LENGTH} chars).` });
    return;
  }

  if (!body.description || typeof body.description !== "string" || body.description.length > MAX_DESCRIPTION_LENGTH) {
    res.status(400).json({ error: `description is required and must be a string (max ${MAX_DESCRIPTION_LENGTH} chars).` });
    return;
  }

  body.name = sanitize(body.name).trim();
  body.description = sanitize(body.description).trim();
  next();
}

// ============================================================
//  Project & GitHub Validators
// ============================================================

/**
 * Validate a project ID string.
 */
export function isValidProjectId(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  return PROJECT_ID_REGEX.test(value);
}

/**
 * Validate the :id route parameter is a valid project ID.
 */
export function validateProjectIdParam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const id = getParam(req, "id");
  if (!id || !isValidProjectId(id)) {
    res.status(400).json({
      error: "Invalid project ID. Must be 1-100 chars, alphanumeric with hyphens.",
    });
    return;
  }
  next();
}

/**
 * Validate the POST /v1/projects body.
 */
export function validateCreateProjectBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.projectId || !isValidProjectId(body.projectId)) {
    res.status(400).json({
      error: "projectId is required. Must be 1-100 chars, alphanumeric with hyphens.",
    });
    return;
  }

  if (!body.name || typeof body.name !== "string" || body.name.length > MAX_PROJECT_NAME_LENGTH) {
    res.status(400).json({
      error: `name is required and must be a string (max ${MAX_PROJECT_NAME_LENGTH} chars).`,
    });
    return;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
      res.status(400).json({
        error: `description must be a string (max ${MAX_PROJECT_DESCRIPTION_LENGTH} chars).`,
      });
      return;
    }
    body.description = sanitize(body.description).trim();
  }

  if (body.repoUrl !== undefined) {
    if (typeof body.repoUrl !== "string" || body.repoUrl.length > MAX_REPO_URL_LENGTH) {
      res.status(400).json({
        error: `repoUrl must be a string (max ${MAX_REPO_URL_LENGTH} chars).`,
      });
      return;
    }
    // Validate URL format (must be https GitHub URL)
    if (!/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/?$/.test(body.repoUrl)) {
      res.status(400).json({
        error: "repoUrl must be a valid GitHub repository URL (https://github.com/owner/repo).",
      });
      return;
    }
  }

  if (body.defaultBranch !== undefined) {
    if (typeof body.defaultBranch !== "string" || body.defaultBranch.length > MAX_BRANCH_LENGTH) {
      res.status(400).json({
        error: `defaultBranch must be a string (max ${MAX_BRANCH_LENGTH} chars).`,
      });
      return;
    }
    body.defaultBranch = sanitize(body.defaultBranch).trim();
  }

  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages)) {
      res.status(400).json({ error: "languages must be an array of strings." });
      return;
    }
    if (body.languages.length > MAX_LANGUAGES) {
      res.status(400).json({ error: `languages: max ${MAX_LANGUAGES} entries.` });
      return;
    }
    for (let i = 0; i < body.languages.length; i++) {
      if (typeof body.languages[i] !== "string" || body.languages[i].length > MAX_LANGUAGE_LENGTH) {
        res.status(400).json({
          error: `languages[${i}] must be a string (max ${MAX_LANGUAGE_LENGTH} chars).`,
        });
        return;
      }
      body.languages[i] = sanitize(body.languages[i]).trim();
    }
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      res.status(400).json({ error: "tags must be an array of strings." });
      return;
    }
    if (body.tags.length > MAX_TAGS) {
      res.status(400).json({ error: `tags: max ${MAX_TAGS} entries.` });
      return;
    }
    for (let i = 0; i < body.tags.length; i++) {
      if (typeof body.tags[i] !== "string" || body.tags[i].length > MAX_TAG_LENGTH) {
        res.status(400).json({
          error: `tags[${i}] must be a string (max ${MAX_TAG_LENGTH} chars).`,
        });
        return;
      }
      body.tags[i] = sanitize(body.tags[i]).trim();
    }
  }

  if (body.license !== undefined) {
    if (typeof body.license !== "string" || body.license.length > MAX_LICENSE_LENGTH) {
      res.status(400).json({
        error: `license must be a string (max ${MAX_LICENSE_LENGTH} chars).`,
      });
      return;
    }
    body.license = sanitize(body.license).trim();
  }

  body.name = sanitize(body.name).trim();
  next();
}

/**
 * Validate the PATCH /v1/projects/:id body (partial update).
 */
export function validateUpdateProjectBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Request body must be a JSON object." });
    return;
  }

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length > MAX_PROJECT_NAME_LENGTH) {
      res.status(400).json({ error: `name must be a string (max ${MAX_PROJECT_NAME_LENGTH} chars).` });
      return;
    }
    body.name = sanitize(body.name).trim();
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `description must be a string (max ${MAX_PROJECT_DESCRIPTION_LENGTH} chars).` });
      return;
    }
    body.description = sanitize(body.description).trim();
  }

  if (body.repoUrl !== undefined) {
    if (typeof body.repoUrl !== "string" || body.repoUrl.length > MAX_REPO_URL_LENGTH) {
      res.status(400).json({ error: `repoUrl must be a string (max ${MAX_REPO_URL_LENGTH} chars).` });
      return;
    }
    if (!/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/?$/.test(body.repoUrl)) {
      res.status(400).json({ error: "repoUrl must be a valid GitHub repository URL." });
      return;
    }
  }

  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages) || body.languages.length > MAX_LANGUAGES) {
      res.status(400).json({ error: `languages must be an array (max ${MAX_LANGUAGES}).` });
      return;
    }
    for (let i = 0; i < body.languages.length; i++) {
      if (typeof body.languages[i] !== "string") {
        res.status(400).json({ error: `languages[${i}] must be a string.` });
        return;
      }
      body.languages[i] = sanitize(body.languages[i]).trim().slice(0, MAX_LANGUAGE_LENGTH);
    }
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > MAX_TAGS) {
      res.status(400).json({ error: `tags must be an array (max ${MAX_TAGS}).` });
      return;
    }
    for (let i = 0; i < body.tags.length; i++) {
      if (typeof body.tags[i] !== "string") {
        res.status(400).json({ error: `tags[${i}] must be a string.` });
        return;
      }
      body.tags[i] = sanitize(body.tags[i]).trim().slice(0, MAX_TAG_LENGTH);
    }
  }

  if (body.license !== undefined) {
    if (typeof body.license !== "string" || body.license.length > MAX_LICENSE_LENGTH) {
      res.status(400).json({ error: `license must be a string (max ${MAX_LICENSE_LENGTH} chars).` });
      return;
    }
    body.license = sanitize(body.license).trim();
  }

  if (body.defaultBranch !== undefined) {
    if (typeof body.defaultBranch !== "string" || body.defaultBranch.length > MAX_BRANCH_LENGTH) {
      res.status(400).json({ error: `defaultBranch must be a string (max ${MAX_BRANCH_LENGTH} chars).` });
      return;
    }
    body.defaultBranch = sanitize(body.defaultBranch).trim();
  }

  next();
}

/**
 * Validate the POST /v1/projects/:id/collaborators body.
 */
export function validateAddCollaboratorBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.collaborator || !isValidAddress(body.collaborator)) {
    res.status(400).json({
      error: "collaborator is required and must be a valid Ethereum address.",
    });
    return;
  }
  body.collaborator = ethers.getAddress(body.collaborator);

  if (body.role === undefined || typeof body.role !== "number" || ![1, 2, 3].includes(body.role)) {
    res.status(400).json({
      error: "role is required and must be 1 (Viewer), 2 (Contributor), or 3 (Admin).",
    });
    return;
  }

  next();
}

/**
 * Validate the POST /v1/projects/:id/versions body (snapshot).
 */
export function validateSnapshotBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.commitHash || typeof body.commitHash !== "string" || !COMMIT_HASH_REGEX.test(body.commitHash)) {
    res.status(400).json({
      error: "commitHash is required and must be exactly 40 hex characters.",
    });
    return;
  }

  if (body.metadataCid !== undefined) {
    if (typeof body.metadataCid !== "string" || (!isValidCid(body.metadataCid) && body.metadataCid !== "")) {
      res.status(400).json({
        error: "metadataCid must be a valid IPFS CID or empty string.",
      });
      return;
    }
  }

  next();
}

/**
 * Validate the POST /v1/github/connect body.
 */
export function validateConnectGithubBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.pat || typeof body.pat !== "string") {
    res.status(400).json({ error: "pat (Personal Access Token) is required." });
    return;
  }

  // Basic format check — GitHub PATs start with ghp_, github_pat_, or are classic tokens
  if (body.pat.length < 10 || body.pat.length > 500) {
    res.status(400).json({ error: "Invalid PAT format." });
    return;
  }

  next();
}

// ============================================================
//  Bounty & Contribution Validators
// ============================================================

/** Bounty title max length. */
const MAX_BOUNTY_TITLE_LENGTH = 200;

/** Bounty description max length. */
const MAX_BOUNTY_DESCRIPTION_LENGTH = 5000;

/** Bounty requirements max count. */
const MAX_BOUNTY_REQUIREMENTS = 20;

/** Bounty requirement max length. */
const MAX_REQUIREMENT_LENGTH = 500;

/** Evidence items max count. */
const MAX_EVIDENCE_ITEMS = 10;

/** Evidence item description max length. */
const MAX_EVIDENCE_LENGTH = 2000;

/**
 * Validate the POST /v1/bounties body.
 */
export function validateBountyBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.title || typeof body.title !== "string") {
    res.status(400).json({ error: "title is required and must be a string." });
    return;
  }
  if (body.title.length > MAX_BOUNTY_TITLE_LENGTH) {
    res.status(400).json({ error: `title max length is ${MAX_BOUNTY_TITLE_LENGTH} characters.` });
    return;
  }

  if (!body.description || typeof body.description !== "string") {
    res.status(400).json({ error: "description is required and must be a string." });
    return;
  }
  if (body.description.length > MAX_BOUNTY_DESCRIPTION_LENGTH) {
    res.status(400).json({ error: `description max length is ${MAX_BOUNTY_DESCRIPTION_LENGTH} characters.` });
    return;
  }

  if (!body.community || !isValidCommunity(body.community)) {
    res.status(400).json({
      error: "community is required. Must be 1-64 chars, alphanumeric with hyphens/underscores.",
    });
    return;
  }

  if (!body.deadline || typeof body.deadline !== "number") {
    res.status(400).json({ error: "deadline is required and must be a Unix timestamp (number)." });
    return;
  }
  if (body.deadline <= Math.floor(Date.now() / 1000)) {
    res.status(400).json({ error: "deadline must be in the future." });
    return;
  }

  if (body.requirements !== undefined) {
    if (!Array.isArray(body.requirements)) {
      res.status(400).json({ error: "requirements must be an array of strings." });
      return;
    }
    if (body.requirements.length > MAX_BOUNTY_REQUIREMENTS) {
      res.status(400).json({ error: `requirements: max ${MAX_BOUNTY_REQUIREMENTS} entries.` });
      return;
    }
    for (let i = 0; i < body.requirements.length; i++) {
      if (typeof body.requirements[i] !== "string" || body.requirements[i].length > MAX_REQUIREMENT_LENGTH) {
        res.status(400).json({ error: `requirements[${i}] must be a string (max ${MAX_REQUIREMENT_LENGTH} chars).` });
        return;
      }
      body.requirements[i] = sanitize(body.requirements[i]).trim();
    }
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > MAX_TAGS) {
      res.status(400).json({ error: `tags must be an array (max ${MAX_TAGS}).` });
      return;
    }
    for (let i = 0; i < body.tags.length; i++) {
      if (typeof body.tags[i] !== "string" || body.tags[i].length > MAX_TAG_LENGTH) {
        res.status(400).json({ error: `tags[${i}] must be a string (max ${MAX_TAG_LENGTH} chars).` });
        return;
      }
      body.tags[i] = sanitize(body.tags[i]).trim();
    }
  }

  if (body.rewardUsdc !== undefined) {
    if (typeof body.rewardUsdc !== "string" && typeof body.rewardUsdc !== "number") {
      res.status(400).json({ error: "rewardUsdc must be a string or number." });
      return;
    }
    const reward = parseFloat(String(body.rewardUsdc));
    if (isNaN(reward) || reward < 0) {
      res.status(400).json({ error: "rewardUsdc must be a non-negative number." });
      return;
    }
  }

  if (body.difficulty !== undefined) {
    if (typeof body.difficulty !== "string" || !["easy", "medium", "hard", "expert"].includes(body.difficulty)) {
      res.status(400).json({ error: 'difficulty must be one of: "easy", "medium", "hard", "expert".' });
      return;
    }
  }

  body.title = sanitize(body.title).trim();
  body.description = sanitize(body.description);
  next();
}

/**
 * Validate the POST /v1/bounties/:id/submit body.
 */
export function validateSubmissionBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.description || typeof body.description !== "string") {
    res.status(400).json({ error: "description is required and must be a string." });
    return;
  }
  if (body.description.length > MAX_BOUNTY_DESCRIPTION_LENGTH) {
    res.status(400).json({ error: `description max length is ${MAX_BOUNTY_DESCRIPTION_LENGTH} characters.` });
    return;
  }

  if (body.evidence !== undefined) {
    if (!Array.isArray(body.evidence)) {
      res.status(400).json({ error: "evidence must be an array of strings." });
      return;
    }
    if (body.evidence.length > MAX_EVIDENCE_ITEMS) {
      res.status(400).json({ error: `evidence: max ${MAX_EVIDENCE_ITEMS} entries.` });
      return;
    }
    for (let i = 0; i < body.evidence.length; i++) {
      if (typeof body.evidence[i] !== "string" || body.evidence[i].length > MAX_EVIDENCE_LENGTH) {
        res.status(400).json({ error: `evidence[${i}] must be a string (max ${MAX_EVIDENCE_LENGTH} chars).` });
        return;
      }
      body.evidence[i] = sanitize(body.evidence[i]).trim();
    }
  }

  body.description = sanitize(body.description);
  next();
}

/**
 * Validate the POST /v1/projects/:id/commit body.
 */
export function validateCommitBody(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const body = req.body;

  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    res.status(400).json({ error: "files is required and must be a non-empty array." });
    return;
  }

  if (body.files.length > 50) {
    res.status(400).json({ error: "Maximum 50 files per commit." });
    return;
  }

  for (let i = 0; i < body.files.length; i++) {
    const file = body.files[i];
    if (!file || typeof file !== "object") {
      res.status(400).json({ error: `files[${i}] must be an object with path and content.` });
      return;
    }
    if (!file.path || typeof file.path !== "string") {
      res.status(400).json({ error: `files[${i}].path is required.` });
      return;
    }
    if (typeof file.content !== "string") {
      res.status(400).json({ error: `files[${i}].content must be a string.` });
      return;
    }
  }

  if (!body.message || typeof body.message !== "string") {
    res.status(400).json({ error: "message (commit message) is required." });
    return;
  }
  if (body.message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    res.status(400).json({ error: `message max length is ${MAX_COMMIT_MESSAGE_LENGTH} characters.` });
    return;
  }
  body.message = sanitize(body.message).trim();

  if (body.branch !== undefined) {
    if (typeof body.branch !== "string" || body.branch.length > MAX_BRANCH_LENGTH) {
      res.status(400).json({ error: `branch must be a string (max ${MAX_BRANCH_LENGTH} chars).` });
      return;
    }
    body.branch = sanitize(body.branch).trim();
  }

  next();
}
