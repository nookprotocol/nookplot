import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockPool } from "../../test/helpers.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const { ResourceEnricher, pipelineTagToFaculty } = await import("../resourceEnricher.js");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createEnricher(pool?: ReturnType<typeof createMockPool>) {
  const p = pool ?? createMockPool();
  const enricher = new ResourceEnricher(p as any, 60_000); // 1 min tick for tests
  return { enricher, pool: p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  XML extraction (lightweight arXiv parser)
// ---------------------------------------------------------------------------

describe("ResourceEnricher — XML extraction", () => {
  it("extracts tag content from XML string", () => {
    const { enricher } = createEnricher();

    const xml = `<entry><title>Attention Is All You Need</title><summary>A paper about transformers.</summary></entry>`;

    const title = (enricher as any).extractXml(xml, "title");
    const summary = (enricher as any).extractXml(xml, "summary");

    expect(title).toBe("Attention Is All You Need");
    expect(summary).toBe("A paper about transformers.");
  });

  it("returns null for missing tags", () => {
    const { enricher } = createEnricher();

    const xml = `<entry><title>Test</title></entry>`;

    const missing = (enricher as any).extractXml(xml, "author");
    expect(missing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  tick — batch processing
// ---------------------------------------------------------------------------

describe("ResourceEnricher.tick", () => {
  it("returns 0 when no pending resources exist", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    // UPDATE...RETURNING returns no rows
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const count = await enricher.tick();
    expect(count).toBe(0);
  });

  it("claims pending resources by marking as enriching", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    // Claim batch — no pending resources
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await enricher.tick();

    // Verify the UPDATE query was called with enrichment_status = 'enriching'
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain("enrichment_status = 'enriching'");
    expect(call[0]).toContain("enrichment_status = 'pending'");
  });
});

// ---------------------------------------------------------------------------
//  markFailed — retry logic
// ---------------------------------------------------------------------------

describe("ResourceEnricher — markFailed", () => {
  it("resets to pending if under max retries", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    // Retry count query
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "1" }], rowCount: 1 });
    // UPDATE to reset to pending
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Log insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (enricher as any).markFailed("resource-1", new Error("timeout"));

    // Should update to 'pending' (not 'failed')
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toContain("enrichment_status = 'pending'");
  });

  it("marks as permanently failed after max retries", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    // Retry count = 3 (at max)
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "3" }], rowCount: 1 });
    // UPDATE to mark failed
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Log insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (enricher as any).markFailed("resource-1", new Error("permanent failure"));

    // Should update to 'failed'
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toContain("enrichment_status = 'failed'");
  });
});

// ---------------------------------------------------------------------------
//  applyEnrichment — DB updates
// ---------------------------------------------------------------------------

describe("ResourceEnricher — applyEnrichment", () => {
  it("builds dynamic UPDATE with enriched fields", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (enricher as any).applyEnrichment("resource-1", {
      title: "New Title",
      description: "A description",
      tags: ["ml", "transformers"],
      githubStars: 1500,
    });

    const [query, params] = pool.query.mock.calls[0];
    expect(query).toContain("title = $");
    expect(query).toContain("description = $");
    expect(query).toContain("tags = $");
    expect(query).toContain("github_stars = $");
    expect(query).toContain("enrichment_status = 'complete'");
    expect(params).toContain("New Title");
    expect(params).toContain("A description");
    expect(params).toContain(1500);
    expect(params).toContain("resource-1");
  });

  it("handles enrichment with only title", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (enricher as any).applyEnrichment("resource-2", {
      title: "Minimal Enrichment",
    });

    const [query, params] = pool.query.mock.calls[0];
    expect(query).toContain("title = $");
    expect(query).toContain("enrichment_status = 'complete'");
    expect(params[0]).toBe("Minimal Enrichment");
  });
});

// ---------------------------------------------------------------------------
//  applyEnrichment — model registry fields
// ---------------------------------------------------------------------------

describe("ResourceEnricher — applyEnrichment with model registry fields", () => {
  it("includes faculty, hfDownloads, hfLikes, benchmarkScores, libraryName", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await (enricher as any).applyEnrichment("resource-hf", {
      title: "meta-llama/Llama-3.3-70B",
      faculty: ["language", "generation"],
      hfDownloads: 500000,
      hfLikes: 1200,
      benchmarkScores: { mmlu: 82.3, hellaswag: 87.1 },
      libraryName: "transformers",
      registryMetadata: { pipeline_tag: "text-generation" },
    });

    const [query, params] = pool.query.mock.calls[0];
    expect(query).toContain("faculty = $");
    expect(query).toContain("hf_downloads = $");
    expect(query).toContain("hf_likes = $");
    expect(query).toContain("benchmark_scores = $");
    expect(query).toContain("library_name = $");
    expect(query).toContain("registry_metadata = $");
    expect(params).toContain(500000);
    expect(params).toContain(1200);
    expect(params).toContain("transformers");
  });
});

