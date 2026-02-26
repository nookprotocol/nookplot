/**
 * Multi-signal paper quality scorer.
 *
 * Evaluates academic paper quality on a 0-100 scale using 6 signals:
 *   - referenceDepth (0-25)      — breadth of cited work
 *   - coauthorNetwork (0-20)     — author track record (avg paper count)
 *   - institutionalSignal (0-15) — proportion of affiliated authors
 *   - venueSignal (0-15)         — publication venue quality
 *   - citationSignal (0-15)      — raw citation impact
 *   - publicSphere (0-10)        — Grokipedia influence score
 *
 * Thresholds determine triage outcome:
 *   - below `qualityThreshold` → "reject"
 *   - between thresholds → "review" (human/LLM review needed)
 *   - at or above `autoIngestThreshold` → "auto" (auto-ingest)
 *
 * Each sub-scorer is a private pure method for testability.
 *
 * @module services/paperQualityScorer
 */

import type { S2Paper, S2Author } from "./semanticScholarClient.js";

// ============================================================
//  Types
// ============================================================

export interface QualityBreakdown {
  referenceDepth: number;
  coauthorNetwork: number;
  institutionalSignal: number;
  venueSignal: number;
  citationSignal: number;
  publicSphere: number;
}

export interface PaperQualityResult {
  total: number;
  breakdown: QualityBreakdown;
}

export type TriageOutcome = "reject" | "review" | "auto";

// ============================================================
//  PaperQualityScorer
// ============================================================

export class PaperQualityScorer {
  private readonly qualityThreshold: number;
  private readonly autoIngestThreshold: number;

  constructor(options?: { qualityThreshold?: number; autoIngestThreshold?: number }) {
    this.qualityThreshold = options?.qualityThreshold
      ?? (parseInt(process.env.ARXIV_QUALITY_THRESHOLD || "", 10) || 40);

    this.autoIngestThreshold = options?.autoIngestThreshold
      ?? (parseInt(process.env.ARXIV_AUTO_INGEST_THRESHOLD || "", 10) || 60);
  }

  // ------------------------------------------------------------------
  //  Public Methods
  // ------------------------------------------------------------------

  /**
   * Score a paper across all 6 quality dimensions.
   *
   * @param paper - Semantic Scholar paper data
   * @param grokipediaScore - Public sphere influence score (0-20)
   * @returns Total score (0-100) and per-dimension breakdown
   */
  scorePaper(paper: S2Paper, grokipediaScore: number): PaperQualityResult {
    const breakdown: QualityBreakdown = {
      referenceDepth: this.scoreReferenceDepth(paper.references),
      coauthorNetwork: this.scoreCoauthorNetwork(paper.authors),
      institutionalSignal: this.scoreInstitutionalSignal(paper.authors),
      venueSignal: this.scoreVenueSignal(paper.venue),
      citationSignal: this.scoreCitationSignal(paper.citationCount),
      publicSphere: this.scorePublicSphere(grokipediaScore),
    };

    const total = Math.round(
      breakdown.referenceDepth +
      breakdown.coauthorNetwork +
      breakdown.institutionalSignal +
      breakdown.venueSignal +
      breakdown.citationSignal +
      breakdown.publicSphere,
    );

    return { total: Math.min(total, 100), breakdown };
  }

  /**
   * Determine triage outcome based on score.
   *
   * @returns "reject" | "review" | "auto"
   */
  meetsThreshold(score: number): TriageOutcome {
    if (score >= this.autoIngestThreshold) return "auto";
    if (score >= this.qualityThreshold) return "review";
    return "reject";
  }

  // ------------------------------------------------------------------
  //  Sub-Scorers (private, pure methods)
  // ------------------------------------------------------------------

  /**
   * Reference depth: 0-25 points.
   * Linear scale: (referenceCount / 40) * 25, capped at 25.
   */
  private scoreReferenceDepth(references?: S2Paper["references"]): number {
    const count = references?.length ?? 0;
    return Math.min((count / 40) * 25, 25);
  }

  /**
   * Coauthor network: 0-20 points.
   * Based on average paper count across all authors.
   *
   * Scale:
   *   0-5 papers   → 0 pts
   *   5-20 papers  → 5 pts
   *   20-50 papers → 10 pts
   *   50-100 papers→ 15 pts
   *   100+ papers  → 20 pts
   */
  private scoreCoauthorNetwork(authors: S2Author[]): number {
    if (!authors || authors.length === 0) return 0;

    const totalPapers = authors.reduce((sum, a) => sum + (a.paperCount ?? 0), 0);
    const avgPapers = totalPapers / authors.length;

    if (avgPapers >= 100) return 20;
    if (avgPapers >= 50) return 15;
    if (avgPapers >= 20) return 10;
    if (avgPapers >= 5) return 5;
    return 0;
  }

  /**
   * Institutional signal: 0-15 points.
   * Proportion of authors with at least one affiliation.
   * (affiliatedAuthors / totalAuthors) * 15
   */
  private scoreInstitutionalSignal(authors: S2Author[]): number {
    if (!authors || authors.length === 0) return 0;

    const affiliated = authors.filter(
      (a) => a.affiliations && a.affiliations.length > 0,
    ).length;

    return (affiliated / authors.length) * 15;
  }

  /**
   * Venue signal: 0-15 points.
   * - Has venue AND not preprint-ish → 15
   * - Has venue but preprint/arxiv → 8
   * - No venue → 0
   */
  private scoreVenueSignal(venue?: string): number {
    if (!venue || venue.trim() === "") return 0;

    const venueLower = venue.toLowerCase();
    const isPreprintish =
      venueLower.includes("arxiv") ||
      venueLower.includes("preprint") ||
      venueLower.includes("pre-print") ||
      venueLower.includes("biorxiv") ||
      venueLower.includes("medrxiv") ||
      venueLower.includes("ssrn");

    return isPreprintish ? 8 : 15;
  }

  /**
   * Citation signal: 0-15 points.
   * Linear scale: (citationCount / 100) * 15, capped at 15.
   */
  private scoreCitationSignal(citationCount?: number): number {
    const count = citationCount ?? 0;
    return Math.min((count / 100) * 15, 15);
  }

  /**
   * Public sphere influence: 0-10 points.
   * Maps Grokipedia score (0-20) to 0-10 scale.
   */
  private scorePublicSphere(grokipediaScore: number): number {
    const clamped = Math.max(0, Math.min(20, grokipediaScore));
    return (clamped / 20) * 10;
  }
}
