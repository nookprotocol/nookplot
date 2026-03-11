import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpportunityScanner } from "./opportunityScanner.js";
import type { AgentContext, Opportunity } from "./opportunityScanner.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agt_1",
    address: "0xAgent1",
    purpose: {
      mission: "Build AI tools",
      domains: ["artificial-intelligence", "machine-learning"],
      goals: ["Create open-source ML models"],
    },
    autonomy: { level: "semi-autonomous", boundaries: [] },
    ...overrides,
  } as any;
}

/** Create SQL-matching mock for scanBounties that handles all queries. */
function mockBountyQueries(pool: ReturnType<typeof createMockPool>, bountyRows: Record<string, unknown>[]) {
  pool.query.mockImplementation((sql: string) => {
    // Expertise tags lookup (new: skill-based matching)
    if (sql.includes("expertise_tags") && sql.includes("LOWER(tag)")) {
      return Promise.resolve({ rows: [] });
    }
    // Schema check for token_address column
    if (sql.includes("information_schema.columns") && sql.includes("token_address")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    // Main bounty query
    if (sql.includes("idx_bounties") && sql.includes("status")) {
      return Promise.resolve({ rows: bountyRows, rowCount: bountyRows.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

// ---------------------------------------------------------------------------
//  scanBounties
// ---------------------------------------------------------------------------

describe("OpportunityScanner — scanBounties", () => {
  it("returns bounties matching agent domains", async () => {
    const pool = createMockPool();
    mockBountyQueries(pool, [{
      id: "1",
      metadata_cid: "bafybounty",
      reward_amount: "1000000000000000",
      deadline: "0",
      creator: "0xOther",
      community: "artificial-intelligence",
      tags: null,
    }]);

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanBounties(makeContext());

    expect(opps).toHaveLength(1);
    expect(opps[0].type).toBe("bounty");
    expect(opps[0].sourceId).toBe("bounty-1");
  });

  it("skips expired bounties", async () => {
    const pool = createMockPool();
    mockBountyQueries(pool, [{
      id: "1",
      metadata_cid: "bafybounty",
      reward_amount: "1000000000000000",
      deadline: "1000", // expired (past timestamp)
      creator: "0xOther",
      community: "artificial-intelligence",
      tags: null,
    }]);

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanBounties(makeContext());

    expect(opps).toHaveLength(0);
  });

  it("skips bounties created by the agent", async () => {
    const pool = createMockPool();
    mockBountyQueries(pool, [{
      id: "1",
      metadata_cid: "bafybounty",
      reward_amount: "1000000000000000",
      deadline: "0",
      creator: "0xagent1", // same as context.address (case insensitive)
      community: "artificial-intelligence",
      tags: null,
    }]);

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanBounties(makeContext());

    expect(opps).toHaveLength(0);
  });

  it("skips bounties from unrelated domains", async () => {
    const pool = createMockPool();
    mockBountyQueries(pool, [{
      id: "1",
      metadata_cid: "bafybounty",
      reward_amount: "1000000000000000",
      deadline: "0",
      creator: "0xOther",
      community: "cooking-recipes",
      tags: null,
    }]);

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanBounties(makeContext());

    expect(opps).toHaveLength(0);
  });

  it("includes all bounties for agents with no domains", async () => {
    const pool = createMockPool();
    mockBountyQueries(pool, [{
      id: "1",
      metadata_cid: "bafybounty",
      reward_amount: "1000000000000000",
      deadline: "0",
      creator: "0xOther",
      community: "cooking-recipes",
      tags: null,
    }]);

    const context = makeContext({
      purpose: { mission: "General assistant", domains: [], goals: [] },
    });
    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanBounties(context);

    expect(opps).toHaveLength(1);
  });

  it("returns empty on query failure", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValue(new Error("table missing"));

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanBounties(makeContext());

    expect(opps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  scanCommunityFeeds
// ---------------------------------------------------------------------------

describe("OpportunityScanner — scanCommunityFeeds", () => {
  it("returns unanswered posts in matching domains", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        cid: "bafypost1",
        author_id: "0xAuthor",
        community_id: "machine-learning",
        comment_count: 0,
        upvotes: 5,
      }],
      rowCount: 1,
    });

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanCommunityFeeds(makeContext());

    expect(opps).toHaveLength(1);
    expect(opps[0].type).toBe("post_reply");
    expect(opps[0].estimatedValue).toBe(100 + 5 * 50); // 350
  });

  it("skips own posts", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        cid: "bafypost1",
        author_id: "0xagent1", // case-insensitive match
        community_id: "machine-learning",
        comment_count: 0,
        upvotes: 5,
      }],
      rowCount: 1,
    });

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanCommunityFeeds(makeContext());

    expect(opps).toHaveLength(0);
  });

  it("returns empty on query failure", async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanCommunityFeeds(makeContext());

    expect(opps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  scanProjectDiscussions
// ---------------------------------------------------------------------------

describe("OpportunityScanner — scanProjectDiscussions", () => {
  it("returns channels with unread messages", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        channel_id: "ch_1",
        project_id: "proj_1",
        channel_name: "dev-chat",
        unread_count: 3,
      }],
      rowCount: 1,
    });

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanProjectDiscussions(makeContext());

    expect(opps).toHaveLength(1);
    expect(opps[0].type).toBe("project_discussion");
    expect(opps[0].estimatedValue).toBe(50 + 3 * 20); // 110
  });

  it("skips channels with zero unread", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        channel_id: "ch_1",
        project_id: "proj_1",
        channel_name: "dev-chat",
        unread_count: 0,
      }],
      rowCount: 1,
    });

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanProjectDiscussions(makeContext());

    expect(opps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  scanServiceListings
// ---------------------------------------------------------------------------

describe("OpportunityScanner — scanServiceListings", () => {
  it("returns service listings matching agent domains", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        listing_id: 1,
        provider_address: "0xProvider",
        category: "machine-learning",
        pricing_model: "per-task",
        price_amount: "500000000000000",
        metadata_cid: "bafysvc",
        total_completed: 10,
      }],
      rowCount: 1,
    });

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanServiceListings(makeContext());

    expect(opps).toHaveLength(1);
    expect(opps[0].type).toBe("service");
  });

  it("skips listings from unrelated categories", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [{
        listing_id: 1,
        provider_address: "0xProvider",
        category: "culinary-arts",
        pricing_model: "per-task",
        price_amount: "500000000000000",
        metadata_cid: "bafysvc",
        total_completed: 5,
      }],
      rowCount: 1,
    });

    const scanner = new OpportunityScanner(pool as any);
    const opps = await scanner.scanServiceListings(makeContext());

    expect(opps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
//  scanAll — discovery affordances (scanner priorities + entity focus)
// ---------------------------------------------------------------------------

describe("OpportunityScanner — scanAll discovery affordances", () => {
  let scanner: OpportunityScanner;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    scanner = new OpportunityScanner(pool as any);
  });

  it("skips scanners with priority weight 0", async () => {
    const context: AgentContext = {
      ...makeContext(),
      scannerPriorities: { scanBounties: 0 },
    };

    const bountieSpy = vi.spyOn(scanner, "scanBounties");
    await scanner.scanAll(context);
    expect(bountieSpy).not.toHaveBeenCalled();
  });

  it("applies weight multiplier to estimatedValue", async () => {
    const context: AgentContext = {
      ...makeContext(),
      scannerPriorities: { scanBounties: 10 },
    };

    const mockOpp: Opportunity = {
      type: "bounty",
      sourceId: "bounty_weighted",
      title: "Weighted Bounty",
      description: "Test",
      estimatedValue: 100,
      metadata: {},
    };
    vi.spyOn(scanner, "scanBounties").mockResolvedValue([mockOpp]);

    const results = await scanner.scanAll(context);
    const bountyResult = results.find((o) => o.sourceId === "bounty_weighted");
    expect(bountyResult).toBeDefined();
    expect(bountyResult!.estimatedValue).toBe(200); // 100 * (10/5) = 200
  });

  it("deprioritizes with low weight multiplier", async () => {
    const context: AgentContext = {
      ...makeContext(),
      scannerPriorities: { scanBounties: 1 },
    };

    const mockOpp: Opportunity = {
      type: "bounty",
      sourceId: "bounty_low",
      title: "Low Bounty",
      description: "Test",
      estimatedValue: 100,
      metadata: {},
    };
    vi.spyOn(scanner, "scanBounties").mockResolvedValue([mockOpp]);

    const results = await scanner.scanAll(context);
    const bountyResult = results.find((o) => o.sourceId === "bounty_low");
    expect(bountyResult).toBeDefined();
    expect(bountyResult!.estimatedValue).toBe(20); // 100 * (1/5) = 20
  });

  it("filters scanners by entityFocus", async () => {
    const context: AgentContext = {
      ...makeContext(),
      entityFocus: ["bounties"],
    };

    const communityFeedsSpy = vi.spyOn(scanner, "scanCommunityFeeds");
    const projectDiscoverySpy = vi.spyOn(scanner, "scanProjectDiscovery");
    const bountySpy = vi.spyOn(scanner, "scanBounties");

    await scanner.scanAll(context);

    expect(communityFeedsSpy).not.toHaveBeenCalled();
    expect(projectDiscoverySpy).not.toHaveBeenCalled();
    expect(bountySpy).toHaveBeenCalled();
  });

  it("handles Promise.allSettled rejections gracefully", async () => {
    const context = makeContext();
    vi.spyOn(scanner, "scanBounties").mockRejectedValue(new Error("DB down"));

    const results = await scanner.scanAll(context);
    expect(Array.isArray(results)).toBe(true);
  });
});
