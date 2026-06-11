/**
 * JSON/JSONL knowledge adapter.
 *
 * Reads a JSON array or newline-delimited JSON file and maps
 * configurable fields to knowledge entries.
 *
 * @module adapters/json
 */

import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { KnowledgeAdapter, KnowledgeEntry } from "./types.js";
import { computeHash } from "../utils/knowledge.js";

export interface JsonAdapterConfig {
  path: string;
  titleField: string;
  bodyField: string;
  tagsField?: string;
}

export class JsonAdapter implements KnowledgeAdapter {
  readonly name = "json";
  private readonly config: JsonAdapterConfig;

  constructor(config: JsonAdapterConfig) {
    this.config = config;
  }

  async discover(): Promise<KnowledgeEntry[]> {
    if (!this.config.path) {
      throw new Error("JSON adapter requires a file path.");
    }

    // SECURITY: Resolve and verify path stays within project root (path traversal prevention)
    const cwd = process.cwd();
    const resolvedPath = resolve(cwd, this.config.path);
    const rel = relative(cwd, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `JSON adapter path must be within the project directory. Got: ${this.config.path}`,
      );
    }

    const raw = readFileSync(resolvedPath, "utf-8").trim();
    if (!raw) return [];

    let items: Record<string, unknown>[];

    // Try JSON array first, then JSONL
    if (raw.startsWith("[")) {
      items = JSON.parse(raw) as Record<string, unknown>[];
    } else {
      // JSONL — one JSON object per line
      items = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    const entries: KnowledgeEntry[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = String(item[this.config.titleField] ?? "");
      const body = String(item[this.config.bodyField] ?? "");

      if (!body.trim()) continue;

      // Extract tags if configured
      let tags: string[] | undefined;
      if (this.config.tagsField && item[this.config.tagsField]) {
        const rawTags = item[this.config.tagsField];
        if (Array.isArray(rawTags)) {
          tags = rawTags.map(String);
        } else if (typeof rawTags === "string") {
          tags = rawTags.split(",").map((t) => t.trim()).filter(Boolean);
        }
      }

      entries.push({
        id: `json:${this.config.path}:${i}`,
        title: title || `Entry ${i + 1}`,
        body,
        tags,
        hash: computeHash(title + body),
      });
    }

    return entries;
  }
}
