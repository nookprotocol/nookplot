/**
 * ORCID researcher identity verification.
 *
 * Verifies ownership of an ORCID iD by:
 * 1. Validating the ORCID format (XXXX-XXXX-XXXX-XXXX)
 * 2. Fetching the public profile from the ORCID API
 * 3. Extracting email(s) from the profile
 * 4. Verifying email ownership via EmailVerifier (send code)
 *
 * On successful verification the claim is marked verified with a
 * reputation boost of { quality: 15, breadth: 10 } (active researcher signal).
 *
 * @module services/verifiers/orcidVerifier
 */

import { logSecurityEvent } from "../../middleware/auditLog.js";

// ============================================================
//  Types
// ============================================================

export interface OrcidProfileInfo {
  orcid: string;
  givenName: string | null;
  familyName: string | null;
  creditName: string | null;
  emails: string[];
  works: number;
  lastModified: string | null;
}

export interface OrcidVerifyResult {
  verified: boolean;
  profile?: OrcidProfileInfo;
  error?: string;
}

/** Reputation boost awarded on successful ORCID verification. */
export const ORCID_REPUTATION_BOOST: Record<string, number> = {
  quality: 15,
  breadth: 10,
};

// ============================================================
//  Helpers
// ============================================================

/**
 * ORCID identifiers follow the pattern XXXX-XXXX-XXXX-XXXX
 * where X is a digit (0-9) and the final character may be 'X'
 * (representing a checksum value of 10).
 */
const ORCID_REGEX = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/**
 * Validate that a string is a well-formed ORCID iD.
 */
export function isValidOrcid(value: string): boolean {
  return ORCID_REGEX.test(value);
}

// ============================================================
//  OrcidVerifier
// ============================================================

export class OrcidVerifier {
  /**
   * Fetch the public ORCID profile and return structured info.
   *
   * Uses the public ORCID API v3.0 — no authentication required.
   * Endpoint: https://pub.orcid.org/v3.0/{orcid}/record
   */
  async fetchProfile(orcid: string): Promise<OrcidProfileInfo | null> {
    if (!isValidOrcid(orcid)) {
      logSecurityEvent("warn", "orcid-invalid-format", { orcid });
      return null;
    }

    try {
      const res = await fetch(`https://pub.orcid.org/v3.0/${orcid}/record`, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        logSecurityEvent("warn", "orcid-fetch-error", {
          orcid,
          status: res.status,
        });
        return null;
      }

      const data = (await res.json()) as OrcidRecordResponse;

      // Extract name
      const person = data?.person;
      const namePart = person?.name;
      const givenName = namePart?.["given-names"]?.value ?? null;
      const familyName = namePart?.["family-name"]?.value ?? null;
      const creditName = namePart?.["credit-name"]?.value ?? null;

      // Extract emails (only those marked as public/visible)
      const emails: string[] = [];
      const emailList = person?.emails?.email;
      if (Array.isArray(emailList)) {
        for (const entry of emailList) {
          if (entry.email && typeof entry.email === "string") {
            emails.push(entry.email);
          }
        }
      }

      // Count works (publications/activities)
      const worksSummary = data?.["activities-summary"]?.works?.group;
      const works = Array.isArray(worksSummary) ? worksSummary.length : 0;

      // Last modified
      const lastModified = data?.history?.["last-modified-date"]?.value
        ? new Date(data.history["last-modified-date"].value).toISOString()
        : null;

      return {
        orcid,
        givenName,
        familyName,
        creditName,
        emails,
        works,
        lastModified,
      };
    } catch (err) {
      logSecurityEvent("warn", "orcid-fetch-error", {
        orcid,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Extract verified-email candidates from the ORCID profile.
   *
   * ORCID profiles may have zero emails (if the researcher sets them
   * to private). In that case the caller must ask the agent to supply
   * an email address manually.
   */
  getEmails(profile: OrcidProfileInfo): string[] {
    return profile.emails.filter(
      (e) => typeof e === "string" && e.includes("@"),
    );
  }
}

// ============================================================
//  ORCID API response type stubs (only what we access)
// ============================================================

/** Minimal type definitions for the ORCID v3.0 /record response. */
interface OrcidRecordResponse {
  person?: {
    name?: {
      "given-names"?: { value: string };
      "family-name"?: { value: string };
      "credit-name"?: { value: string };
    };
    emails?: {
      email?: Array<{
        email: string;
        visibility?: string;
      }>;
    };
  };
  "activities-summary"?: {
    works?: {
      group?: unknown[];
    };
  };
  history?: {
    "last-modified-date"?: {
      value: number;
    };
  };
}
