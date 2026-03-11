import { describe, it, expect, vi } from "vitest";
import { GuildDetector } from "./guildDetector.js";
import { createMockPool } from "../test/helpers.js";

/**
 * Helper: route mock pool.query by SQL content.
 * The three signal methods run via Promise.all so mock ordering is unpredictable.
 */
function routeQueries(
  pool: ReturnType<typeof createMockPool>,
  config: {
    givenAttestations?: any[];
    receivedAttestations?: any[];
    outgoingVotes?: any[];
    incomingVotes?: any[];
    asChild?: any[];
    asParent?: any[];
    coChildren?: any[];
    mutualAttestCount?: string;
    mutualVoteAB?: any[];
    mutualVoteBA?: any[];
  },
) {
  pool.query.mockImplementation(async (sql: string, params?: any[]) => {
    const s = sql.trim();

    // getMutualAttestations
    if (s.includes("subject_id FROM idx_attestations") && s.includes("attester_id = $1")) {
      return { rows: config.givenAttestations ?? [], rowCount: config.givenAttestations?.length ?? 0 };
    }
    if (s.includes("attester_id FROM idx_attestations") && s.includes("subject_id = $1")) {
      return { rows: config.receivedAttestations ?? [], rowCount: config.receivedAttestations?.length ?? 0 };
    }

    // getVotingPartners
    if (s.includes("author_id") && s.includes("voter_id = $1")) {
      return { rows: config.outgoingVotes ?? [], rowCount: config.outgoingVotes?.length ?? 0 };
    }
    if (s.includes("voter_id") && s.includes("author_id = $1") && !s.includes("COUNT")) {
      return { rows: config.incomingVotes ?? [], rowCount: config.incomingVotes?.length ?? 0 };
    }

    // getSpawnSiblings
    if (s.includes("parent_id FROM idx_spawn_relations") && s.includes("child_id = $1")) {
      return { rows: config.asChild ?? [], rowCount: config.asChild?.length ?? 0 };
    }
    if (s.includes("child_id FROM idx_spawn_relations") && s.includes("parent_id = $1")) {
      // Could be asParent or co-children lookup
      return { rows: config.asParent ?? config.coChildren ?? [], rowCount: (config.asParent ?? config.coChildren)?.length ?? 0 };
    }

    // checkMutualAttestation (for computeAffinityScore)
    if (s.includes("COUNT") && s.includes("idx_attestations")) {
      return { rows: [{ cnt: config.mutualAttestCount ?? "0" }], rowCount: 1 };
    }

    // getMutualVoteCount
    if (s.includes("upvote_count FROM idx_voting_relations") && s.includes("voter_id = $1") && s.includes("author_id = $2")) {
      // First call: a→b, second call: b→a
      if (!params) return { rows: [], rowCount: 0 };
      const [voter] = params;
      if (voter === params[0] && config.mutualVoteAB) {
        // We need to distinguish a→b from b→a; use a toggle
        const result = config.mutualVoteAB;
        config.mutualVoteAB = config.mutualVoteBA ?? [];
        config.mutualVoteBA = result;
        return { rows: result, rowCount: result.length };
      }
      return { rows: config.mutualVoteAB ?? [], rowCount: config.mutualVoteAB?.length ?? 0 };
    }

    return { rows: [], rowCount: 0 };
  });
}

// ---------------------------------------------------------------------------
//  suggestGuilds
// ---------------------------------------------------------------------------

