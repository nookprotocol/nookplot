import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemanticScholarClient } from "./semanticScholarClient.js";

// ---------------------------------------------------------------------------
//  Global fetch mock
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchSuccess(data: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function mockFetchFailure(status = 500) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "Server Error" }),
  });
}

function mockFetchNetworkError() {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
}

// ---------------------------------------------------------------------------
//  getPaper
// ---------------------------------------------------------------------------

describe("SemanticScholarClient.getPaper", () => {
  it("fetches paper by S2 ID", async () => {
    const paper = { paperId: "abc123", title: "Test Paper", authors: [] };
    mockFetchSuccess(paper);

    const client = new SemanticScholarClient();
    const result = await client.getPaper("abc123");

    expect(result).toEqual(paper);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/paper/abc123");
  });

  it("auto-prefixes arXiv IDs", async () => {
    const paper = { paperId: "s2id", title: "ArXiv Paper", authors: [] };
    mockFetchSuccess(paper);

    const client = new SemanticScholarClient();
    await client.getPaper("2301.12345");

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("ARXIV%3A2301.12345");
  });

  it("auto-prefixes DOI IDs", async () => {
    const paper = { paperId: "s2id", title: "DOI Paper", authors: [] };
    mockFetchSuccess(paper);

    const client = new SemanticScholarClient();
    await client.getPaper("10.1234/foo.bar");

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("DOI%3A10.1234");
  });

  it("passes through already-prefixed IDs", async () => {
    mockFetchSuccess({ paperId: "x", title: "P", authors: [] });

    const client = new SemanticScholarClient();
    await client.getPaper("ARXIV:2301.99999");

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("ARXIV%3A2301.99999");
  });

  it("returns null on HTTP error", async () => {
    mockFetchFailure(404);

    const client = new SemanticScholarClient();
    const result = await client.getPaper("missing");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetchNetworkError();

    const client = new SemanticScholarClient();
    const result = await client.getPaper("abc");
    expect(result).toBeNull();
  });

  it("includes API key header when configured", async () => {
    mockFetchSuccess({ paperId: "x", title: "P", authors: [] });

    const client = new SemanticScholarClient("test-api-key");
    await client.getPaper("abc");

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["x-api-key"]).toBe("test-api-key");
  });

  it("omits API key header when not configured", async () => {
    mockFetchSuccess({ paperId: "x", title: "P", authors: [] });

    // Ensure env var is not set
    const orig = process.env.SEMANTIC_SCHOLAR_API_KEY;
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;

    const client = new SemanticScholarClient();
    await client.getPaper("abc");

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["x-api-key"]).toBeUndefined();

    if (orig) process.env.SEMANTIC_SCHOLAR_API_KEY = orig;
  });
});

// ---------------------------------------------------------------------------
//  getAuthor
// ---------------------------------------------------------------------------

describe("SemanticScholarClient.getAuthor", () => {
  it("fetches author profile", async () => {
    const author = { authorId: "456", name: "Jane Doe" };
    mockFetchSuccess(author);

    const client = new SemanticScholarClient();
    const result = await client.getAuthor("456");

    expect(result).toEqual(author);
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/author/456");
  });

  it("returns null on error", async () => {
    mockFetchFailure(500);

    const client = new SemanticScholarClient();
    const result = await client.getAuthor("456");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getBulkPapers
// ---------------------------------------------------------------------------

describe("SemanticScholarClient.getBulkPapers", () => {
  it("returns empty array for empty input", async () => {
    const client = new SemanticScholarClient();
    const result = await client.getBulkPapers([]);
    expect(result).toEqual([]);
  });

  it("batch-fetches papers via POST", async () => {
    const papers = [
      { paperId: "a", title: "Paper A", authors: [] },
      { paperId: "b", title: "Paper B", authors: [] },
    ];
    mockFetchSuccess(papers);

    const client = new SemanticScholarClient();
    const result = await client.getBulkPapers(["a", "b"]);

    expect(result).toHaveLength(2);
    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.ids).toEqual(["a", "b"]);
  });

  it("filters out null entries from response", async () => {
    const papers = [
      { paperId: "a", title: "Paper A", authors: [] },
      null,
      { paperId: "c", title: "Paper C", authors: [] },
    ];
    mockFetchSuccess(papers);

    const client = new SemanticScholarClient();
    const result = await client.getBulkPapers(["a", "b", "c"]);

    expect(result).toHaveLength(2);
    expect(result[0].paperId).toBe("a");
    expect(result[1].paperId).toBe("c");
  });

  it("truncates to 500 IDs max", async () => {
    mockFetchSuccess([]);

    const client = new SemanticScholarClient();
    const ids = Array.from({ length: 600 }, (_, i) => `id_${i}`);
    await client.getBulkPapers(ids);

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    expect(body.ids).toHaveLength(500);
  });

  it("returns empty array on HTTP error", async () => {
    mockFetchFailure(500);

    const client = new SemanticScholarClient();
    const result = await client.getBulkPapers(["a", "b"]);
    expect(result).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    mockFetchNetworkError();

    const client = new SemanticScholarClient();
    const result = await client.getBulkPapers(["a"]);
    expect(result).toEqual([]);
  });

  it("resolves arXiv and DOI IDs in batch", async () => {
    mockFetchSuccess([]);

    const client = new SemanticScholarClient();
    await client.getBulkPapers(["2301.12345", "10.1234/foo", "plainid"]);

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(opts.body as string);
    expect(body.ids[0]).toBe("ARXIV:2301.12345");
    expect(body.ids[1]).toBe("DOI:10.1234/foo");
    expect(body.ids[2]).toBe("plainid");
  });
});

// ---------------------------------------------------------------------------
//  Rate limiting
// ---------------------------------------------------------------------------

describe("SemanticScholarClient rate limiting", () => {
  it("returns null when rate-limited (no API key = 100 token bucket)", async () => {
    // Exhaust the token bucket by making many rapid calls
    const orig = process.env.SEMANTIC_SCHOLAR_API_KEY;
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;

    mockFetchSuccess({ paperId: "x", title: "P", authors: [] });

    const client = new SemanticScholarClient();

    // Make 100 calls to exhaust the bucket
    for (let i = 0; i < 100; i++) {
      await client.getPaper(`paper_${i}`);
    }

    // 101st call should be rate-limited
    const result = await client.getPaper("paper_101");
    expect(result).toBeNull();

    if (orig) process.env.SEMANTIC_SCHOLAR_API_KEY = orig;
  });
});
