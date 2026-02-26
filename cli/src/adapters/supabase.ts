/**
 * Supabase knowledge adapter.
 *
 * Pulls rows from a Supabase/PostgreSQL table and maps
 * configurable columns to knowledge entries.
 *
 * Credentials come from env vars (referenced via ${VAR} in YAML).
 *
 * @module adapters/supabase
 */

import type { KnowledgeAdapter, KnowledgeEntry } from "./types.js";
import { computeHash } from "../utils/knowledge.js";

export interface SupabaseAdapterConfig {
  url: string;
  key: string;
  table: string;
  contentColumn: string;
  titleColumn: string;
  filter?: string;
}

export class SupabaseAdapter implements KnowledgeAdapter {
  readonly name = "supabase";
  private readonly config: SupabaseAdapterConfig;

  constructor(config: SupabaseAdapterConfig) {
    this.config = config;
  }

  async discover(): Promise<KnowledgeEntry[]> {
    // Dynamic import — @supabase/supabase-js is an optional peer dependency.
    // Use string variable to prevent TypeScript from resolving the module at compile time.
    const moduleName = "@supabase/supabase-js";
    let createClient: (url: string, key: string) => unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const mod = await (import(/* webpackIgnore: true */ moduleName) as Promise<{ createClient: (url: string, key: string) => unknown }>);
      createClient = mod.createClient;
    } catch {
      throw new Error(
        "Supabase adapter requires @supabase/supabase-js.\n" +
        "Install it with: npm install @supabase/supabase-js",
      );
    }

    if (!this.config.url || !this.config.key) {
      throw new Error(
        "Supabase adapter requires url and key.\n" +
        "Set them in nookplot.yaml using ${ENV_VAR} syntax and add values to .env",
      );
    }

    if (!this.config.table) {
      throw new Error("Supabase adapter requires a table name.");
    }

    const client = createClient(this.config.url, this.config.key) as {
      from: (table: string) => {
        select: (columns: string) => {
          then: (resolve: (result: { data: Record<string, unknown>[] | null; error: unknown }) => void) => void;
        };
      };
    };

    // Warn if filter is configured — not yet implemented
    if (this.config.filter) {
      console.warn(
        `  \u26a0 Supabase 'filter' config is not yet supported. All rows from '${this.config.table}' will be fetched.`,
      );
    }

    const columns = [
      this.config.titleColumn ?? "title",
      this.config.contentColumn ?? "content",
      "id",
    ].join(", ");

    const result = await new Promise<{ data: Record<string, unknown>[] | null; error: unknown }>(
      (resolve) => {
        client
          .from(this.config.table)
          .select(columns)
          .then(resolve);
      },
    );

    if (result.error) {
      throw new Error(`Supabase query failed: ${String(result.error)}`);
    }

    const rows = result.data ?? [];
    const entries: KnowledgeEntry[] = [];

    for (const row of rows) {
      const title = String(row[this.config.titleColumn ?? "title"] ?? "");
      const body = String(row[this.config.contentColumn ?? "content"] ?? "");
      const rowId = String(row.id ?? entries.length);

      if (!body.trim()) continue;

      entries.push({
        id: `supabase:${this.config.table}:${rowId}`,
        title: title || `Row ${rowId}`,
        body,
        hash: computeHash(title + body),
      });
    }

    return entries;
  }
}