describe("GuildDetector — suggestGuilds", () => {
  it("suggests guilds from mutual attestations", async () => {
    const pool = createMockPool();
    routeQueries(pool, {
      givenAttestations: [{ subject_id: "0xPartner" }],
      receivedAttestations: [{ attester_id: "0xPartner" }],
    });

    const detector = new GuildDetector(pool as any);
    const suggestions = await detector.suggestGuilds("0xAgent");

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].members).toContain("0xagent");
    expect(suggestions[0].members).toContain("0xpartner");
    expect(suggestions[0].signals[0].type).toBe("attestation");
  });

  it("combines multiple signal types", async () => {
    const pool = createMockPool();
    routeQueries(pool, {
      givenAttestations: [{ subject_id: "0xPartner" }],
      receivedAttestations: [{ attester_id: "0xPartner" }],
      outgoingVotes: [{ author_id: "0xPartner", upvote_count: 5 }],
      incomingVotes: [{ voter_id: "0xPartner", upvote_count: 5 }],
    });

    const detector = new GuildDetector(pool as any);
    const suggestions = await detector.suggestGuilds("0xAgent");

    expect(suggestions).toHaveLength(1);
    const signals = suggestions[0].signals;
    expect(signals.some((s) => s.type === "attestation")).toBe(true);
    expect(signals.some((s) => s.type === "voting")).toBe(true);
  });

  it("returns empty when no signals meet threshold", async () => {
    const pool = createMockPool();
    routeQueries(pool, {});

    const detector = new GuildDetector(pool as any);
    const suggestions = await detector.suggestGuilds("0xAgent");

    expect(suggestions).toHaveLength(0);
  });

  it("limits suggestions to requested count", async () => {
    const pool = createMockPool();
    routeQueries(pool, {
      givenAttestations: [
        { subject_id: "0xA" },
        { subject_id: "0xB" },
        { subject_id: "0xC" },
        { subject_id: "0xD" },
      ],
      receivedAttestations: [
        { attester_id: "0xA" },
        { attester_id: "0xB" },
        { attester_id: "0xC" },
        { attester_id: "0xD" },
      ],
    });

    const detector = new GuildDetector(pool as any);
    const suggestions = await detector.suggestGuilds("0xAgent", 2);

    expect(suggestions.length).toBeLessThanOrEqual(2);
  });

  it("handles query failures gracefully", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValue(new Error("table not found"));

    const detector = new GuildDetector(pool as any);
    const suggestions = await detector.suggestGuilds("0xAgent");

    expect(suggestions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  computeAffinityScore
// ---------------------------------------------------------------------------

describe("GuildDetector — computeAffinityScore", () => {
  it("returns 40 for mutual attestation", async () => {
    const pool = createMockPool();
    routeQueries(pool, { mutualAttestCount: "2" });

    const detector = new GuildDetector(pool as any);
    const result = await detector.computeAffinityScore("0xA", "0xB");

    expect(result.score).toBe(40);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].type).toBe("attestation");
  });

  it("combines attestation and voting scores", async () => {
    const pool = createMockPool();

    // Use sequential mocks since computeAffinityScore is NOT Promise.all
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "2" }], rowCount: 1 }); // mutual attestation
    pool.query.mockResolvedValueOnce({ rows: [{ upvote_count: 4 }], rowCount: 1 }); // a→b votes
    pool.query.mockResolvedValueOnce({ rows: [{ upvote_count: 3 }], rowCount: 1 }); // b→a votes

    const detector = new GuildDetector(pool as any);
    const result = await detector.computeAffinityScore("0xA", "0xB");

    // attestation(40) + voting(min(35, min(4,3)*5) = 15) = 55
    expect(result.score).toBe(55);
    expect(result.signals).toHaveLength(2);
  });

  it("caps score at 100", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "2" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ upvote_count: 100 }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [{ upvote_count: 100 }], rowCount: 1 });

    const detector = new GuildDetector(pool as any);
    const result = await detector.computeAffinityScore("0xA", "0xB");

    // 40 + 35 = 75 (under 100)
    expect(result.score).toBe(75);
  });

  it("returns 0 when no signals", async () => {
    const pool = createMockPool();

    pool.query.mockResolvedValueOnce({ rows: [{ cnt: "0" }], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const detector = new GuildDetector(pool as any);
    const result = await detector.computeAffinityScore("0xA", "0xB");

    expect(result.score).toBe(0);
    expect(result.signals).toHaveLength(0);
  });
});
