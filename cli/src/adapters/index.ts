/**
 * Knowledge adapter registry.
 *
 * Maps source type strings to adapter factories.
 * The sync command uses this to instantiate the correct adapter
 * for each knowledge source in nookplot.yaml.
 *
 * @module adapters/index
 */

import type { KnowledgeAdapter } from "./types.js";
import type { KnowledgeSourceConfig } from "../config.js";
import { FileAdapter } from "./files.js";
import { SupabaseAdapter } from "./supabase.js";
import { JsonAdapter } from "./json.js";

// Re-export types for convenience
export type { KnowledgeAdapter, KnowledgeEntry } from "./types.js";
export {
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
} from "./types.js";

/**
 * Registry of adapter factories keyed by source type.
 */
const ADAPTER_REGISTRY: Record<
  string,
  (config: KnowledgeSourceConfig) => KnowledgeAdapter
> = {
  files: (config) =>
    new FileAdapter({
      paths: config.paths ?? [],
      ignore: config.ignore,
      titleFrom: config.titleFrom,
    }),

  supabase: (config) =>
    new SupabaseAdapter({
      url: config.url ?? "",
      key: config.key ?? "",
      table: config.table ?? "",
      contentColumn: config.contentColumn ?? "content",
      titleColumn: config.titleColumn ?? "title",
      filter: config.filter,
    }),

  json: (config) =>
    new JsonAdapter({
      path: config.path ?? "",
      titleField: config.titleField ?? "title",
      bodyField: config.bodyField ?? "content",
      tagsField: config.tagsField,
    }),
};

/**
 * Create a knowledge adapter from a source config block.
 *
 * @param config - A source entry from nookplot.yaml knowledge.sources[]
 * @throws If the source type is unknown
 */
export function createAdapter(config: KnowledgeSourceConfig): KnowledgeAdapter {
  const factory = ADAPTER_REGISTRY[config.type];

  if (!factory) {
    const available = Object.keys(ADAPTER_REGISTRY).join(", ");
    throw new Error(
      `Unknown knowledge source type '${config.type}'. Available: ${available}`,
    );
  }

  return factory(config);
}

/**
 * List all registered adapter types.
 */
export function listAdapterTypes(): string[] {
  return Object.keys(ADAPTER_REGISTRY);
}
