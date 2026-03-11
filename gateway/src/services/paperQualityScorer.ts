/**
 * Multi-signal paper quality scorer (v3.2).
 *
 * Evaluates academic paper quality on a 0-100 scale using 8 signals:
 *   - authorEminence (0-25)        — strongest signal: top author's citation impact
 *   - referenceDepth (0-15)        — breadth of cited work, field-aware
 *   - institutionalSignal (0-10)   — affiliation or citation-count fallback
 *   - venueSignal (0-10)           — publication venue, field-aware (preprints not penalized)
 *   - citationVelocity (0-10)      — citation impact normalized by paper age
 *   - temporalSignal (0-15)        — max(recencyBonus, classicImpact): rewards EITHER newness OR proven impact
 *   - curatedBoost (0-15)          — bonus for editorially curated papers
 *
 * The temporal slot uses max(recencyBonus, classicImpact) so papers are never
 * penalized for being old if they've accumulated significant citations.
 *
 * Admin-curated papers have a score floor of 81.
 *
 * Thresholds determine triage outcome:
 *   - below `qualityThreshold` → "reject"
 *   - between thresholds → "review" (human/LLM review needed)
 *   - at or above `autoIngestThreshold` → "auto" (auto-ingest)
 *
 * @module services/paperQualityScorer
 */

import type { S2Paper, S2Author } from "./semanticScholarClient.js";

// ============================================================
//  Types
// ============================================================

export interface QualityBreakdown {
  /** Author eminence score (v3). */
  authorEminence: number;
  referenceDepth: number;
  institutionalSignal: number;
  venueSignal: number;
  citationVelocity: number;
  recencyBonus: number;
  /** Classic impact: raw citation count bonus for proven papers. */
  classicImpact: number;
  /** Temporal signal used in total: max(recencyBonus, classicImpact). */
  temporalSignal: number;
  curatedBoost: number;
  /** Legacy: mapped from authorEminence for backward compat with stored breakdowns. */
  coauthorNetwork: number;
  /** Legacy: mapped from citationVelocity. */
  citationSignal: number;
  /** Legacy: mapped from temporalSignal + curatedBoost. */
  publicSphere: number;
}

export interface PaperQualityResult {
  total: number;
  breakdown: QualityBreakdown;
}

export type TriageOutcome = "reject" | "review" | "auto";

/** Submission context for scoring curated papers differently. */
export type SubmissionType = "auto_ingest" | "admin" | "agent";

// ============================================================
//  Field detection
// ============================================================

type FieldCategory = "cs" | "math" | "physics" | "economics" | "biology" | "medicine" | "other";

function detectField(fieldsOfStudy?: string[], categories?: string[]): FieldCategory {
  const all = [
    ...(fieldsOfStudy ?? []),
    ...(categories ?? []),
  ].map(f => f.toLowerCase());

  if (all.some(f => f.includes("mathematic") || f === "math")) return "math";
  if (all.some(f => f.includes("physics"))) return "physics";
  if (all.some(f => f.includes("economic") || f.includes("finance"))) return "economics";
  if (all.some(f => f.includes("biology") || f.includes("biochem") || f.includes("neuroscience"))) return "biology";
  if (all.some(f => f.includes("medicine") || f.includes("clinical") || f.includes("epidemiology"))) return "medicine";
  if (all.some(f =>
    f.includes("computer") || f.includes("cs.") ||
    f.includes("artificial") || f.includes("machine learning")
  )) return "cs";
  return "other";
}

/** Expected reference count norms by field. */
const REFERENCE_NORMS: Record<FieldCategory, number> = {
  cs: 35,
  math: 5,
  physics: 30,
  economics: 25,
  biology: 35,
  medicine: 35,
  other: 25,
};

/** Fields where preprints (arXiv, bioRxiv, SSRN, medRxiv) are standard. */
const PREPRINT_HEAVY_FIELDS = new Set<FieldCategory>(["cs", "math", "physics", "economics", "biology", "medicine"]);

/** Admin-curated papers never score below this floor. */
const ADMIN_CURATED_FLOOR = 81;

// ============================================================
//  arXiv ID month extraction
// ============================================================

/**
 * Extract publication month from an arXiv ID.
 * Format: YYMM.NNNNN (e.g. 2503.07558 → March 2025).
 * Returns fractional year age for more precise recency scoring.
 */
function ageFromArxivId(arxivId: string | undefined, currentYear: number, currentMonth: number): number | null {
  if (!arxivId) return null;
  const match = arxivId.match(/^(\d{2})(\d{2})\./);
  if (!match) return null;
  const pubYear = 2000 + parseInt(match[1], 10);
  const pubMonth = parseInt(match[2], 10);
  if (pubMonth < 1 || pubMonth > 12) return null;
  return (currentYear - pubYear) + (currentMonth - pubMonth) / 12;
}