// ---------------------------------------------------------------------------
//  pipelineTagToFaculty mapping
// ---------------------------------------------------------------------------

describe("pipelineTagToFaculty", () => {
  it("maps text-generation to language + generation", () => {
    expect(pipelineTagToFaculty("text-generation")).toEqual(["language", "generation"]);
  });

  it("maps image-classification to vision + analysis", () => {
    expect(pipelineTagToFaculty("image-classification")).toEqual(["vision", "analysis"]);
  });

  it("maps automatic-speech-recognition to audio + recognition", () => {
    expect(pipelineTagToFaculty("automatic-speech-recognition")).toEqual(["audio", "recognition"]);
  });

  it("maps feature-extraction to embeddings", () => {
    expect(pipelineTagToFaculty("feature-extraction")).toEqual(["embeddings"]);
  });

  it("returns tag as-is for unknown pipeline_tag", () => {
    expect(pipelineTagToFaculty("custom-pipeline")).toEqual(["custom-pipeline"]);
  });

  it("returns empty array for undefined", () => {
    expect(pipelineTagToFaculty(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  enrichResource dispatch — model registries
// ---------------------------------------------------------------------------

describe("ResourceEnricher — enrichResource dispatch", () => {
  it("dispatches huggingface_model to enrichFromHuggingFace", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    // Mock enrichFromHuggingFace
    const mockResult = { title: "test-model", faculty: ["language", "generation"], hfDownloads: 100 };
    (enricher as any).enrichFromHuggingFace = vi.fn().mockResolvedValue(mockResult);

    // Mock the log insert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await (enricher as any).enrichResource({
      id: "res-1",
      source_type: "huggingface_model",
      external_id: "hf:meta-llama/Llama-3.3-70B",
      arxiv_id: null,
      doi: null,
      github_owner: null,
      github_repo: null,
    });

    expect((enricher as any).enrichFromHuggingFace).toHaveBeenCalledWith("meta-llama/Llama-3.3-70B", "model");
    expect(result).toEqual(mockResult);
  });

  it("dispatches replicate_model to enrichFromReplicate", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    const mockResult = { title: "stability-ai/sdxl", faculty: ["vision", "generation"] };
    (enricher as any).enrichFromReplicate = vi.fn().mockResolvedValue(mockResult);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await (enricher as any).enrichResource({
      id: "res-2",
      source_type: "replicate_model",
      external_id: "replicate:stability-ai/sdxl",
      arxiv_id: null,
      doi: null,
      github_owner: null,
      github_repo: null,
    });

    expect((enricher as any).enrichFromReplicate).toHaveBeenCalledWith("stability-ai/sdxl");
    expect(result).toEqual(mockResult);
  });

  it("dispatches pypi_package to enrichFromPyPI", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);

    const mockResult = { title: "transformers", libraryName: "python" };
    (enricher as any).enrichFromPyPI = vi.fn().mockResolvedValue(mockResult);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await (enricher as any).enrichResource({
      id: "res-3",
      source_type: "pypi_package",
      external_id: "pypi:transformers",
      arxiv_id: null,
      doi: null,
      github_owner: null,
      github_repo: null,
    });

    expect((enricher as any).enrichFromPyPI).toHaveBeenCalledWith("transformers");
    expect(result).toEqual(mockResult);
  });

  it("handles ollama_model with stub enrichment", async () => {
    const pool = createMockPool();
    const { enricher } = createEnricher(pool);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await (enricher as any).enrichResource({
      id: "res-4",
      source_type: "ollama_model",
      external_id: "ollama:llama3.3",
      arxiv_id: null,
      doi: null,
      github_owner: null,
      github_repo: null,
    });

    expect(result).toBeTruthy();
    expect(result.title).toBe("llama3.3");
    expect(result.faculty).toEqual(["language", "generation"]);
  });
});

// ---------------------------------------------------------------------------
//  start/stop lifecycle
// ---------------------------------------------------------------------------

describe("ResourceEnricher — lifecycle", () => {
  it("starts and stops without error", () => {
    const { enricher } = createEnricher();

    enricher.start();
    enricher.start(); // idempotent

    enricher.stop();
    enricher.stop(); // idempotent
  });
});
