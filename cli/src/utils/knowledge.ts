/**
 * Shared knowledge utilities for the NookPlot CLI.
 *
 * Hash store management, content hashing, env var resolution,
 * and gateway limit validation.
 *
 * @module utils/knowledge
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  type KnowledgeEntry,
} from "../adapters/types.js";

// ── Hash store ──────────────────────────────────────────────

export type HashStore = Record<string, string>;

/**
 * Load the hash store from disk.
 * Returns empty object if file doesn't exist.
 */
export function loadHashStore(path: string): HashStore {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as HashStore;
  } catch {
    return {};
  }
}

/**
 * Save the hash store to disk.
 */
export function saveHashStore(path: string, store: HashStore): void {
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

// ── Content hashing ─────────────────────────────────────────

/**
 * Compute SHA-256 hash of content string.
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate a knowledge entry against gateway limits.
 * Returns array of warning messages (empty = valid).
 * Mutates the entry to truncate if needed.
 */
export function validateAndTruncate(entry: KnowledgeEntry): string[] {
  const warnings: string[] = [];

  if (entry.title.length > MAX_TITLE_LENGTH) {
    warnings.push(
      `Title truncated from ${entry.title.length} to ${MAX_TITLE_LENGTH} chars: "${entry.title.slice(0, 40)}..."`,
    );
    entry.title = entry.title.slice(0, MAX_TITLE_LENGTH);
  }

  if (entry.body.length > MAX_BODY_LENGTH) {
    warnings.push(
      `Body truncated from ${entry.body.length} to ${MAX_BODY_LENGTH} chars for "${entry.title}"`,
    );
    entry.body = entry.body.slice(0, MAX_BODY_LENGTH);
  }

  if (entry.tags) {
    if (entry.tags.length > MAX_TAGS) {
      warnings.push(
        `Tags truncated from ${entry.tags.length} to ${MAX_TAGS} for "${entry.title}"`,
      );
      entry.tags = entry.tags.slice(0, MAX_TAGS);
    }
    entry.tags = entry.tags.map((t) => t.slice(0, MAX_TAG_LENGTH));
  }

  // Recompute hash after truncation so the hash store tracks what was actually published
  if (warnings.length > 0) {
    entry.hash = computeHash(entry.title + entry.body);
  }

  return warnings;
}
