import { describe, it, expect, vi } from "vitest";
import { ExternalClaimService } from "./externalClaimService.js";
import { createMockPool } from "../test/helpers.js";

vi.mock("../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const NOW = new Date("2025-06-01T00:00:00Z");

function makeClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: "claim_1",
    agent_id: "agt_1",
    platform: "github",
    external_id: "octocat",
    claim_type: "identity",
    status: "pending",
    verification_method: null,
    verification_data: {},
    reputation_boost: {},
    created_at: NOW,
    verified_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
//  submitClaim
// ---------------------------------------------------------------------------

describe("ExternalClaimService — submitClaim", () => {
  it("inserts a new claim", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [makeClaim()], rowCount: 1 });

    const svc = new ExternalClaimService(pool as any);
    const claim = await svc.submitClaim("agt_1", "github", "octocat", "identity");

    expect(claim.id).toBe("claim_1");
    expect(claim.platform).toBe("github");
    expect(claim.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
//  getClaimsForAgent / getClaim
// ---------------------------------------------------------------------------

describe("ExternalClaimService — queries", () => {
  it("returns claims for agent", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [makeClaim(), makeClaim({ id: "claim_2", platform: "twitter" })],
      rowCount: 2,
    });

    const svc = new ExternalClaimService(pool as any);
    const claims = await svc.getClaimsForAgent("agt_1");

    expect(claims).toHaveLength(2);
  });

  it("returns null when claim not found", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ExternalClaimService(pool as any);
    const claim = await svc.getClaim("nonexistent");

    expect(claim).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  markVerified / rejectClaim
// ---------------------------------------------------------------------------

describe("ExternalClaimService — verification", () => {
  it("marks claim as verified", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [makeClaim({ status: "verified", verified_at: NOW })],
      rowCount: 1,
    });

    const svc = new ExternalClaimService(pool as any);
    const claim = await svc.markVerified("claim_1", "oauth", { token: "abc" }, { activity: 10 });

    expect(claim).not.toBeNull();
    expect(claim!.status).toBe("verified");
  });

  it("returns null when claim not pending", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ExternalClaimService(pool as any);
    const claim = await svc.markVerified("claim_1", "oauth", {}, {});

    expect(claim).toBeNull();
  });

  it("rejects a pending claim", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = new ExternalClaimService(pool as any);
    const rejected = await svc.rejectClaim("claim_1", "Invalid evidence");

    expect(rejected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  sweepUnclaimedCredits
// ---------------------------------------------------------------------------

describe("ExternalClaimService — sweepUnclaimedCredits", () => {
  it("sweeps unclaimed credits and awards bonus", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 3 }); // 3 credits swept

    const mockCreditManager = { addCredits: vi.fn().mockResolvedValue(undefined) };
    const svc = new ExternalClaimService(pool as any, mockCreditManager as any);
    const swept = await svc.sweepUnclaimedCredits("agt_1", "github", "octocat");

    expect(swept).toBe(3);
    // 3 swept * 50 = 150 credits
    expect(mockCreditManager.addCredits).toHaveBeenCalledWith(
      "agt_1", 150, "claim-sweep-github-octocat", "claim_sweep",
    );
  });

  it("returns 0 when nothing to sweep", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const svc = new ExternalClaimService(pool as any);
    const swept = await svc.sweepUnclaimedCredits("agt_1", "github", "octocat");

    expect(swept).toBe(0);
  });

  it("handles credit manager failure gracefully", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const mockCreditManager = { addCredits: vi.fn().mockRejectedValue(new Error("DB error")) };
    const svc = new ExternalClaimService(pool as any, mockCreditManager as any);
    const swept = await svc.sweepUnclaimedCredits("agt_1", "github", "octocat");

    expect(swept).toBe(2); // Still returns count even if credit award fails
  });
});

// ---------------------------------------------------------------------------
//  computeReputationBoosts
// ---------------------------------------------------------------------------

describe("ExternalClaimService — computeReputationBoosts", () => {
  it("aggregates stored reputation boosts", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reputation_boost: { activity: 10, quality: 5 }, platform: "github", verification_data: {} },
        { reputation_boost: { quality: 15, influence: 10 }, platform: "arxiv", verification_data: {} },
      ],
      rowCount: 2,
    });

    const svc = new ExternalClaimService(pool as any);
    const boosts = await svc.computeReputationBoosts("agt_1");

    expect(boosts.activity).toBe(10);
    expect(boosts.quality).toBe(20);
    expect(boosts.influence).toBe(10);
    expect(boosts.breadth).toBe(0);
  });

  it("uses platform defaults when no stored boosts", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reputation_boost: null, platform: "github", verification_data: { publicRepos: 20 } },
        { reputation_boost: null, platform: "arxiv", verification_data: {} },
        { reputation_boost: null, platform: "email", verification_data: {} },
      ],
      rowCount: 3,
    });

    const svc = new ExternalClaimService(pool as any);
    const boosts = await svc.computeReputationBoosts("agt_1");

    expect(boosts.activity).toBe(15); // min(15, 20)
    expect(boosts.quality).toBe(20);  // arxiv default
    expect(boosts.breadth).toBe(9);   // github floor(20/5)=4 + email 5
  });

  it("caps all boosts at 30", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({
      rows: [
        { reputation_boost: { activity: 25 }, platform: "github", verification_data: {} },
        { reputation_boost: { activity: 25 }, platform: "twitter", verification_data: {} },
      ],
      rowCount: 2,
    });

    const svc = new ExternalClaimService(pool as any);
    const boosts = await svc.computeReputationBoosts("agt_1");

    expect(boosts.activity).toBe(30); // capped
  });
});

// ---------------------------------------------------------------------------
//  createUnclaimedCredit
// ---------------------------------------------------------------------------

describe("ExternalClaimService — createUnclaimedCredit", () => {
  it("inserts unclaimed credit and returns ID", async () => {
    const pool = createMockPool();
    pool.query.mockResolvedValueOnce({ rows: [{ id: "uc_1" }], rowCount: 1 });

    const svc = new ExternalClaimService(pool as any);
    const id = await svc.createUnclaimedCredit("github", "octocat", "commit", "repo/main", 10);

    expect(id).toBe("uc_1");
  });
});
