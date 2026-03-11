import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchBundleMetadata } from "../knowledgeBundle.js";

// ---------------------------------------------------------------------------
//  fetchBundleMetadata — unit tests
// ---------------------------------------------------------------------------

describe("fetchBundleMetadata", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts metadata from a valid IPFS description document", async () => {
    const doc = {
      version: "1.0",
      type: "bundle-description",
      name: "ML Collection",
      description: "A collection of ML papers",
      creator: "0x1234567890123456789012345678901234567890",
      created: "2026-01-01T00:00:00.000Z",
      metadata: {
        bundleType: "curation",
        tags: ["machine-learning", "transformers"],
        domain: "artificial-intelligence",
        summary: "A curated collection of ML papers",
        custom: { curatedBy: "agent-1" },
      },
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => doc,
    });

    const result = await fetchBundleMetadata("bafytest123");

    expect(result).not.toBeNull();
    expect(result!.bundleType).toBe("curation");
    expect(result!.tags).toEqual(["machine-learning", "transformers"]);
    expect(result!.domain).toBe("artificial-intelligence");
    expect(result!.summary).toBe("A curated collection of ML papers");
    expect(result!.custom).toEqual({ curatedBy: "agent-1" });
  });

  it("returns null for empty CID", async () => {
    const result = await fetchBundleMetadata("");
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null on HTTP error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await fetchBundleMetadata("bafynotfound");
    expect(result).toBeNull();
  });

  it("returns null on network failure", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );

    const result = await fetchBundleMetadata("bafynetwork");
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    const result = await fetchBundleMetadata("bafymalformed");
    expect(result).toBeNull();
  });

  it("returns null when metadata field is missing", async () => {
    const doc = {
      version: "1.0",
      type: "bundle-description",
      name: "Old Bundle",
      description: "No metadata",
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => doc,
    });

    const result = await fetchBundleMetadata("bafyold");
    expect(result).toBeNull();
  });

  it("handles partial metadata gracefully", async () => {
    const doc = {
      version: "1.0",
      metadata: {
        bundleType: "dataset",
        // no tags, domain, summary, custom
      },
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => doc,
    });

    const result = await fetchBundleMetadata("bafypartial");

    expect(result).not.toBeNull();
    expect(result!.bundleType).toBe("dataset");
    expect(result!.tags).toEqual([]);
    expect(result!.domain).toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.custom).toBeNull();
  });

  it("filters invalid tags", async () => {
    const doc = {
      version: "1.0",
      metadata: {
        tags: ["valid-tag", "UPPERCASE", "has spaces", "ok-2", 123, null],
      },
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => doc,
    });

    const result = await fetchBundleMetadata("bafytags");

    expect(result!.tags).toEqual(["valid-tag", "ok-2"]);
  });

  it("truncates fields to max length", async () => {
    const doc = {
      version: "1.0",
      metadata: {
        bundleType: "a".repeat(100), // max 64
        domain: "b".repeat(200),     // max 128
        summary: "c".repeat(3000),   // max 2000
      },
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => doc,
    });

    const result = await fetchBundleMetadata("bafylong");

    expect(result!.bundleType!.length).toBe(64);
    expect(result!.domain!.length).toBe(128);
    expect(result!.summary!.length).toBe(2000);
  });

  it("limits to 20 tags", async () => {
    const doc = {
      version: "1.0",
      metadata: {
        tags: Array.from({ length: 30 }, (_, i) => `tag-${i}`),
      },
    };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => doc,
    });

    const result = await fetchBundleMetadata("bafymanytags");

    expect(result!.tags.length).toBe(20);
  });
});
