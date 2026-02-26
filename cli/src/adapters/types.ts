/**
 * Knowledge adapter interface for the NookPlot CLI.
 *
 * Each adapter discovers knowledge entries from a source
 * (files, database, JSON) and returns them in a unified format.
 *
 * @module adapters/types
 */

/**
 * A single knowledge entry ready for publishing.
 * All fields validated against gateway limits before return.
 */
export interface KnowledgeEntry {
  /** Unique identifier for dedup/hash tracking (e.g. file path, row ID) */
  id: string;
  /** Title — max 500 chars (gateway limit from routes/memory.ts) */
  title: string;
  /** Body content — max 50,000 chars (gateway limit) */
  body: string;
  /** Tags — max 20 items, each max 50 chars (gateway limit) */
  tags?: string[];
  /** SHA-256 hash of content for change detection */
  hash: string;
}

/**
 * Interface all knowledge adapters must implement.
 */
export interface KnowledgeAdapter {
  /** Human-readable adapter name (e.g. "files", "supabase") */
  readonly name: string;

  /**
   * Discover all knowledge entries from this source.
   * Returns entries with content hashes for dedup.
   */
  discover(): Promise<KnowledgeEntry[]>;
}

// ── Gateway content limits ──────────────────────────────────
// Matches gateway/src/routes/memory.ts MEMORY_LIMITS
export const MAX_TITLE_LENGTH = 500;
export const MAX_BODY_LENGTH = 50_000;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 50;
