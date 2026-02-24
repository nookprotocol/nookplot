/**
 * Local file knowledge adapter.
 *
 * Reads markdown/text files from glob patterns, extracts titles
 * using configurable strategies, and returns KnowledgeEntry items.
 *
 * @module adapters/files
 */

import { readFileSync } from "node:fs";
import { basename, extname, relative, isAbsolute } from "node:path";
import { glob } from "glob";
import type { KnowledgeAdapter, KnowledgeEntry } from "./types.js";
import { computeHash } from "../utils/knowledge.js";

export interface FileAdapterConfig {
  paths: string[];
  ignore?: string[];
  titleFrom?: "filename" | "first-heading" | "frontmatter";
}

export class FileAdapter implements KnowledgeAdapter {
  readonly name = "files";
  private readonly config: FileAdapterConfig;

  constructor(config: FileAdapterConfig) {
    this.config = config;
  }

  async discover(): Promise<KnowledgeEntry[]> {
    const entries: KnowledgeEntry[] = [];
    const cwd = process.cwd();

    // Resolve all glob patterns
    const files = await glob(this.config.paths, {
      ignore: this.config.ignore ?? [],
      nodir: true,
      absolute: true,
      cwd,
    });

    // SECURITY: Filter out files that escape the project root (path traversal prevention)
    const safeFiles = files.filter((f) => {
      const rel = relative(cwd, f);
      return !rel.startsWith("..") && !isAbsolute(rel);
    });

    for (const filePath of safeFiles) {
      const content = readFileSync(filePath, "utf-8").trim();
      if (!content) continue;

      const title = this.extractTitle(filePath, content);
      const hash = computeHash(content);

      entries.push({
        id: `file:${filePath}`,
        title,
        body: content,
        hash,
      });
    }

    return entries;
  }

  /**
   * Extract a title from file content based on configured strategy.
   */
  private extractTitle(filePath: string, content: string): string {
    const mode = this.config.titleFrom ?? "filename";

    switch (mode) {
      case "first-heading": {
        // Look for first markdown heading (# Title)
        const match = content.match(/^#+\s+(.+)$/m);
        if (match) return match[1].trim();
        // Fall through to filename if no heading found
        return this.titleFromFilename(filePath);
      }

      case "frontmatter": {
        // Parse YAML frontmatter between --- delimiters
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const titleLine = fmMatch[1]
            .split("\n")
            .find((line) => line.startsWith("title:"));
          if (titleLine) {
            return titleLine
              .replace(/^title:\s*/, "")
              .replace(/^["']|["']$/g, "")
              .trim();
          }
        }
        return this.titleFromFilename(filePath);
      }

      case "filename":
      default:
        return this.titleFromFilename(filePath);
    }
  }

  /**
   * Convert a filename to Title Case.
   * "my-research-notes.md" → "My Research Notes"
   */
  private titleFromFilename(filePath: string): string {
    const name = basename(filePath, extname(filePath));
    return name
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
