import { describe, it, expect } from "vitest";
import { PaperQualityScorer } from "./paperQualityScorer.js";

// PaperQualityScorer is a pure computational service — no DB, no mocks needed.

const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;

function makePaper(overrides: Record<string, unknown> = {}) {
  return {
    paperId: "abc123",
    title: "Test Paper",
    authors: [],
    citationCount: 0,
    references: [],
    venue: "",
    year: CURRENT_YEAR,
    fieldsOfStudy: ["Computer Science"],
    externalIds: {},
    ...overrides,
  } as any;
}

// Helper: build an arXiv ID for N months ago
function arxivIdMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}${mm}.12345`;
}

// ---------------------------------------------------------------------------
//  scorePaper — authorEminence
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — authorEminence", () => {
  it("scores 0 with no authors", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ authors: [] }), 0);
    expect(result.breakdown.authorEminence).toBe(0);
  });

  it("scores 25 for 5000+ citation author", () => {
    const scorer = new PaperQualityScorer();
    const authors = [{ authorId: "a1", name: "A", citationCount: 5353, paperCount: 220 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(25);
  });

  it("scores 20 for 2000+ citation author", () => {
    const scorer = new PaperQualityScorer();
    const authors = [{ authorId: "a1", name: "A", citationCount: 2500 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(20);
  });

  it("scores 12 for 500+ citation author", () => {
    const scorer = new PaperQualityScorer();
    const authors = [{ authorId: "a1", name: "A", citationCount: 600 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(12);
  });

  it("uses capped paperCount floor for genuine S2 fragmentation", () => {
    const scorer = new PaperQualityScorer();
    // S2 says 8 citations but 30 papers — fragmented ID, real researcher
    // paperFloor = min(30*20=600, max(8*3=24, 8)) = min(600, 24) = 24
    // effective = max(8, 24) = 24 → 3 pts (10+ tier)
    // BUT with real fragmentation the citations would be split too,
    // so this correctly doesn't over-inflate
    const authors = [{ authorId: "a1", name: "A", citationCount: 8, paperCount: 30 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(3);
  });

  it("does not over-inflate prolific low-impact authors", () => {
    const scorer = new PaperQualityScorer();
    // 50 papers, 100 citations = 2 per paper. Without cap: 50*20=1000 → 16 pts (wrong!)
    // With cap: paperFloor = min(50*20=1000, max(100*3=300, 100)) = min(1000, 300) = 300
    // effective = max(100, 300) = 300 → 9 pts (200+ tier)
    const authors = [{ authorId: "a1", name: "A", citationCount: 100, paperCount: 50 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(9);
  });

  it("still helps genuine fragmentation (high citations, low papers on one ID)", () => {
    const scorer = new PaperQualityScorer();
    // Fragmented: one ID shows 10 papers, 500 citations. Real person has ~100 papers.
    // paperFloor = min(10*20=200, max(500*3=1500, 500)) = min(200, 1500) = 200
    // effective = max(500, 200) = 500 → 12 pts. Citations dominate, which is correct.
    const authors = [{ authorId: "a1", name: "A", citationCount: 500, paperCount: 10 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(12);
  });

  it("takes the max across all authors", () => {
    const scorer = new PaperQualityScorer();
    const authors = [
      { authorId: "a1", name: "Junior", citationCount: 5, paperCount: 2 },
      { authorId: "a2", name: "Senior", citationCount: 6000, paperCount: 300 },
    ];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.authorEminence).toBe(25);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — referenceDepth (field-aware)
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — referenceDepth", () => {
  it("scores 0 with no references", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper(), 0);
    expect(result.breakdown.referenceDepth).toBe(0);
  });

  it("scores CS papers against norm of 35 refs", () => {
    const scorer = new PaperQualityScorer();
    const refs = Array.from({ length: 17 }, () => ({ paperId: "ref" }));
    const result = scorer.scorePaper(makePaper({ references: refs }), 0);
    expect(result.breakdown.referenceDepth).toBeCloseTo(7.29, 1);
  });

  it("scores math papers against norm of 5 refs", () => {
    const scorer = new PaperQualityScorer();
    const refs = Array.from({ length: 4 }, () => ({ paperId: "ref" }));
    const result = scorer.scorePaper(makePaper({ references: refs, fieldsOfStudy: ["Mathematics"] }), 0);
    expect(result.breakdown.referenceDepth).toBe(12);
  });

  it("scores economics papers against norm of 25 refs", () => {
    const scorer = new PaperQualityScorer();
    const refs = Array.from({ length: 25 }, () => ({ paperId: "ref" }));
    const result = scorer.scorePaper(makePaper({ references: refs, fieldsOfStudy: ["Economics"] }), 0);
    expect(result.breakdown.referenceDepth).toBe(15);
  });

  it("scores biology papers against norm of 35 refs", () => {
    const scorer = new PaperQualityScorer();
    const refs = Array.from({ length: 35 }, () => ({ paperId: "ref" }));
    const result = scorer.scorePaper(makePaper({ references: refs, fieldsOfStudy: ["Biology"] }), 0);
    expect(result.breakdown.referenceDepth).toBe(15);
  });

  it("caps at 15 for many references", () => {
    const scorer = new PaperQualityScorer();
    const refs = Array.from({ length: 60 }, () => ({ paperId: "ref" }));
    const result = scorer.scorePaper(makePaper({ references: refs }), 0);
    expect(result.breakdown.referenceDepth).toBe(15);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — institutionalSignal
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — institutionalSignal", () => {
  it("scores 10 when all authors affiliated", () => {
    const scorer = new PaperQualityScorer();
    const authors = [
      { authorId: "a1", name: "A", affiliations: ["MIT"] },
      { authorId: "a2", name: "B", affiliations: ["Stanford"] },
    ];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.institutionalSignal).toBe(10);
  });

  it("scores proportionally for partial affiliation", () => {
    const scorer = new PaperQualityScorer();
    const authors = [
      { authorId: "a1", name: "A", affiliations: ["MIT"] },
      { authorId: "a2", name: "B", affiliations: [] },
    ];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.institutionalSignal).toBe(5);
  });

  it("falls back to citation count when no affiliations", () => {
    const scorer = new PaperQualityScorer();
    const authors = [
      { authorId: "a1", name: "A", affiliations: [], citationCount: 1500 },
    ];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.institutionalSignal).toBe(10);
  });

  it("gives partial fallback for moderate citation count", () => {
    const scorer = new PaperQualityScorer();
    const authors = [
      { authorId: "a1", name: "A", affiliations: [], citationCount: 150 },
    ];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.institutionalSignal).toBe(7);
  });

  it("scores 0 with no affiliations and low citations", () => {
    const scorer = new PaperQualityScorer();
    const authors = [
      { authorId: "a1", name: "A", affiliations: [], citationCount: 5 },
    ];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.institutionalSignal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — venueSignal (field-aware, expanded preprint fields)
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — venueSignal", () => {
  it("scores 10 for non-preprint venue", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "Nature" }), 0);
    expect(result.breakdown.venueSignal).toBe(10);
  });

  it("scores 8 for preprint in CS (preprint-heavy field)", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "ArXiv" }), 0);
    expect(result.breakdown.venueSignal).toBe(8);
  });

  it("scores 8 for bioRxiv in biology (now preprint-heavy)", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "bioRxiv", fieldsOfStudy: ["Biology"] }), 0);
    expect(result.breakdown.venueSignal).toBe(8);
  });

  it("scores 8 for medRxiv in medicine (now preprint-heavy)", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "medRxiv", fieldsOfStudy: ["Medicine"] }), 0);
    expect(result.breakdown.venueSignal).toBe(8);
  });

  it("scores 5 for no venue in preprint-heavy field (math)", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "", fieldsOfStudy: ["Mathematics"] }), 0);
    expect(result.breakdown.venueSignal).toBe(5);
  });

  it("scores 2 for no venue in non-preprint-heavy field", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "", fieldsOfStudy: ["Sociology"] }), 0);
    expect(result.breakdown.venueSignal).toBe(2);
  });

  it("scores 5 for preprint in non-preprint-heavy field", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "preprint", fieldsOfStudy: ["Sociology"] }), 0);
    expect(result.breakdown.venueSignal).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — citationVelocity
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — citationVelocity", () => {
  it("projects velocity for recent papers (< 1 year)", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 5, year: CURRENT_YEAR }), 0);
    // 5 * 3 = 15 projected velocity, (15/20)*10 = 7.5
    expect(result.breakdown.citationVelocity).toBeCloseTo(7.5, 1);
  });

  it("uses per-year velocity for older papers", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 40, year: CURRENT_YEAR - 2 }), 0);
    // 40/2 = 20 per year, (20/20)*10 = 10
    expect(result.breakdown.citationVelocity).toBe(10);
  });

  it("caps at 10", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 200, year: CURRENT_YEAR }), 0);
    expect(result.breakdown.citationVelocity).toBe(10);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — recencyBonus (month-level precision from arXiv ID)
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — recencyBonus", () => {
  it("gives 15 for paper published < 6 months ago (via arXiv ID)", () => {
    const scorer = new PaperQualityScorer();
    const recentId = arxivIdMonthsAgo(3);
    const result = scorer.scorePaper(makePaper({
      year: CURRENT_YEAR,
      externalIds: { ArXiv: recentId },
    }), 0);
    expect(result.breakdown.recencyBonus).toBe(15);
  });

  it("gives 13 for paper published 6-12 months ago (via arXiv ID)", () => {
    const scorer = new PaperQualityScorer();
    const id = arxivIdMonthsAgo(9);
    const result = scorer.scorePaper(makePaper({
      year: CURRENT_YEAR - 1,
      externalIds: { ArXiv: id },
    }), 0);
    expect(result.breakdown.recencyBonus).toBe(13);
  });

  it("gives 10 for paper published 1-2 years ago (via arXiv ID)", () => {
    const scorer = new PaperQualityScorer();
    const id = arxivIdMonthsAgo(18);
    const result = scorer.scorePaper(makePaper({
      year: CURRENT_YEAR - 1,
      externalIds: { ArXiv: id },
    }), 0);
    expect(result.breakdown.recencyBonus).toBe(10);
  });

  it("gives 0 for paper published 3+ years ago", () => {
    const scorer = new PaperQualityScorer();
    const id = arxivIdMonthsAgo(40);
    const result = scorer.scorePaper(makePaper({
      year: CURRENT_YEAR - 4,
      externalIds: { ArXiv: id },
    }), 0);
    expect(result.breakdown.recencyBonus).toBe(0);
  });

  it("falls back to year-only when no arXiv ID", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ year: CURRENT_YEAR }), 0);
    expect(result.breakdown.recencyBonus).toBe(15);
  });

  it("falls back to year-only: last year = 12", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ year: CURRENT_YEAR - 1 }), 0);
    expect(result.breakdown.recencyBonus).toBe(12);
  });

  it("gives 7 for unknown year", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ year: undefined }), 0);
    expect(result.breakdown.recencyBonus).toBe(7);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — classicImpact + temporalSignal
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — classicImpact", () => {
  it("scores 15 for 500+ citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 720, year: 2010 }), 0);
    expect(result.breakdown.classicImpact).toBe(15);
  });

  it("scores 12 for 200+ citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 210, year: 2015 }), 0);
    expect(result.breakdown.classicImpact).toBe(12);
  });

  it("scores 9 for 100+ citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 128, year: 2010 }), 0);
    expect(result.breakdown.classicImpact).toBe(9);
  });

  it("scores 6 for 50+ citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 52, year: 2017 }), 0);
    expect(result.breakdown.classicImpact).toBe(6);
  });

  it("scores 3 for 20+ citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 26, year: 2020 }), 0);
    expect(result.breakdown.classicImpact).toBe(3);
  });

  it("scores 0 for fewer than 20 citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 5, year: 2020 }), 0);
    expect(result.breakdown.classicImpact).toBe(0);
  });
});

describe("PaperQualityScorer — temporalSignal (max of recency and classic)", () => {
  it("uses recencyBonus for new paper with few citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 2, year: CURRENT_YEAR }), 0);
    // recencyBonus = 15 (current year), classicImpact = 0 (2 cites) → temporal = 15
    expect(result.breakdown.temporalSignal).toBe(15);
    expect(result.breakdown.recencyBonus).toBe(15);
    expect(result.breakdown.classicImpact).toBe(0);
  });

  it("uses classicImpact for old paper with many citations", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 720, year: 2010 }), 0);
    // recencyBonus = 0 (2010), classicImpact = 15 (720 cites) → temporal = 15
    expect(result.breakdown.temporalSignal).toBe(15);
    expect(result.breakdown.recencyBonus).toBe(0);
    expect(result.breakdown.classicImpact).toBe(15);
  });

  it("uses classicImpact when it exceeds recencyBonus", () => {
    const scorer = new PaperQualityScorer();
    // 3-year-old paper: recency = 5, but 200+ citations: classic = 12 → temporal = 12
    const id = arxivIdMonthsAgo(30);
    const result = scorer.scorePaper(makePaper({
      citationCount: 250,
      year: CURRENT_YEAR - 2,
      externalIds: { ArXiv: id },
    }), 0);
    expect(result.breakdown.temporalSignal).toBe(Math.max(
      result.breakdown.recencyBonus,
      result.breakdown.classicImpact,
    ));
    expect(result.breakdown.classicImpact).toBe(12);
  });

  it("old paper with 0 citations gets temporalSignal = 0", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 0, year: 2015 }), 0);
    expect(result.breakdown.temporalSignal).toBe(0);
    expect(result.breakdown.recencyBonus).toBe(0);
    expect(result.breakdown.classicImpact).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — curatedBoost
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — curatedBoost", () => {
  it("gives 15 pts for admin-curated papers", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper(), 0, "admin");
    expect(result.breakdown.curatedBoost).toBe(15);
  });

  it("gives 8 pts for agent-submitted papers", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper(), 0, "agent");
    expect(result.breakdown.curatedBoost).toBe(8);
  });

  it("gives 0 pts for auto-ingested papers", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper(), 0, "auto_ingest");
    expect(result.breakdown.curatedBoost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — admin curation floor
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — admin curation floor", () => {
  it("enforces floor of 81 for admin-curated papers", () => {
    const scorer = new PaperQualityScorer();
    // Minimal paper that would score low without floor
    const paper = makePaper({
      authors: [{ authorId: "a1", name: "Unknown", citationCount: 5, paperCount: 1 }],
      references: [],
      venue: "",
      citationCount: 0,
      year: CURRENT_YEAR - 5,
      fieldsOfStudy: ["Other"],
    });
    const result = scorer.scorePaper(paper, 0, "admin");
    expect(result.total).toBeGreaterThanOrEqual(81);
  });

  it("does not apply floor for auto-ingested papers", () => {
    const scorer = new PaperQualityScorer();
    const paper = makePaper({
      authors: [{ authorId: "a1", name: "Unknown", citationCount: 5, paperCount: 1 }],
      references: [],
      venue: "",
      citationCount: 0,
      year: CURRENT_YEAR - 5,
      fieldsOfStudy: ["Other"],
    });
    const result = scorer.scorePaper(paper, 0, "auto_ingest");
    expect(result.total).toBeLessThan(81);
  });

  it("does not apply floor for agent-submitted papers", () => {
    const scorer = new PaperQualityScorer();
    const paper = makePaper({
      authors: [{ authorId: "a1", name: "Unknown", citationCount: 5, paperCount: 1 }],
      references: [],
      venue: "",
      citationCount: 0,
      year: CURRENT_YEAR - 5,
      fieldsOfStudy: ["Other"],
    });
    const result = scorer.scorePaper(paper, 0, "agent");
    expect(result.total).toBeLessThan(81);
  });

  it("allows score above floor for admin papers", () => {
    const scorer = new PaperQualityScorer();
    const paper = makePaper({
      authors: [{ authorId: "a", name: "A", paperCount: 300, affiliations: ["MIT"], citationCount: 10000 }],
      references: Array.from({ length: 50 }, () => ({ paperId: "r" })),
      venue: "Nature",
      citationCount: 500,
      year: CURRENT_YEAR,
    });
    const result = scorer.scorePaper(paper, 0, "admin");
    expect(result.total).toBeGreaterThan(70);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — total
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — total score", () => {
  it("caps total at 100", () => {
    const scorer = new PaperQualityScorer();
    const paper = makePaper({
      references: Array.from({ length: 100 }, () => ({ paperId: "r" })),
      authors: [{ authorId: "a", name: "A", paperCount: 300, affiliations: ["MIT"], citationCount: 10000 }],
      venue: "Nature",
      citationCount: 500,
      year: CURRENT_YEAR,
    });

    const result = scorer.scorePaper(paper, 0, "admin");
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it("scores a top admin-curated paper by eminent author above 80", () => {
    const scorer = new PaperQualityScorer();
    const paper = makePaper({
      references: Array.from({ length: 29 }, () => ({ paperId: "r" })),
      authors: [
        { authorId: "a1", name: "Famous Prof", citationCount: 5353, paperCount: 220 },
        { authorId: "a2", name: "Junior", citationCount: 24, paperCount: 14 },
      ],
      venue: "ArXiv",
      citationCount: 1,
      year: CURRENT_YEAR - 1,
      fieldsOfStudy: ["Computer Science"],
    });

    const result = scorer.scorePaper(paper, 0, "admin");
    expect(result.total).toBeGreaterThanOrEqual(80);
  });

  it("scores an unknown auto-ingested paper low", () => {
    const scorer = new PaperQualityScorer();
    const paper = makePaper({
      references: Array.from({ length: 5 }, () => ({ paperId: "r" })),
      authors: [{ authorId: "a1", name: "Nobody", citationCount: 3, paperCount: 1 }],
      venue: "",
      citationCount: 0,
      year: CURRENT_YEAR - 5,
      fieldsOfStudy: ["Computer Science"],
    });

    const result = scorer.scorePaper(paper, 0);
    expect(result.total).toBeLessThan(35);
  });
});

// ---------------------------------------------------------------------------
//  scorePaper — legacy backward compatibility
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — legacy fields", () => {
  it("maps authorEminence → coauthorNetwork", () => {
    const scorer = new PaperQualityScorer();
    const authors = [{ authorId: "a1", name: "A", citationCount: 5000 }];
    const result = scorer.scorePaper(makePaper({ authors }), 0);
    expect(result.breakdown.coauthorNetwork).toBe(result.breakdown.authorEminence);
  });

  it("maps citationVelocity → citationSignal", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ citationCount: 10 }), 0);
    expect(result.breakdown.citationSignal).toBe(result.breakdown.citationVelocity);
  });

  it("maps temporalSignal + curatedBoost → publicSphere", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper(), 0, "admin");
    expect(result.breakdown.publicSphere).toBe(
      result.breakdown.temporalSignal + result.breakdown.curatedBoost,
    );
  });
});

// ---------------------------------------------------------------------------
//  meetsThreshold
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — meetsThreshold", () => {
  it("returns 'reject' below quality threshold", () => {
    const scorer = new PaperQualityScorer({ qualityThreshold: 35, autoIngestThreshold: 55 });
    expect(scorer.meetsThreshold(30)).toBe("reject");
  });

  it("returns 'review' between thresholds", () => {
    const scorer = new PaperQualityScorer({ qualityThreshold: 35, autoIngestThreshold: 55 });
    expect(scorer.meetsThreshold(45)).toBe("review");
  });

  it("returns 'auto' at or above auto-ingest threshold", () => {
    const scorer = new PaperQualityScorer({ qualityThreshold: 35, autoIngestThreshold: 55 });
    expect(scorer.meetsThreshold(55)).toBe("auto");
    expect(scorer.meetsThreshold(80)).toBe("auto");
  });

  it("uses default thresholds (35/55) from constructor", () => {
    const scorer = new PaperQualityScorer();
    expect(scorer.meetsThreshold(34)).toBe("reject");
    expect(scorer.meetsThreshold(35)).toBe("review");
    expect(scorer.meetsThreshold(55)).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
//  Field detection — expanded fields
// ---------------------------------------------------------------------------

describe("PaperQualityScorer — field detection", () => {
  it("detects biology from fieldsOfStudy", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "bioRxiv", fieldsOfStudy: ["Biology"] }), 0);
    // Biology is now preprint-heavy, bioRxiv → 8
    expect(result.breakdown.venueSignal).toBe(8);
  });

  it("detects medicine from fieldsOfStudy", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "medRxiv", fieldsOfStudy: ["Medicine"] }), 0);
    expect(result.breakdown.venueSignal).toBe(8);
  });

  it("detects finance as economics", () => {
    const scorer = new PaperQualityScorer();
    const refs = Array.from({ length: 25 }, () => ({ paperId: "ref" }));
    const result = scorer.scorePaper(makePaper({ references: refs, fieldsOfStudy: ["Quantitative Finance"] }), 0);
    // Economics norm = 25, so 25/25*15 = 15
    expect(result.breakdown.referenceDepth).toBe(15);
  });

  it("detects neuroscience as biology", () => {
    const scorer = new PaperQualityScorer();
    const result = scorer.scorePaper(makePaper({ venue: "", fieldsOfStudy: ["Neuroscience"] }), 0);
    // Biology is preprint-heavy → no venue = 5
    expect(result.breakdown.venueSignal).toBe(5);
  });
});
