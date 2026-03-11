import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OrcidVerifier, isValidOrcid } from "./orcidVerifier.js";

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

function mockFetchJson(data: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  });
}

// ---------------------------------------------------------------------------
//  isValidOrcid
// ---------------------------------------------------------------------------

describe("isValidOrcid", () => {
  it("accepts valid ORCID format", () => {
    expect(isValidOrcid("0000-0002-1825-0097")).toBe(true);
    expect(isValidOrcid("0000-0001-2345-6789")).toBe(true);
  });

  it("accepts ORCID with X checksum digit", () => {
    expect(isValidOrcid("0000-0002-1825-009X")).toBe(true);
  });

  it("rejects too short", () => {
    expect(isValidOrcid("0000-0002-1825")).toBe(false);
  });

  it("rejects missing hyphens", () => {
    expect(isValidOrcid("0000000218250097")).toBe(false);
  });

  it("rejects letters (except final X)", () => {
    expect(isValidOrcid("ABCD-0002-1825-0097")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidOrcid("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  fetchProfile
// ---------------------------------------------------------------------------

describe("OrcidVerifier.fetchProfile", () => {
  it("parses ORCID JSON response into profile", async () => {
    const orcidResponse = {
      person: {
        name: {
          "given-names": { value: "Jane" },
          "family-name": { value: "Doe" },
          "credit-name": { value: "J. Doe" },
        },
        emails: {
          email: [
            { email: "jane@example.com", visibility: "PUBLIC" },
            { email: "jane@example.org", visibility: "PUBLIC" },
          ],
        },
      },
      "activities-summary": {
        works: {
          group: [{ "work-summary": [] }, { "work-summary": [] }, { "work-summary": [] }],
        },
      },
      history: {
        "last-modified-date": { value: 1700000000000 },
      },
    };
    mockFetchJson(orcidResponse);

    const verifier = new OrcidVerifier();
    const profile = await verifier.fetchProfile("0000-0002-1825-0097");

    expect(profile).not.toBeNull();
    expect(profile!.orcid).toBe("0000-0002-1825-0097");
    expect(profile!.givenName).toBe("Jane");
    expect(profile!.familyName).toBe("Doe");
    expect(profile!.creditName).toBe("J. Doe");
    expect(profile!.emails).toHaveLength(2);
    expect(profile!.emails).toContain("jane@example.com");
    expect(profile!.works).toBe(3);
    expect(profile!.lastModified).toBeTruthy();
  });

  it("returns null for invalid ORCID format", async () => {
    const verifier = new OrcidVerifier();
    const profile = await verifier.fetchProfile("invalid-orcid");

    expect(profile).toBeNull();
    // Should not have called fetch
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("returns null on HTTP error", async () => {
    mockFetchJson({}, false);

    const verifier = new OrcidVerifier();
    const profile = await verifier.fetchProfile("0000-0002-1825-0097");

    expect(profile).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const verifier = new OrcidVerifier();
    const profile = await verifier.fetchProfile("0000-0002-1825-0097");

    expect(profile).toBeNull();
  });

  it("handles profile with no emails", async () => {
    mockFetchJson({
      person: {
        name: {
          "given-names": { value: "John" },
          "family-name": { value: "Smith" },
        },
        emails: { email: [] },
      },
      "activities-summary": { works: { group: [] } },
    });

    const verifier = new OrcidVerifier();
    const profile = await verifier.fetchProfile("0000-0001-2345-6789");

    expect(profile).not.toBeNull();
    expect(profile!.emails).toHaveLength(0);
    expect(profile!.works).toBe(0);
  });

  it("handles profile with no name", async () => {
    mockFetchJson({
      person: {
        emails: { email: [] },
      },
    });

    const verifier = new OrcidVerifier();
    const profile = await verifier.fetchProfile("0000-0001-2345-6789");

    expect(profile).not.toBeNull();
    expect(profile!.givenName).toBeNull();
    expect(profile!.familyName).toBeNull();
    expect(profile!.creditName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  getEmails
// ---------------------------------------------------------------------------

describe("OrcidVerifier.getEmails", () => {
  const verifier = new OrcidVerifier();

  it("returns valid email addresses", () => {
    const profile = {
      orcid: "0000-0001-2345-6789",
      givenName: "Jane",
      familyName: "Doe",
      creditName: null,
      emails: ["jane@example.com", "jane@example.org"],
      works: 5,
      lastModified: null,
    };

    const emails = verifier.getEmails(profile);
    expect(emails).toEqual(["jane@example.com", "jane@example.org"]);
  });

  it("filters out invalid emails", () => {
    const profile = {
      orcid: "0000-0001-2345-6789",
      givenName: null,
      familyName: null,
      creditName: null,
      emails: ["valid@email.com", "not-an-email", ""],
      works: 0,
      lastModified: null,
    };

    const emails = verifier.getEmails(profile);
    expect(emails).toEqual(["valid@email.com"]);
  });

  it("returns empty array when no emails", () => {
    const profile = {
      orcid: "0000-0001-2345-6789",
      givenName: null,
      familyName: null,
      creditName: null,
      emails: [],
      works: 0,
      lastModified: null,
    };

    const emails = verifier.getEmails(profile);
    expect(emails).toEqual([]);
  });
});
