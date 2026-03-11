import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../../test/helpers.js";

vi.mock("../../middleware/auditLog.js", () => ({
  logSecurityEvent: vi.fn(),
}));

const { ResearchHubBountyService } = await import("../researchHubBountyService.js");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function createService(pool?: ReturnType<typeof createMockPool>) {
  const p = pool ?? createMockPool();
  const service = new ResearchHubBountyService(p as any);
  return { service, pool: p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
//  claimBounty
// ---------------------------------------------------------------------------

describe("ResearchHubBountyService.claimBounty", () => {
  it("inserts a claim record when bounty exists and is open", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    // Mock fetchRhBounties to return a cached bounty
    (service as any).bountyCache = {
      data: [
        {
          id: 42,
          amount: 500,
          bountyType: "review",
          status: "OPEN",
          paperId: 100,
          paperTitle: "Test Paper",
          createdDate: "2025-01-01",
          expirationDate: null,
          description: "Review this paper",
        },
      ],
      fetchedAt: Date.now(),
    };

    // Duplicate check — no existing claims
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    // Insert claim
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "claim-1",
        rh_bounty_id: 42,
        rh_paper_id: 100,
        agent_id: "agent-1",
        bundle_id: "bundle-abc",
        claim_status: "submitted",
        rh_bounty_amount: 500,
        rh_bounty_type: "review",
        submitted_at: "2025-03-10",
        resolved_at: null,
        created_at: "2025-03-10",
      }],
      rowCount: 1,
    });

    const claim = await service.claimBounty("agent-1", 42, "bundle-abc");

    expect(claim.id).toBe("claim-1");
    expect(claim.rhBountyId).toBe(42);
    expect(claim.claimStatus).toBe("submitted");
    expect(claim.rhBountyAmount).toBe(500);
  });

  it("throws RH_BOUNTY_NOT_FOUND for unknown bounty", async () => {
    const { service } = createService();

    // Empty cache
    (service as any).bountyCache = { data: [], fetchedAt: Date.now() };

    await expect(service.claimBounty("agent-1", 999)).rejects.toThrow("RH_BOUNTY_NOT_FOUND");
  });

  it("throws RH_BOUNTY_ALREADY_CLAIMED for duplicate", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    (service as any).bountyCache = {
      data: [{ id: 42, amount: 100, bountyType: "review", status: "OPEN", paperId: null, paperTitle: null, createdDate: null, expirationDate: null, description: null }],
      fetchedAt: Date.now(),
    };

    // Duplicate check — existing claim found
    pool.query.mockResolvedValueOnce({ rows: [{ id: "existing-claim" }], rowCount: 1 });

    await expect(service.claimBounty("agent-1", 42)).rejects.toThrow("RH_BOUNTY_ALREADY_CLAIMED");
  });
});

// ---------------------------------------------------------------------------
//  submitBundle
// ---------------------------------------------------------------------------

describe("ResearchHubBountyService.submitBundle", () => {
  it("updates claim with bundle and sets status to submitted", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "claim-1",
        rh_bounty_id: 42,
        rh_paper_id: null,
        agent_id: "agent-1",
        bundle_id: "bundle-xyz",
        claim_status: "submitted",
        rh_bounty_amount: 200,
        rh_bounty_type: "answer",
        submitted_at: "2025-03-10",
        resolved_at: null,
        created_at: "2025-03-09",
      }],
      rowCount: 1,
    });

    const claim = await service.submitBundle("claim-1", "agent-1", "bundle-xyz");

    expect(claim.bundleId).toBe("bundle-xyz");
    expect(claim.claimStatus).toBe("submitted");
  });

  it("throws for non-existent or non-pending claim", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(service.submitBundle("bad-id", "agent-1", "bundle"))
      .rejects.toThrow("CLAIM_NOT_FOUND_OR_NOT_PENDING");
  });
});

// ---------------------------------------------------------------------------
//  getClaimStatus
// ---------------------------------------------------------------------------

describe("ResearchHubBountyService.getClaimStatus", () => {
  it("returns claim by ID", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: "claim-1",
        rh_bounty_id: 10,
        rh_paper_id: 20,
        agent_id: "agent-1",
        bundle_id: null,
        claim_status: "pending",
        rh_bounty_amount: 100,
        rh_bounty_type: "summary",
        submitted_at: null,
        resolved_at: null,
        created_at: "2025-03-01",
      }],
      rowCount: 1,
    });

    const claim = await service.getClaimStatus("claim-1");
    expect(claim).not.toBeNull();
    expect(claim!.claimStatus).toBe("pending");
  });

  it("returns null for unknown claim", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const claim = await service.getClaimStatus("nonexistent");
    expect(claim).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  listAgentClaims
// ---------------------------------------------------------------------------

describe("ResearchHubBountyService.listAgentClaims", () => {
  it("returns claims for an agent", async () => {
    const pool = createMockPool();
    const { service } = createService(pool);

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: "c1", rh_bounty_id: 1, rh_paper_id: null, agent_id: "agent-1", bundle_id: null, claim_status: "pending", rh_bounty_amount: 50, rh_bounty_type: "review", submitted_at: null, resolved_at: null, created_at: "2025-03-01" },
        { id: "c2", rh_bounty_id: 2, rh_paper_id: null, agent_id: "agent-1", bundle_id: "b1", claim_status: "submitted", rh_bounty_amount: 100, rh_bounty_type: "answer", submitted_at: "2025-03-05", resolved_at: null, created_at: "2025-03-02" },
      ],
      rowCount: 2,
    });

    const claims = await service.listAgentClaims("agent-1");
    expect(claims).toHaveLength(2);
    expect(claims[0].id).toBe("c1");
    expect(claims[1].claimStatus).toBe("submitted");
  });
});
