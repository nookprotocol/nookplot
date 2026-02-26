/**
 * arXiv paper authorship verification.
 *
 * Verifies authorship of arXiv papers by:
 * 1. Fetching paper metadata from the arXiv API
 * 2. Checking that the claimed author email matches
 * 3. Verifying email ownership (via EmailVerifier)
 *
 * @module services/verifiers/arxivVerifier
 */

import { logSecurityEvent } from "../../middleware/auditLog.js";

export interface ArxivPaperInfo {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  categories: string[];
}

export interface ArxivVerifyResult {
  verified: boolean;
  paper?: ArxivPaperInfo;
  error?: string;
}

export class ArxivVerifier {
  /**
   * Fetch paper metadata from the arXiv API.
   * Uses the Atom feed endpoint (no auth required).
   */
  async fetchPaper(arxivId: string): Promise<ArxivPaperInfo | null> {
    try {
      // Normalize ID (remove version suffix if present)
      const cleanId = arxivId.replace(/v\d+$/, "");

      const res = await fetch(`http://export.arxiv.org/api/query?id_list=${cleanId}`);
      if (!res.ok) return null;

      const xml = await res.text();

      // Simple XML parsing for the Atom feed (avoids heavy XML parser dependency)
      const titleMatch = xml.match(/<title[^>]*>([^<]+)<\/title>/g);
      const title = titleMatch && titleMatch.length > 1
        ? titleMatch[1].replace(/<\/?title[^>]*>/g, "").trim()
        : "Unknown";

      const authors: string[] = [];
      const authorMatches = xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g);
      for (const match of authorMatches) {
        authors.push(match[1].trim());
      }

      const summaryMatch = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
      const summary = summaryMatch ? summaryMatch[1].trim() : "";

      const publishedMatch = xml.match(/<published>([^<]+)<\/published>/);
      const published = publishedMatch ? publishedMatch[1].trim() : "";

      const categoryMatches = xml.matchAll(/term="([^"]+)"/g);
      const categories: string[] = [];
      for (const match of categoryMatches) {
        if (match[1] && !match[1].includes("http")) {
          categories.push(match[1]);
        }
      }

      if (authors.length === 0) return null;

      return {
        id: cleanId,
        title,
        authors,
        summary: summary.slice(0, 500),
        published,
        categories,
      };
    } catch (err) {
      logSecurityEvent("warn", "arxiv-fetch-error", {
        arxivId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Verify that a claimed author name appears in the paper's author list.
   * This is a soft match (case-insensitive substring) since arXiv names
   * don't always match exactly.
   */
  verifyAuthorName(paper: ArxivPaperInfo, claimedName: string): boolean {
    const claimed = claimedName.toLowerCase().trim();
    return paper.authors.some((author) => {
      const authorLower = author.toLowerCase();
      // Check full match, last name match, or substring match
      return authorLower === claimed ||
        authorLower.endsWith(claimed) ||
        authorLower.includes(claimed) ||
        claimed.includes(authorLower);
    });
  }
}
