import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GrokipediaClient } from "./grokipediaClient.js";

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

function mockFetchHtml(html: string, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: () => Promise.resolve(html),
  });
}

function mockFetchError() {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
}

// ---------------------------------------------------------------------------
//  Feature disabled (no baseUrl)
// ---------------------------------------------------------------------------

describe("GrokipediaClient — disabled", () => {
  it("returns score 0 when baseUrl is empty", async () => {
    const client = new GrokipediaClient("");
    const result = await client.getInfluenceScore("Some Paper Title");
    expect(result).toEqual({ score: 0, found: false });
  });

  it("returns score 0 when baseUrl is undefined", async () => {
    const orig = process.env.GROKIPEDIA_BASE_URL;
    delete process.env.GROKIPEDIA_BASE_URL;

    const client = new GrokipediaClient();
    const result = await client.getInfluenceScore("Some Paper");
    expect(result).toEqual({ score: 0, found: false });

    if (orig) process.env.GROKIPEDIA_BASE_URL = orig;
  });
});

// ---------------------------------------------------------------------------
//  Scoring logic
// ---------------------------------------------------------------------------

describe("GrokipediaClient — scoring", () => {
  it("returns score 20 for dedicated page (h1 match)", async () => {
    const html = `<html><body><h1>Attention Is All You Need</h1><p>Lots of content about transformers...</p></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Attention Is All You Need");

    expect(result).toEqual({ score: 20, found: true });
  });

  it("returns score 15 for prominent section (h2 match + >500 chars)", async () => {
    const longContent = "This is detailed content about the paper. ".repeat(20); // > 500 chars
    const html = `<html><body><h1>Machine Learning Overview</h1><h2>Neural Scaling Laws</h2><p>${longContent}</p><h2>Other Topic</h2></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Neural Scaling Laws");

    expect(result).toEqual({ score: 15, found: true });
  });

  it("returns score 10 for section heading match (short content)", async () => {
    const html = `<html><body><h1>Overview</h1><h3>Neural Scaling Laws</h3><p>Brief mention.</p></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Neural Scaling Laws");

    expect(result).toEqual({ score: 10, found: true });
  });

  it("returns score 5 for body text mention", async () => {
    const html = `<html><body><h1>AI Research</h1><p>Recent work on Neural Scaling Laws has shown interesting results in language models.</p></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Neural Scaling Laws");

    expect(result).toEqual({ score: 5, found: true });
  });

  it("returns score 5 for author name mention", async () => {
    const html = `<html><body><h1>AI Research</h1><p>Kaplan et al. published important findings.</p></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Unrelated Title", ["Kaplan"]);

    expect(result).toEqual({ score: 5, found: true });
  });

  it("returns score 0 when nothing matches", async () => {
    const html = `<html><body><h1>Cooking Recipes</h1><p>How to make pasta.</p></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Quantum Computing Paper");

    expect(result).toEqual({ score: 0, found: false });
  });
});

// ---------------------------------------------------------------------------
//  Error handling
// ---------------------------------------------------------------------------

describe("GrokipediaClient — errors", () => {
  it("returns score 0 on HTTP error", async () => {
    mockFetchHtml("", false);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Some Paper");

    expect(result).toEqual({ score: 0, found: false });
  });

  it("returns score 0 on network error", async () => {
    mockFetchError();

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Some Paper");

    expect(result).toEqual({ score: 0, found: false });
  });
});

// ---------------------------------------------------------------------------
//  Caching
// ---------------------------------------------------------------------------

describe("GrokipediaClient — caching", () => {
  it("returns cached result on second call", async () => {
    const html = `<html><body><h1>Test Paper</h1></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");

    const result1 = await client.getInfluenceScore("Test Paper");
    expect(result1.score).toBe(20);
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    // Second call should use cache, not fetch again
    const result2 = await client.getInfluenceScore("Test Paper");
    expect(result2.score).toBe(20);
    expect(globalThis.fetch).toHaveBeenCalledOnce(); // still 1
  });

  it("different queries get different cache entries", async () => {
    const html = `<html><body><h1>Paper A</h1></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");

    await client.getInfluenceScore("Paper A");
    await client.getInfluenceScore("Paper B");

    // Should have fetched twice (different cache keys)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
//  Fuzzy matching
// ---------------------------------------------------------------------------

describe("GrokipediaClient — fuzzy matching", () => {
  it("matches h1 with fuzzy containment (>=80% word match)", async () => {
    // h1 contains most of the words but not exact
    const html = `<html><body><h1>Attention Mechanisms Are All You Need for Language Models</h1></body></html>`;
    mockFetchHtml(html);

    const client = new GrokipediaClient("https://grok.example.com");
    const result = await client.getInfluenceScore("Attention Is All You Need");

    // "Attention", "All", "You", "Need" all appear — 4/4 of words > 2 chars (excluding "Is")
    expect(result.found).toBe(true);
    expect(result.score).toBe(20);
  });
});
