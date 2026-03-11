import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArxivVerifier } from "./arxivVerifier.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

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

function mockFetchXml(xml: string, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: () => Promise.resolve(xml),
  });
}

// Sample arXiv Atom XML response
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  <entry>
    <title>Attention Is All You Need</title>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <author><name>Niki Parmar</name></author>
    <summary>The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.</summary>
    <published>2017-06-12T17:57:34Z</published>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <category term="cs.CL"/>
    <category term="cs.AI"/>
  </entry>
</feed>`;

// ---------------------------------------------------------------------------
//  fetchPaper
// ---------------------------------------------------------------------------

describe("ArxivVerifier.fetchPaper", () => {
  it("parses arXiv Atom XML and returns paper info", async () => {
    mockFetchXml(SAMPLE_XML);

    const verifier = new ArxivVerifier();
    const paper = await verifier.fetchPaper("1706.03762");

    expect(paper).not.toBeNull();
    expect(paper!.id).toBe("1706.03762");
    expect(paper!.title).toBe("Attention Is All You Need");
    expect(paper!.authors).toContain("Ashish Vaswani");
    expect(paper!.authors).toContain("Noam Shazeer");
    expect(paper!.authors.length).toBe(3);
    expect(paper!.published).toBe("2017-06-12T17:57:34Z");
    expect(paper!.categories).toContain("cs.CL");
    expect(paper!.categories).toContain("cs.AI");
  });

  it("strips version suffix from arXiv ID", async () => {
    mockFetchXml(SAMPLE_XML);

    const verifier = new ArxivVerifier();
    await verifier.fetchPaper("1706.03762v7");

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("id_list=1706.03762");
    expect(url).not.toContain("v7");
  });

  it("returns null on HTTP error", async () => {
    mockFetchXml("", false);

    const verifier = new ArxivVerifier();
    const paper = await verifier.fetchPaper("0000.00000");

    expect(paper).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const verifier = new ArxivVerifier();
    const paper = await verifier.fetchPaper("1706.03762");

    expect(paper).toBeNull();
  });

  it("returns null when no authors found", async () => {
    const emptyXml = `<?xml version="1.0"?>
<feed><title>ArXiv Query</title><entry><title>Empty</title><summary>Nothing</summary></entry></feed>`;
    mockFetchXml(emptyXml);

    const verifier = new ArxivVerifier();
    const paper = await verifier.fetchPaper("0000.00000");

    expect(paper).toBeNull();
  });

  it("truncates summary to 500 chars", async () => {
    const longSummary = "A".repeat(1000);
    const xml = `<?xml version="1.0"?>
<feed><title>Q</title><entry><title>Paper</title>
<author><name>Author</name></author>
<summary>${longSummary}</summary></entry></feed>`;
    mockFetchXml(xml);

    const verifier = new ArxivVerifier();
    const paper = await verifier.fetchPaper("1234.56789");

    expect(paper!.summary.length).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  verifyAuthorName
// ---------------------------------------------------------------------------

describe("ArxivVerifier.verifyAuthorName", () => {
  const verifier = new ArxivVerifier();
  const paper = {
    id: "1706.03762",
    title: "Test Paper",
    authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
    summary: "test",
    published: "2017-01-01",
    categories: ["cs.CL"],
  };

  it("matches exact author name (case-insensitive)", () => {
    expect(verifier.verifyAuthorName(paper, "ashish vaswani")).toBe(true);
    expect(verifier.verifyAuthorName(paper, "NOAM SHAZEER")).toBe(true);
  });

  it("matches last name only", () => {
    expect(verifier.verifyAuthorName(paper, "Vaswani")).toBe(true);
    expect(verifier.verifyAuthorName(paper, "Shazeer")).toBe(true);
  });

  it("matches substring", () => {
    expect(verifier.verifyAuthorName(paper, "Parmar")).toBe(true);
  });

  it("rejects non-matching name", () => {
    expect(verifier.verifyAuthorName(paper, "John Doe")).toBe(false);
  });

  it("handles whitespace in claimed name", () => {
    expect(verifier.verifyAuthorName(paper, "  Vaswani  ")).toBe(true);
  });
});
