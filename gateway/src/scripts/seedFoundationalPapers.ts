/**
 * Seed the knowledge base with foundational papers from the curated list.
 *
 * Reads foundational-papers.json (~200 papers across 8 fields covering the
 * intellectual roots of AI, complexity science, and information theory) and
 * ingests each via `ArxivIngestionService.ingestHistoricalPaper()`.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx gateway/src/scripts/seedFoundationalPapers.ts
 *
 * Optional env vars:
 *   SEMANTIC_SCHOLAR_API_KEY — higher rate limits for S2 lookups
 *   GROKIPEDIA_BASE_URL     — enable public sphere scoring
 *   ARXIV_QUALITY_THRESHOLD — min score to keep (default 40)
 *   ARXIV_AUTO_INGEST_THRESHOLD — auto-ingest score (default 60)
 *
 * @module scripts/seedFoundationalPapers
 */

import { Pool } from "pg";
import { SemanticScholarClient } from "../services/semanticScholarClient.js";
import { PaperQualityScorer } from "../services/paperQualityScorer.js";
import { GrokipediaClient } from "../services/grokipediaClient.js";
import { ArxivIngestionService } from "../services/arxivIngestionService.js";
import { createRequire } from "node:module";

// ============================================================
//  Types
// ============================================================

interface FoundationalPaper {
  id: string;
  title: string;
  field: string;
  year: number;
}

// ============================================================
//  Load seed data (JSON import with createRequire for Node16)
// ============================================================

const require = createRequire(import.meta.url);
const papers: FoundationalPaper[] = require("../data/foundational-papers.json");

// ============================================================
//  Helpers
// ============================================================

/** Delay for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format elapsed time in human-readable form. */
function formatElapsed(startMs: number): string {
  const elapsed = Date.now() - startMs;
  if (elapsed < 1000) return `${elapsed}ms`;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`;
  const mins = Math.floor(elapsed / 60_000);
  const secs = Math.round((elapsed % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ============================================================
//  Main
// ============================================================

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[seed] ERROR: DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  console.log(`[seed] Foundational Papers Seeder`);
  console.log(`[seed] Papers to process: ${papers.length}`);
  console.log(`[seed] Fields: ${[...new Set(papers.map((p) => p.field))].join(", ")}`);
  console.log("");

  // --- Create service instances ---

  const pool = new Pool({ connectionString: databaseUrl });

  const s2Client = new SemanticScholarClient();
  const qualityScorer = new PaperQualityScorer();
  const grokipediaClient = new GrokipediaClient();
  const ingestionService = new ArxivIngestionService(
    pool,
    s2Client,
    qualityScorer,
    grokipediaClient,
  );

  // --- Counters ---

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  const fieldCounts: Record<string, { ingested: number; failed: number }> = {};

  const startTime = Date.now();

  // --- Process each paper ---

  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    const idx = `${i + 1}/${papers.length}`;

    // Initialize field counter
    if (!fieldCounts[paper.field]) {
      fieldCounts[paper.field] = { ingested: 0, failed: 0 };
    }

    try {
      const result: unknown = await ingestionService.ingestHistoricalPaper(paper.id);

      // The ingestion service returns an object with optional `skipped` and `score` fields.
      const res = result as Record<string, unknown> | null | undefined;

      if (res && res.skipped) {
        skipped++;
        console.log(
          `[seed] [${idx}] Skipped (already exists): "${paper.title}" (${paper.year})`,
        );
      } else {
        ingested++;
        fieldCounts[paper.field].ingested++;

        // Extract score if available
        const score =
          res && typeof res.score === "number" ? ` (score: ${res.score})` : "";

        console.log(
          `[seed] [${idx}] Ingested: "${paper.title}" (${paper.year})${score}`,
        );
      }
    } catch (err: unknown) {
      failed++;
      fieldCounts[paper.field].failed++;

      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[seed] [${idx}] FAILED: "${paper.title}" (${paper.year}) — ${message}`,
      );
    }

    // Rate limiting: small delay between requests to avoid hammering APIs
    // Semantic Scholar allows 100 req/5min without key, ~1 req/3s
    if (i < papers.length - 1) {
      await sleep(3_500);
    }
  }

  // --- Summary ---

  const elapsed = formatElapsed(startTime);

  console.log("");
  console.log("=".repeat(60));
  console.log(`[seed] DONE in ${elapsed}`);
  console.log(`[seed]   Ingested: ${ingested}`);
  console.log(`[seed]   Skipped:  ${skipped}`);
  console.log(`[seed]   Failed:   ${failed}`);
  console.log(`[seed]   Total:    ${papers.length}`);
  console.log("");
  console.log("[seed] Per-field breakdown:");

  for (const [field, counts] of Object.entries(fieldCounts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const total = counts.ingested + counts.failed;
    console.log(
      `[seed]   ${field}: ${counts.ingested}/${total} ingested${counts.failed > 0 ? ` (${counts.failed} failed)` : ""}`,
    );
  }

  console.log("=".repeat(60));

  // --- Cleanup ---

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================
//  Entry point
// ============================================================

main().catch((err: unknown) => {
  console.error("[seed] Unhandled error:", err);
  process.exit(2);
});