// ============================================================
//  PaperQualityScorer
// ============================================================

export class PaperQualityScorer {
  private readonly qualityThreshold: number;
  private readonly autoIngestThreshold: number;

  constructor(options?: { qualityThreshold?: number; autoIngestThreshold?: number }) {
    this.qualityThreshold = options?.qualityThreshold
      ?? (parseInt(process.env.ARXIV_QUALITY_THRESHOLD || "", 10) || 35);

    this.autoIngestThreshold = options?.autoIngestThreshold
      ?? (parseInt(process.env.ARXIV_AUTO_INGEST_THRESHOLD || "", 10) || 55);
  }

  // ------------------------------------------------------------------
  //  Public Methods
  // ------------------------------------------------------------------

  /**
   * Score a paper across all quality dimensions.
   *
   * @param paper - Semantic Scholar paper data
   * @param grokipediaScore - Legacy param, ignored in v3
   * @param submissionType - How the paper was submitted (affects curator boost + floor)
   * @returns Total score (0-100) and per-dimension breakdown
   */
  scorePaper(
    paper: S2Paper,
    grokipediaScore: number,
    submissionType: SubmissionType = "auto_ingest",
  ): PaperQualityResult {
    const field = detectField(paper.fieldsOfStudy);
    const arxivId = paper.externalIds?.ArXiv;

    const authorEminence = this.scoreAuthorEminence(paper.authors);
    const referenceDepth = this.scoreReferenceDepth(paper.references, field);
    const institutionalSignal = this.scoreInstitutionalSignal(paper.authors);
    const venueSignal = this.scoreVenueSignal(paper.venue, field);
    const citationVelocity = this.scoreCitationVelocity(paper.citationCount, paper.year);
    const recencyBonus = this.scoreRecencyBonus(paper.year, arxivId);
    const classicImpact = this.scoreClassicImpact(paper.citationCount);
    const temporalSignal = Math.max(recencyBonus, classicImpact);
    const curatedBoost = this.scoreCuratedBoost(submissionType);

    const breakdown: QualityBreakdown = {
      authorEminence,
      referenceDepth,
      institutionalSignal,
      venueSignal,
      citationVelocity,
      recencyBonus,
      classicImpact,
      temporalSignal,
      curatedBoost,
      // Legacy fields for backward compatibility with stored breakdowns
      coauthorNetwork: authorEminence,
      citationSignal: citationVelocity,
      publicSphere: temporalSignal + curatedBoost,
    };

    let total = Math.round(
      authorEminence +
      referenceDepth +
      institutionalSignal +
      venueSignal +
      citationVelocity +
      temporalSignal +
      curatedBoost,
    );

    // Admin-curated floor: editorial judgment guarantees a minimum score
    if (submissionType === "admin") {
      total = Math.max(total, ADMIN_CURATED_FLOOR);
    }

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
   * Author eminence: 0-25 points.
   * The strongest single quality signal. Uses the best author's citation
   * count, with a paperCount-based floor for S2 fragmentation — capped
   * at citationCount * 3 to prevent prolific-but-low-impact inflation.
   *
   *   5000+ effective → 25
   *   2000+ → 20
   *   1000+ → 16
   *   500+  → 12
   *   200+  → 9
   *   50+   → 6
   *   10+   → 3
   *   else  → 0
   */
  private scoreAuthorEminence(authors: S2Author[]): number {
    if (!authors || authors.length === 0) return 0;

    const maxCitations = Math.max(...authors.map(a => a.citationCount ?? 0));
    const maxPapers = Math.max(...authors.map(a => a.paperCount ?? 0));
    // paperCount * 20 compensates for S2 fragmented author IDs,
    // but cap at citationCount * 3 to prevent inflating prolific low-impact authors
    const paperFloor = Math.min(maxPapers * 20, Math.max(maxCitations * 3, maxCitations));
    const effective = Math.max(maxCitations, paperFloor);

    if (effective >= 5000) return 25;
    if (effective >= 2000) return 20;
    if (effective >= 1000) return 16;
    if (effective >= 500) return 12;
    if (effective >= 200) return 9;
    if (effective >= 50) return 6;
    if (effective >= 10) return 3;
    return 0;
  }

  /**
   * Reference depth: 0-15 points.
   * Field-aware normalization — math papers need far fewer references than CS.
   */
  private scoreReferenceDepth(references?: S2Paper["references"], field: FieldCategory = "cs"): number {
    const count = references?.length ?? 0;
    const norm = REFERENCE_NORMS[field];
    return Math.min((count / norm) * 15, 15);
  }

  /**
   * Institutional signal: 0-10 points.
   *
   * Primary: proportion of authors with affiliations.
   * Fallback: when S2 returns no affiliations (common due to data gaps),
   * use author citation count as a proxy.
   */
  private scoreInstitutionalSignal(authors: S2Author[]): number {
    if (!authors || authors.length === 0) return 0;

    const affiliated = authors.filter(
      (a) => a.affiliations && a.affiliations.length > 0,
    ).length;

    if (affiliated > 0) {
      return (affiliated / authors.length) * 10;
    }

    // Fallback: use citation count as institutional proxy
    const maxCitations = Math.max(...authors.map(a => a.citationCount ?? 0));
    if (maxCitations >= 1000) return 10;
    if (maxCitations >= 100) return 7;
    if (maxCitations >= 20) return 3;
    return 0;
  }

  /**
   * Venue signal: 0-10 points.
   * Field-aware — preprints are standard in CS/math/physics/economics/biology/medicine
   * and shouldn't be penalized as heavily.
   *
   *   Non-preprint venue → 10
   *   Preprint in preprint-heavy field → 8
   *   No venue in preprint-heavy field OR preprint in other field → 5
   *   No venue in other field → 2
   */
  private scoreVenueSignal(venue?: string, field: FieldCategory = "other"): number {
    const isPreprintHeavy = PREPRINT_HEAVY_FIELDS.has(field);

    if (!venue || venue.trim() === "") {
      return isPreprintHeavy ? 5 : 2;
    }

    const venueLower = venue.toLowerCase();
    const isPreprintish =
      venueLower.includes("arxiv") ||
      venueLower.includes("preprint") ||
      venueLower.includes("pre-print") ||
      venueLower.includes("biorxiv") ||
      venueLower.includes("medrxiv") ||
      venueLower.includes("ssrn");

    if (!isPreprintish) return 10;
    return isPreprintHeavy ? 8 : 5;
  }

  /**
   * Citation velocity: 0-10 points.
   * Uses citations per year instead of raw count so recent papers
   * aren't penalized for not having had time to accumulate citations.
   *
   * Papers less than 1 year old get their raw citations multiplied by 3
   * to project annual velocity.
   */
  private scoreCitationVelocity(citationCount?: number, year?: number): number {
    const citations = citationCount ?? 0;
    const currentYear = new Date().getFullYear();
    const pubYear = year ?? currentYear;
    const age = Math.max(0.5, currentYear - pubYear);

    let velocity: number;
    if (age <= 1) {
      velocity = citations * 3;
    } else {
      velocity = citations / age;
    }

    return Math.min((velocity / 20) * 10, 10);
  }

  /**
   * Recency bonus: 0-15 points.
   * Uses month-level precision from arXiv ID when available (YYMM.NNNNN),
   * falls back to year-only from S2.
   *
   *   < 6 months  → 15
   *   6-12 months → 13
   *   1-2 years   → 10
   *   2-3 years   → 5
   *   3+ years    → 0
   */
  private scoreRecencyBonus(year?: number, arxivId?: string): number {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-based

    // Try month-level precision from arXiv ID
    const preciseAge = ageFromArxivId(arxivId, currentYear, currentMonth);
    if (preciseAge !== null) {
      if (preciseAge <= 0.5) return 15;  // < 6 months
      if (preciseAge <= 1) return 13;    // 6-12 months
      if (preciseAge <= 2) return 10;    // 1-2 years
      if (preciseAge <= 3) return 5;     // 2-3 years
      return 0;
    }

    // Fallback: year-only from S2
    if (!year) return 7; // Unknown year, give partial credit
    const age = currentYear - year;
    if (age <= 0) return 15;
    if (age <= 1) return 12;
    if (age <= 2) return 5;
    return 0;
  }

  /**
   * Classic impact: 0-15 points.
   * Rewards papers that have accumulated significant citations over time.
   * Used via max(recencyBonus, classicImpact) so old papers with proven
   * impact aren't penalized for not being new.
   *
   *   500+ citations → 15
   *   200+ → 12
   *   100+ → 9
   *   50+  → 6
   *   20+  → 3
   *   else → 0
   */
  private scoreClassicImpact(citationCount?: number): number {
    const citations = citationCount ?? 0;
    if (citations >= 500) return 15;
    if (citations >= 200) return 12;
    if (citations >= 100) return 9;
    if (citations >= 50) return 6;
    if (citations >= 20) return 3;
    return 0;
  }

  /**
   * Curator confidence boost: 0-15 points.
   * Papers manually ingested by admins or submitted by agents get a
   * boost because an editorial decision has already been made.
   *
   *   admin (curated) → 15
   *   agent (submitted) → 8
   *   auto_ingest → 0
   */
  private scoreCuratedBoost(submissionType: SubmissionType): number {
    if (submissionType === "admin") return 15;
    if (submissionType === "agent") return 8;
    return 0;
  }
}
