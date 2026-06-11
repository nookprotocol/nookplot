/**
 * Paper research tools — agent-facing interface to paper-research
 * integrations. Each tool proxies one `/v1/papers/*` gateway endpoint:
 * cached, credit-metered (0.25cr/call, free on cache hit), joined with
 * nookplot's own ingested-paper index.
 *
 * Category: "research". Agents load these via `browse_tools("research")`.
 *
 * @module tools/papers
 */

import type { ToolDef } from "./index.js";

export const papersTools: ToolDef[] = [
  {
    name: "nookplot_search_papers",
    description:
      "Search Semantic Scholar's paper corpus by query. Returns up to 50 papers with abstracts, authors, citation counts, and whether each paper is already ingested in nookplot's knowledge graph.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query (title, abstract, topic)" },
        sortBy: {
          type: "string",
          enum: ["citationCount", "publicationDate"],
          description: "Sort order (default: relevance)",
        },
        minCitations: { type: "number", description: "Minimum citation count filter" },
        dateFrom: { type: "string", description: "Lower bound on publication date (YYYY-MM-DD)" },
        limit: { type: "number", description: "Max results (default 10, max 50)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      const qs = new URLSearchParams({ query: String(args.query) });
      if (args.sortBy) qs.set("sort_by", String(args.sortBy));
      if (args.minCitations) qs.set("min_citations", String(args.minCitations));
      if (args.dateFrom) qs.set("date_from", String(args.dateFrom));
      if (args.limit) qs.set("limit", String(args.limit));
      return ctx.get(`/v1/papers/search?${qs.toString()}`);
    },
  },
  {
    name: "nookplot_get_paper",
    description:
      "Fetch a paper's full metadata (title, abstract, authors, citation count, venue, year, external IDs) by arXiv ID, DOI, or Semantic Scholar ID.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        arxivId: { type: "string", description: "arXiv ID (e.g. '2301.12345')" },
      },
      required: ["arxivId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/papers/${encodeURIComponent(String(args.arxivId))}`),
  },
  {
    name: "nookplot_walk_citations",
    description:
      "Walk the citation graph around a paper. direction='in' lists papers that cite this one; direction='out' lists the papers this one cites. Each edge includes isInfluential + intent context.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        arxivId: { type: "string", description: "arXiv ID of the focal paper" },
        direction: {
          type: "string",
          enum: ["in", "out"],
          description: "'in' = citing this paper, 'out' = cited by this paper",
        },
        limit: { type: "number", description: "Max edges to return (default 25, max 1000)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: ["arxivId"],
    },
    handler: async (args, ctx) => {
      const qs = new URLSearchParams();
      if (args.direction) qs.set("direction", String(args.direction));
      if (args.limit) qs.set("limit", String(args.limit));
      if (args.offset) qs.set("offset", String(args.offset));
      const q = qs.toString();
      return ctx.get(
        `/v1/papers/${encodeURIComponent(String(args.arxivId))}/citations${q ? `?${q}` : ""}`,
      );
    },
  },
  {
    name: "nookplot_recommend_papers",
    description:
      "Get Semantic Scholar's 'for-this-paper' recommendations — sibling papers an agent reading this one is likely to find relevant.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        arxivId: { type: "string", description: "arXiv ID of the focal paper" },
        limit: { type: "number", description: "Max recommendations (default 10, max 100)" },
      },
      required: ["arxivId"],
    },
    handler: async (args, ctx) => {
      const qs = args.limit ? `?limit=${encodeURIComponent(String(args.limit))}` : "";
      return ctx.get(`/v1/papers/${encodeURIComponent(String(args.arxivId))}/recommendations${qs}`);
    },
  },
  {
    name: "nookplot_get_paper_toc",
    description:
      "Fetch the abstract + flat section list for an arXiv paper (from the HTML rendering at arxiv.org/html). Use before reading sections to plan which to pull.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        arxivId: { type: "string", description: "arXiv ID" },
      },
      required: ["arxivId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/papers/${encodeURIComponent(String(args.arxivId))}/sections`),
  },
  {
    name: "nookplot_read_paper_section",
    description:
      "Read the text of a single section of an arXiv paper, by section number (e.g. '3', '3.2', 'A.1'). Output is truncated to 8000 chars. First read pins the section to IPFS for reuse.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        arxivId: { type: "string", description: "arXiv ID" },
        section: { type: "string", description: "Section number as shown in the TOC (e.g. '3', '3.2')" },
      },
      required: ["arxivId", "section"],
    },
    handler: async (args, ctx) =>
      ctx.get(
        `/v1/papers/${encodeURIComponent(String(args.arxivId))}/sections/${encodeURIComponent(String(args.section))}`,
      ),
  },
  {
    name: "nookplot_search_paper_snippets",
    description:
      "Search Semantic Scholar's passage index for snippets matching a query. Returns specific text passages with their owning papers — useful for verifying a specific claim rather than finding a whole paper.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Claim, phrase, or question to match" },
        limit: { type: "number", description: "Max snippets (default 10, max 100)" },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      const qs = new URLSearchParams({ query: String(args.query) });
      if (args.limit) qs.set("limit", String(args.limit));
      return ctx.get(`/v1/papers/snippets?${qs.toString()}`);
    },
  },
  {
    name: "nookplot_paper_resources",
    description:
      "List the Hugging Face datasets, models, and collections linked to an arXiv paper (via the HF Papers API). Use to go from 'paper' to 'the dataset it used' in one hop.",
    category: "research",
    inputSchema: {
      type: "object",
      properties: {
        arxivId: { type: "string", description: "arXiv ID" },
      },
      required: ["arxivId"],
    },
    handler: async (args, ctx) =>
      ctx.get(`/v1/papers/${encodeURIComponent(String(args.arxivId))}/resources`),
  },
];
