/**
 * Faculty Bundle Service.
 *
 * Background service that auto-generates knowledge bundles per faculty
 * category. Each faculty gets a living bundle containing the top model
 * resources of that type, updated on a configurable schedule.
 *
 * These system-generated bundles serve as curated entry points:
 *   "Language Models", "Vision Models", "Audio Models", "Embeddings", etc.
 *
 * Bundles are stored in `faculty_bundles` (off-chain only — no gas cost).
 *
 * @module services/facultyBundleService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface FacultyBundle {
  faculty: string;
  name: string;
  description: string;
  resource_count: number;
  top_resources: FacultyBundleResource[];
  updated_at: string;
}

export interface FacultyBundleResource {
  id: string;
  title: string;
  source_type: string;
  external_id: string;
  quality_score: number;
  hf_downloads: number;
  hf_likes: number;
  url: string | null;
}

// ============================================================
//  Faculty display names
// ============================================================

const FACULTY_DISPLAY_NAMES: Record<string, string> = {
  language: "Language Models",
  generation: "Generative Models",
  vision: "Vision Models",
  audio: "Audio Models",
  embeddings: "Embedding Models",
  reasoning: "Reasoning Models",
  analysis: "Analysis Models",
  detection: "Detection Models",
  translation: "Translation Models",
  recognition: "Recognition Models",
  "reinforcement-learning": "Reinforcement Learning Models",
  robotics: "Robotics Models",
  multimodal: "Multimodal Models",
  tabular: "Tabular Models",
  video: "Video Models",
  understanding: "Understanding Models",
};

// ============================================================
//  Constants
// ============================================================

const DEFAULT_TICK_MS = 60 * 60 * 1000; // 1 hour
const TOP_RESOURCES_PER_FACULTY = 50;

// ============================================================
//  FacultyBundleService
// ============================================================

export class FacultyBundleService {
  private readonly pool: pg.Pool;
  private readonly tickMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(pool: pg.Pool, tickMs?: number) {
    this.pool = pool;
    this.tickMs = tickMs ?? DEFAULT_TICK_MS;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    // Run once on startup after a delay (let enricher populate some data first)
    setTimeout(() => this.tick().catch(() => {}), 30_000);
    logSecurityEvent("info", "faculty-bundle-service-started", { tickMs: this.tickMs });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Regenerate all faculty bundles from current resource data.
   */
  async tick(): Promise<number> {
    try {
      // Get all faculties with at least 1 resource
      const { rows: faculties } = await this.pool.query<{
        faculty: string;
        cnt: number;
      }>(
        `SELECT UNNEST(faculty) AS faculty, COUNT(*)::int AS cnt
         FROM knowledge_resources
         WHERE ARRAY_LENGTH(faculty, 1) > 0 AND enrichment_status = 'complete'
         GROUP BY faculty
         HAVING COUNT(*) >= 1
         ORDER BY cnt DESC`,
      );

      if (faculties.length === 0) return 0;

      let updated = 0;

      for (const { faculty, cnt } of faculties) {
        try {
          await this.upsertFacultyBundle(faculty, cnt);
          updated++;
        } catch (err) {
          logSecurityEvent("warn", "faculty-bundle-update-failed", {
            faculty,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (updated > 0) {
        logSecurityEvent("info", "faculty-bundles-updated", {
          count: updated,
          faculties: faculties.map((f) => f.faculty),
        });
      }

      return updated;
    } catch (err) {
      logSecurityEvent("warn", "faculty-bundle-tick-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  private async upsertFacultyBundle(faculty: string, totalCount: number): Promise<void> {
    // Get top resources for this faculty (by quality, then downloads)
    const { rows: resources } = await this.pool.query<FacultyBundleResource>(
      `SELECT id, title, source_type, external_id, quality_score,
              hf_downloads, hf_likes, url
       FROM knowledge_resources
       WHERE faculty @> ARRAY[$1]::text[]
         AND enrichment_status = 'complete'
       ORDER BY quality_score DESC, hf_downloads DESC, hf_likes DESC
       LIMIT $2`,
      [faculty, TOP_RESOURCES_PER_FACULTY],
    );

    const displayName = FACULTY_DISPLAY_NAMES[faculty] ?? `${faculty.charAt(0).toUpperCase()}${faculty.slice(1)} Models`;
    const description = `Auto-curated collection of ${totalCount} ${faculty} resources from Hugging Face, Replicate, and other registries. Updated hourly.`;

    // Upsert into faculty_bundles table
    await this.pool.query(
      `INSERT INTO faculty_bundles (faculty, name, description, resource_count, top_resources, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (faculty)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         resource_count = EXCLUDED.resource_count,
         top_resources = EXCLUDED.top_resources,
         updated_at = NOW()`,
      [faculty, displayName, description, totalCount, JSON.stringify(resources)],
    );
  }

  // ----------------------------------------------------------
  //  Query methods
  // ----------------------------------------------------------

  async listFacultyBundles(): Promise<FacultyBundle[]> {
    const { rows } = await this.pool.query<FacultyBundle>(
      `SELECT faculty, name, description, resource_count, top_resources, updated_at
       FROM faculty_bundles
       ORDER BY resource_count DESC`,
    );
    return rows;
  }

  async getFacultyBundle(faculty: string): Promise<FacultyBundle | null> {
    const { rows } = await this.pool.query<FacultyBundle>(
      `SELECT faculty, name, description, resource_count, top_resources, updated_at
       FROM faculty_bundles
       WHERE faculty = $1`,
      [faculty],
    );
    return rows[0] ?? null;
  }
}
